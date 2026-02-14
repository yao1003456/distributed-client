
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
        console.log("[CLIENT] Fetching my files...");

        try {
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

            // 1. Get ALL fileUploaded events to find files owned by me
            const filter = contract.filters.fileUploaded();
            const events = await contract.queryFilter(filter);

            const files: MyFile[] = [];

            for (const event of events) {
                if ('args' in event) {
                    const eventOwner = event.args[2]; // Index 2 is owner
                    const cid = event.args[1]; // Index 1 is cid

                    if (eventOwner.toLowerCase() === address.toLowerCase()) {
                        // This is my file. 

                        // A. Get pending requests (stored on-chain)
                        const pending: string[] = await contract.getPendingRequests(cid);

                        // B. Get approved users (reconstruct from events)
                        // fetch all AccessGranted events and filter client-side
                        const grantFilter = contract.filters.accessGranted();
                        const grantEvents = await contract.queryFilter(grantFilter);

                        const potentialUsers = new Set<string>();
                        grantEvents.forEach(e => {
                            if ('args' in e) {
                                // Event: accessGranted(hash, cid, owner, requester)
                                // We check if the CID matches the file's CID
                                const eCid = e.args[1];
                                const eRequester = e.args[3];

                                if (eCid === cid) {
                                    potentialUsers.add(eRequester);
                                }
                            }
                        });

                        const approved: string[] = [];
                        for (const user of potentialUsers) {
                            const status = await contract.getAccessStatus(cid, user);
                            // AccessStatus: 0=NONE, 1=PENDING, 2=APPROVED, 3=DENIED
                            if (status === 2n || status === 2) {
                                approved.push(user);
                            }
                        }

                        files.push({
                            cid: cid,
                            pendingRequests: pending,
                            approvedUsers: approved
                        });
                    }
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

        const onAccessRequested = (_hash: string, cid: string, owner: string, requester: string) => {
            if (owner.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] New request for my file ${cid} from ${requester}. Refreshing...`);
                fetchMyFiles();
            }
        };

        const onAccessGranted = (_hash: string, cid: string, owner: string, requester: string) => {
            if (owner.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] Access granted for ${cid} to ${requester}. Refreshing...`);
                fetchMyFiles();
            }
        };

        const onAccessRevoked = (_hash: string, cid: string, owner: string, user: string) => {
            if (owner.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] Access revoked for ${cid} from ${user}. Refreshing...`);
                fetchMyFiles();
            }
        };

        const onAccessDenied = (_hash: string, cid: string, owner: string, requester: string) => {
            if (owner.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] Access denied for ${cid} from ${requester}. Refreshing...`);
                fetchMyFiles();
            }
        }

        contract.on("accessRequested", onAccessRequested);
        contract.on("accessGranted", onAccessGranted);
        contract.on("accessRevoked", onAccessRevoked);
        contract.on("accessDenied", onAccessDenied);

        return () => {
            contract.off("accessRequested", onAccessRequested);
            contract.off("accessGranted", onAccessGranted);
            contract.off("accessRevoked", onAccessRevoked);
            contract.off("accessDenied", onAccessDenied);
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

