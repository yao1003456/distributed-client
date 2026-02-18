import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

interface RequestedFilesProps {
    signer: ethers.JsonRpcSigner | null;
    address: string;
    setStatus: (s: string) => void;
    refreshTrigger?: number;
}

interface RequestedFile {
    cid: string;
    owner: string;
    status: number; // 0=NONE, 1=PENDING, 2=APPROVED, 3=DENIED
    statusText: string;
}

export const RequestedFiles: React.FC<RequestedFilesProps> = ({
    signer,
    address,
    setStatus,
    refreshTrigger
}) => {
    const [requests, setRequests] = useState<RequestedFile[]>([]);
    const [loading, setLoading] = useState<boolean>(false);

    // State to track incremental sync
    const lastFetchedBlock = React.useRef<number>(
        import.meta.env.VITE_DEPLOY_BLOCK ? parseInt(import.meta.env.VITE_DEPLOY_BLOCK) - 1 : -1
    );
    // Keep track of the status map permanently so we can merge updates
    const statusMapRef = React.useRef<Map<string, { owner: string, status: number, blockNumber: number }>>(new Map());

    const getStatusText = (status: number) => {
        switch (status) {
            case 0: return "Revoked / None";
            case 1: return "Pending";
            case 2: return "Approved";
            case 3: return "Denied";
            default: return "Unknown";
        }
    };

    const getStatusColor = (status: number) => {
        switch (status) {
            case 0: return 'var(--color-text-secondary)';
            case 1: return '#f59e0b'; // Orange
            case 2: return 'var(--color-success)'; // Green
            case 3: return 'var(--color-error)'; // Red
            default: return 'var(--color-text-primary)';
        }
    };

    // Helper: Fetch events in chunks to avoid Hardhat StackOverflow/Timeout
    const fetchEventsInChunks = async (
        contract: ethers.Contract,
        filter: ethers.DeferredTopicFilter,
        startBlock: number,
        endBlock: number
    ) => {
        const BATCH_SIZE = 2000;
        let events: Array<any> = [];
        for (let i = startBlock; i <= endBlock; i += BATCH_SIZE) {
            const to = Math.min(i + BATCH_SIZE - 1, endBlock);
            try {
                const chunk = await contract.queryFilter(filter, i, to);
                events = events.concat(chunk);
            } catch (err) {
                console.error(`Error fetching chunk ${i}-${to}:`, err);
                throw err;
            }
        }
        return events;
    };

    // Concurrency guard
    const isFetching = React.useRef<boolean>(false);

    const fetchRequests = useCallback(async () => {
        if (!signer || !address || isFetching.current) return;
        isFetching.current = true;

        // Only show loading spinner on first load
        if (statusMapRef.current.size === 0) setLoading(true);

        try {
            const provider = signer.provider;
            if (!provider) return;

            const currentBlock = await provider.getBlockNumber();
            const startBlock = lastFetchedBlock.current + 1;

            // If we are up to date, do nothing
            if (startBlock > currentBlock) {
                setLoading(false);
                return;
            }

            console.log(`[CLIENT] Fetching requested files events from ${startBlock} to ${currentBlock}...`);

            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

            // 1. Fetch relevant events
            const reqFilter = contract.filters.accessRequested(null, null, null, address);
            const grantedFilter = contract.filters.accessGranted(null, null, null, address);
            const deniedFilter = contract.filters.accessDenied(null, null, null, address);
            const revokedFilter = contract.filters.accessRevoked(null, null, null, address);

            const [reqEvents, grantedEvents, deniedEvents, revokedEvents] = await Promise.all([
                fetchEventsInChunks(contract, reqFilter, startBlock, currentBlock),
                fetchEventsInChunks(contract, grantedFilter, startBlock, currentBlock),
                fetchEventsInChunks(contract, deniedFilter, startBlock, currentBlock),
                fetchEventsInChunks(contract, revokedFilter, startBlock, currentBlock)
            ]);

            // 2. Process into Map (Merging with existing state)
            const map = statusMapRef.current;

            const updateStatus = (cid: string, owner: string, status: number, blockNumber: number) => {
                const current = map.get(cid);
                if (!current || blockNumber > current.blockNumber) {
                    map.set(cid, { owner, status, blockNumber });
                }
            };

            reqEvents.forEach(e => { if ('args' in e) updateStatus(e.args[1], e.args[2], 1, e.blockNumber); });
            grantedEvents.forEach(e => { if ('args' in e) updateStatus(e.args[1], e.args[2], 2, e.blockNumber); });
            deniedEvents.forEach(e => { if ('args' in e) updateStatus(e.args[1], e.args[2], 3, e.blockNumber); });
            revokedEvents.forEach(e => { if ('args' in e) updateStatus(e.args[1], e.args[2], 0, e.blockNumber); });

            // 3. Update State
            const myRequests: RequestedFile[] = [];
            for (const [cid, data] of map) {
                myRequests.push({
                    cid,
                    owner: data.owner,
                    status: data.status,
                    statusText: getStatusText(data.status)
                });
            }

            setRequests(myRequests);
            lastFetchedBlock.current = currentBlock;

        } catch (error) {
            console.error("Error fetching requests:", error);
            setStatus("Failed to fetch requests");
        } finally {
            setLoading(false);
            isFetching.current = false;
        }
    }, [address, signer, setStatus]);

    useEffect(() => {
        if (address && signer) {
            // Reset if address changes (optional, but safer)
            // But we need to check if it's the same user. For now, assume simple reload.
            fetchRequests();
        }
    }, [address, signer, fetchRequests, refreshTrigger]);

    // Real-time updates
    useEffect(() => {
        if (!signer || !address) return;

        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

        const onAnyEvent = () => {
            // Just trigger fetch, it knows where to start from
            fetchRequests();
        };

        const grantedFilter = contract.filters.accessGranted(null, null, null, address);
        const deniedFilter = contract.filters.accessDenied(null, null, null, address);
        const revokedFilter = contract.filters.accessRevoked(null, null, null, address);

        contract.on(grantedFilter, onAnyEvent);
        contract.on(deniedFilter, onAnyEvent);
        contract.on(revokedFilter, onAnyEvent);

        return () => {
            contract.off(grantedFilter, onAnyEvent);
            contract.off(deniedFilter, onAnyEvent);
            contract.off(revokedFilter, onAnyEvent);
        };
    }, [signer, address, fetchRequests]);

    if (!address) return null;

    return (
        <div className="flex flex-col gap-md">
            <div className="flex justify-between items-center">
                <h2>Requested Files</h2>
                <button onClick={fetchRequests} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                    ↻ Refresh
                </button>
            </div>

            {loading && <p className="animate-pulse">Loading requests...</p>}
            {!loading && requests.length === 0 && <p className="text-secondary">No requests found.</p>}

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                {requests.map((req) => (
                    <div key={req.cid} className="card" style={{ padding: 'var(--spacing-md)', marginBottom: 0, backgroundColor: 'var(--color-bg-primary)' }}>
                        <div style={{ fontWeight: 600, marginBottom: 'var(--spacing-sm)', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                            CID: {req.cid}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-xs)' }}>
                            Owner: <span style={{ fontFamily: 'monospace' }}>{req.owner}</span>
                        </div>
                        <div style={{
                            fontWeight: 'bold',
                            color: getStatusColor(req.status),
                            border: `1px solid ${getStatusColor(req.status)}`,
                            padding: '2px 6px',
                            display: 'inline-block',
                            borderRadius: '4px',
                            fontSize: '0.8rem'
                        }}>
                            {req.statusText}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
