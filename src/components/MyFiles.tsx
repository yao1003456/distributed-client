import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

interface MyFilesProps {
    signer: ethers.JsonRpcSigner | null;
    address: string;
    setStatus: (s: string) => void;
    refreshTrigger?: number;
}

interface MyFile {
    cid: string;
    pendingRequests: string[];
    approvedUsers: string[];
}

export const MyFiles: React.FC<MyFilesProps> = ({
    signer,
    address,
    setStatus,
    refreshTrigger = 0
}) => {
    const [myFiles, setMyFiles] = useState<MyFile[]>([]);
    const [loading, setLoading] = useState<boolean>(false);

    const fetchMyFiles = useCallback(async () => {
        if (!signer || !address) return;
        setLoading(true);
        console.log("[CLIENT] Fetching my files (Optimized)...");

        try {
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

            // 1. Get my files (fileUploaded where owner == address)
            // event fileUploaded(bytes32 indexed hash, string cid, address indexed owner);
            // Optimization: Use a deployment block to limit scan range
            const fromBlock = import.meta.env.VITE_DEPLOY_BLOCK ? parseInt(import.meta.env.VITE_DEPLOY_BLOCK) : 0;
            const uploadFilter = contract.filters.fileUploaded(null, null, address);
            const uploadEvents = await contract.queryFilter(uploadFilter, fromBlock);

            // 2. Get all access events relevant to me (where owner == address)
            const reqFilter = contract.filters.accessRequested(null, null, address, null);
            const grantFilter = contract.filters.accessGranted(null, null, address, null);
            const denyFilter = contract.filters.accessDenied(null, null, address, null);
            const revokeFilter = contract.filters.accessRevoked(null, null, address, null);

            const [reqEvents, grantEvents, denyEvents, revokeEvents] = await Promise.all([
                contract.queryFilter(reqFilter, fromBlock),
                contract.queryFilter(grantFilter, fromBlock),
                contract.queryFilter(denyFilter, fromBlock),
                contract.queryFilter(revokeFilter, fromBlock)
            ]);

            // 3. Reconstruct state in-memory
            interface FileState {
                pending: Set<string>;
                approved: Set<string>;
            }
            const fileStates = new Map<string, FileState>();

            // Helper to ensure file state exists
            const getFileState = (cid: string) => {
                let state = fileStates.get(cid);
                if (!state) {
                    state = { pending: new Set(), approved: new Set() };
                    fileStates.set(cid, state);
                }
                return state;
            };

            // Process Requested: Add to pending
            reqEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const requester = e.args[3];
                    const state = getFileState(cid);
                    state.pending.add(requester);
                }
            });

            // Process Granted: Remove from pending, Add to approved
            grantEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const requester = e.args[3];
                    const state = getFileState(cid);
                    state.pending.delete(requester);
                    state.approved.add(requester);
                }
            });

            // Process Denied: Remove from pending
            denyEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const requester = e.args[3];
                    const state = getFileState(cid);
                    state.pending.delete(requester);
                }
            });

            // Process Revoked: Remove from approved
            revokeEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const user = e.args[3]; // 'user' is 4th arg
                    const state = getFileState(cid);
                    state.approved.delete(user);
                }
            });

            const files: MyFile[] = [];
            // Only convert files that I actually uploaded
            for (const event of uploadEvents) {
                if ('args' in event) {
                    const cid = event.args[1];
                    // We rely on the event-based state, but handle case where no interactions happened yet
                    const state = fileStates.get(cid) || { pending: new Set(), approved: new Set() };

                    files.push({
                        cid: cid,
                        pendingRequests: Array.from(state.pending),
                        approvedUsers: Array.from(state.approved)
                    });
                }
            }

            console.log(`[CLIENT] Found ${files.length} files owned by me.`);
            setMyFiles(files);
        } catch (error) {
            console.error("Error fetching my files:", error);
            setStatus("Failed to fetch files");
        } finally {
            setLoading(false);
        }
    }, [address, signer, setStatus]);

    useEffect(() => {
        if (address && signer) {
            fetchMyFiles();
        }
    }, [address, signer, refreshTrigger]);

    // Listen for Real-time Events
    useEffect(() => {
        if (!signer || !address) return;

        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

        const onAnyEvent = () => {
            fetchMyFiles();
        };

        const reqFilter = contract.filters.accessRequested(null, null, address, null);
        const grantFilter = contract.filters.accessGranted(null, null, address, null);
        const denyFilter = contract.filters.accessDenied(null, null, address, null);
        const revokeFilter = contract.filters.accessRevoked(null, null, address, null);

        contract.on(reqFilter, onAnyEvent);
        contract.on(grantFilter, onAnyEvent);
        contract.on(denyFilter, onAnyEvent);
        contract.on(revokeFilter, onAnyEvent);

        return () => {
            contract.off(reqFilter, onAnyEvent);
            contract.off(grantFilter, onAnyEvent);
            contract.off(denyFilter, onAnyEvent);
            contract.off(revokeFilter, onAnyEvent);
        };
    }, [signer, address, fetchMyFiles]);


    const handleGrant = async (cid: string, requester: string) => {
        if (!signer) return;
        try {
            setStatus(`Granting access to ${requester}...`);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.grantAccess(cid, requester);
            await tx.wait();
            setStatus("Access Granted!");
            // Fetch will be triggered by event listener
        } catch (error) {
            console.error("Grant error:", error);
            setStatus("Grant failed");
        }
    };

    const handleDeny = async (cid: string, requester: string) => {
        if (!signer) return;
        try {
            setStatus(`Denying access to ${requester}...`);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.denyAccess(cid, requester);
            await tx.wait();
            setStatus("Access Denied!");
            // Fetch will be triggered by event listener
        } catch (error) {
            console.error("Deny error:", error);
            setStatus("Deny failed");
        }
    };

    const handleRevoke = async (cid: string, user: string) => {
        if (!signer) return;
        try {
            setStatus(`Revoking access from ${user}...`);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.revokeAccess(cid, user);
            await tx.wait();
            setStatus("Access Revoked!");
            // Fetch will be triggered by event listener
        } catch (error) {
            console.error("Revoke error:", error);
            setStatus("Revoke failed");
        }
    };

    if (!address) return null;

    return (
        <div className="flex flex-col gap-md">
            <div className="flex justify-between items-center">
                <h2>My Files & Requests</h2>
                <button onClick={fetchMyFiles} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                    ↻ Refresh
                </button>
            </div>

            {loading && <p className="animate-pulse">Loading files from blockchain...</p>}

            {!loading && myFiles.length === 0 && <p className="text-secondary">No files uploaded yet.</p>}

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                {myFiles.map((file) => (
                    <div key={file.cid} className="card" style={{ padding: 'var(--spacing-md)', marginBottom: 0, backgroundColor: 'var(--color-bg-primary)' }}>
                        <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-sm)', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                            CID: {file.cid}
                        </div>

                        {/* Pending Requests Section */}
                        {file.pendingRequests.length > 0 && (
                            <div className="flex flex-col gap-xs" style={{ marginBottom: 'var(--spacing-md)' }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f59e0b' }}>Pending Requests ({file.pendingRequests.length})</div>
                                {file.pendingRequests.map((req) => (
                                    <div key={req} className="flex flex-col gap-xs p-sm" style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)' }}>
                                        <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
                                            {req}
                                        </span>
                                        <div className="flex gap-xs">
                                            <button
                                                onClick={() => handleGrant(file.cid, req)}
                                                className="btn"
                                                style={{ fontSize: '0.75rem', padding: '2px 8px', backgroundColor: 'rgba(34, 197, 94, 0.2)', color: 'var(--color-success)' }}
                                            >
                                                Grant
                                            </button>
                                            <button
                                                onClick={() => handleDeny(file.cid, req)}
                                                className="btn"
                                                style={{ fontSize: '0.75rem', padding: '2px 8px', backgroundColor: 'rgba(239, 68, 68, 0.2)', color: 'var(--color-error)' }}
                                            >
                                                Deny
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Add User Section */}
                        <div style={{ marginBottom: 'var(--spacing-md)' }}>
                            <div className="flex gap-xs">
                                <input
                                    type="text"
                                    className="input"
                                    placeholder="0x..."
                                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                                    id={`input-${file.cid}`}
                                />
                                <button
                                    className="btn btn-secondary"
                                    style={{ padding: '4px 8px' }}
                                    onClick={() => {
                                        const input = document.getElementById(`input-${file.cid}`) as HTMLInputElement;
                                        if (input && input.value) {
                                            handleGrant(file.cid, input.value);
                                            input.value = "";
                                        }
                                    }}
                                >
                                    +
                                </button>
                            </div>
                        </div>

                        {/* Approved Users Section */}
                        {file.approvedUsers.length > 0 && (
                            <div>
                                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-success)', marginBottom: 'var(--spacing-xs)' }}>Approved ({file.approvedUsers.length})</div>
                                <div className="flex flex-wrap gap-xs">
                                    {file.approvedUsers.map((user) => (
                                        <div key={user} className="flex items-center gap-xs" style={{ backgroundColor: 'rgba(34, 197, 94, 0.05)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>
                                            <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                                                {user}
                                            </span>
                                            <button
                                                onClick={() => handleRevoke(file.cid, user)}
                                                style={{ border: 'none', background: 'none', color: 'var(--color-error)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                                                title="Revoke"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {file.pendingRequests.length === 0 && file.approvedUsers.length === 0 && (
                            <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', fontStyle: 'italic' }}>No active shares</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};
