import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";
const READ_RPC_URL = import.meta.env.VITE_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const EVENT_QUERY_BATCH_SIZE = Math.max(
    100,
    Number(import.meta.env.VITE_EVENT_QUERY_BATCH_SIZE || 2000)
);
const INITIAL_LAST_FETCHED_BLOCK = import.meta.env.VITE_DEPLOY_BLOCK
    ? parseInt(import.meta.env.VITE_DEPLOY_BLOCK, 10) - 1
    : -1;

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

    // State to track incremental sync
    const lastFetchedBlock = React.useRef<number>(INITIAL_LAST_FETCHED_BLOCK);
    // Reconstruct state in-memory (Merging with existing state)
    interface FileState {
        pending: Set<string>;
        approved: Set<string>;
        uploaded: boolean;
    }
    type EventKind = 'upload' | 'requested' | 'granted' | 'denied' | 'revoked';
    interface TimelineEvent {
        kind: EventKind;
        cid: string;
        user?: string;
        blockNumber: number;
        logIndex: number;
    }
    // Keep track of the status map permanently so we can merge updates
    const fileStatesRef = React.useRef<Map<string, FileState>>(new Map());
    const activeAddressRef = React.useRef<string>("");

    // Helper: Fetch events in chunks with retry for public RPC compatibility
    const fetchEventsInChunks = async (
        contract: ethers.Contract,
        filter: ethers.DeferredTopicFilter,
        startBlock: number,
        endBlock: number
    ) => {
        const MAX_RETRIES = 3;
        let events: Array<any> = [];
        for (let i = startBlock; i <= endBlock; i += EVENT_QUERY_BATCH_SIZE) {
            const to = Math.min(i + EVENT_QUERY_BATCH_SIZE - 1, endBlock);
            let attempt = 0;
            while (attempt < MAX_RETRIES) {
                try {
                    const chunk = await contract.queryFilter(filter, i, to);
                    events = events.concat(chunk);
                    break;
                } catch (err) {
                    attempt++;
                    if (attempt >= MAX_RETRIES) {
                        console.error(`Failed fetching chunk ${i}-${to} after ${MAX_RETRIES} retries`, err);
                        throw err;
                    }
                    const delay = 1000 * Math.pow(2, attempt);
                    console.warn(`Retry ${attempt}/${MAX_RETRIES} for chunk ${i}-${to} in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        return events;
    };

    // Concurrency guard
    const isFetching = React.useRef<boolean>(false);

    const fetchMyFiles = useCallback(async () => {
        if (!signer || !address || isFetching.current) return;
        isFetching.current = true;


        // Only show loading spinner on first load
        if (fileStatesRef.current.size === 0) setLoading(true);

        console.log("[CLIENT] Fetching my files (Optimized)...");

        try {
            // Use a dedicated read-only provider to bypass MetaMask RPC limitations
            const readProvider = new ethers.JsonRpcProvider(READ_RPC_URL);

            const currentBlock = await readProvider.getBlockNumber();
            const startBlock = lastFetchedBlock.current + 1;

            // If we are up to date, do nothing
            if (startBlock > currentBlock) {
                setLoading(false);
                return;
            }

            console.log(`[CLIENT] Fetching my files events from ${startBlock} to ${currentBlock}...`);

            const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, readProvider);

            // 1. Get my files (fileUploaded where owner == address)
            // event fileUploaded(bytes32 indexed hash, string cid, address indexed owner);
            const uploadFilter = readContract.filters.fileUploaded(null, null, address);

            // 2. Get all access events relevant to me (where owner == address)
            const reqFilter = readContract.filters.accessRequested(null, null, address, null);
            const grantFilter = readContract.filters.accessGranted(null, null, address, null);
            const denyFilter = readContract.filters.accessDenied(null, null, address, null);
            const revokeFilter = readContract.filters.accessRevoked(null, null, address, null);

            // Fetch sequentially to avoid overwhelming public RPC rate limits
            const uploadEvents = await fetchEventsInChunks(readContract, uploadFilter, startBlock, currentBlock);
            const reqEvents = await fetchEventsInChunks(readContract, reqFilter, startBlock, currentBlock);
            const grantEvents = await fetchEventsInChunks(readContract, grantFilter, startBlock, currentBlock);
            const denyEvents = await fetchEventsInChunks(readContract, denyFilter, startBlock, currentBlock);
            const revokeEvents = await fetchEventsInChunks(readContract, revokeFilter, startBlock, currentBlock);

            // Reconstruct state in-memory (Merging with existing state)

            // Use ref to persist state between renders
            const map = fileStatesRef.current;

            // Helper to ensure file state exists
            const getFileState = (cid: string) => {
                let state = map.get(cid);
                if (!state) {
                    state = { pending: new Set(), approved: new Set(), uploaded: false };
                    map.set(cid, state);
                }
                return state;
            };

            const timeline: TimelineEvent[] = [];
            const toLogIndex = (event: any) => Number(event?.index ?? event?.logIndex ?? 0);

            uploadEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    kind: 'upload',
                    cid: e.args[1],
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            reqEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    kind: 'requested',
                    cid: e.args[1],
                    user: e.args[3],
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            grantEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    kind: 'granted',
                    cid: e.args[1],
                    user: e.args[3],
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            denyEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    kind: 'denied',
                    cid: e.args[1],
                    user: e.args[3],
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            revokeEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    kind: 'revoked',
                    cid: e.args[1],
                    user: e.args[3],
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });

            timeline.sort((a, b) => {
                if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
                return a.logIndex - b.logIndex;
            });

            timeline.forEach((event) => {
                const state = getFileState(event.cid);

                if (event.kind === 'upload') {
                    state.uploaded = true;
                    return;
                }

                if (!event.user) return;

                switch (event.kind) {
                    case 'requested':
                        state.approved.delete(event.user);
                        state.pending.add(event.user);
                        break;
                    case 'granted':
                        state.pending.delete(event.user);
                        state.approved.add(event.user);
                        break;
                    case 'denied':
                        state.pending.delete(event.user);
                        state.approved.delete(event.user);
                        break;
                    case 'revoked':
                        state.pending.delete(event.user);
                        state.approved.delete(event.user);
                        break;
                    default:
                        break;
                }
            });

            const files: MyFile[] = [];
            // Conversion
            for (const [cid, state] of map) {
                // Only include if actually uploaded (or if we want to show files requested from us even if upload event missing?)
                // Strict check: state.uploaded
                if (state.uploaded) {
                    files.push({
                        cid: cid,
                        pendingRequests: Array.from(state.pending),
                        approvedUsers: Array.from(state.approved)
                    });
                }
            }

            console.log(`[CLIENT] Found ${files.length} files owned by me.`);
            setMyFiles(files);
            lastFetchedBlock.current = currentBlock;

        } catch (error) {
            console.error("Error fetching my files:", error);
            setStatus("Failed to fetch files");
        } finally {
            setLoading(false);
            isFetching.current = false;
        }
    }, [address, signer, setStatus]);

    useEffect(() => {
        if (!address || !signer) return;

        const normalizedAddress = address.toLowerCase();
        if (activeAddressRef.current !== normalizedAddress) {
            activeAddressRef.current = normalizedAddress;
            fileStatesRef.current = new Map();
            lastFetchedBlock.current = INITIAL_LAST_FETCHED_BLOCK;
            setMyFiles([]);
        }

        fetchMyFiles();
    }, [address, signer, refreshTrigger, fetchMyFiles]);

    // Listen for Real-time Events
    useEffect(() => {
        if (!signer || !address) return;

        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

        const onAnyEvent = () => {
            // Just trigger fetch, it knows where to start from
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
