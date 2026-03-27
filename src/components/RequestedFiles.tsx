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

interface RequestedFilesProps {
    signer: ethers.JsonRpcSigner | null;
    address: string;
    setStatus: (s: string) => void;
    refreshTrigger?: number;
}

interface RequestedFile {
    cid: string;
    owner: string;
    status: number; // 0=NONE, 1=PENDING, 2=APPROVED, 3=DENIED, 4=REVOKED
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
    const lastFetchedBlock = React.useRef<number>(INITIAL_LAST_FETCHED_BLOCK);
    interface RequestStatusState {
        owner: string;
        status: number;
        blockNumber: number;
        logIndex: number;
    }
    interface TimelineEvent {
        cid: string;
        owner: string;
        status: number;
        blockNumber: number;
        logIndex: number;
    }
    // Keep track of the status map permanently so we can merge updates
    const statusMapRef = React.useRef<Map<string, RequestStatusState>>(new Map());
    const activeAddressRef = React.useRef<string>("");

    const getStatusText = (status: number) => {
        switch (status) {
            case 0: return "None";
            case 1: return "Pending";
            case 2: return "Approved";
            case 3: return "Denied";
            case 4: return "Revoked";
            default: return "Unknown";
        }
    };

    const getStatusColor = (status: number) => {
        switch (status) {
            case 0: return 'var(--color-text-secondary)';
            case 1: return '#f59e0b'; // Orange
            case 2: return 'var(--color-success)'; // Green
            case 3: return 'var(--color-error)'; // Red
            case 4: return 'var(--color-error)'; // Red
            default: return 'var(--color-text-primary)';
        }
    };

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

    const fetchRequests = useCallback(async () => {
        if (!signer || !address || isFetching.current) return;
        isFetching.current = true;

        // Only show loading spinner on first load
        if (statusMapRef.current.size === 0) setLoading(true);

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

            console.log(`[CLIENT] Fetching requested files events from ${startBlock} to ${currentBlock}...`);

            const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, readProvider);

            // 1. Fetch relevant events
            const reqFilter = readContract.filters.accessRequested(null, null, null, address);
            const grantedFilter = readContract.filters.accessGranted(null, null, null, address);
            const deniedFilter = readContract.filters.accessDenied(null, null, null, address);
            const revokedFilter = readContract.filters.accessRevoked(null, null, null, address);

            // Fetch sequentially to avoid overwhelming public RPC rate limits
            const reqEvents = await fetchEventsInChunks(readContract, reqFilter, startBlock, currentBlock);
            const grantedEvents = await fetchEventsInChunks(readContract, grantedFilter, startBlock, currentBlock);
            const deniedEvents = await fetchEventsInChunks(readContract, deniedFilter, startBlock, currentBlock);
            const revokedEvents = await fetchEventsInChunks(readContract, revokedFilter, startBlock, currentBlock);

            // 2. Process into Map (Merging with existing state)
            const map = statusMapRef.current;
            const toLogIndex = (event: any) => Number(event?.index ?? event?.logIndex ?? 0);
            const timeline: TimelineEvent[] = [];

            const updateStatus = (event: TimelineEvent) => {
                const { cid, owner, status, blockNumber, logIndex } = event;
                const current = map.get(cid);
                if (
                    !current ||
                    blockNumber > current.blockNumber ||
                    (blockNumber === current.blockNumber && logIndex > current.logIndex)
                ) {
                    map.set(cid, { owner, status, blockNumber, logIndex });
                }
            };

            reqEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    cid: e.args[1],
                    owner: e.args[2],
                    status: 1,
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            grantedEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    cid: e.args[1],
                    owner: e.args[2],
                    status: 2,
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            deniedEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    cid: e.args[1],
                    owner: e.args[2],
                    status: 3,
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });
            revokedEvents.forEach(e => {
                if (!('args' in e)) return;
                timeline.push({
                    cid: e.args[1],
                    owner: e.args[2],
                    status: 4,
                    blockNumber: e.blockNumber,
                    logIndex: toLogIndex(e)
                });
            });

            timeline.sort((a, b) => {
                if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
                return a.logIndex - b.logIndex;
            });

            timeline.forEach(updateStatus);

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
        if (!address || !signer) return;

        const normalizedAddress = address.toLowerCase();
        if (activeAddressRef.current !== normalizedAddress) {
            activeAddressRef.current = normalizedAddress;
            statusMapRef.current = new Map();
            lastFetchedBlock.current = INITIAL_LAST_FETCHED_BLOCK;
            setRequests([]);
        }

        fetchRequests();
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
