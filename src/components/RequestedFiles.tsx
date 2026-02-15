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

    const fetchRequests = useCallback(async () => {
        if (!signer || !address) return;
        setLoading(true);

        try {
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

            // Optimization: Use a deployment block to limit scan range
            const fromBlock = import.meta.env.VITE_DEPLOY_BLOCK ? parseInt(import.meta.env.VITE_DEPLOY_BLOCK) : 0;

            // 1. Fetch ALL accessRequested events where I am the requester
            // event accessRequested(bytes32 indexed hash, string cid, address indexed owner, address indexed requester);
            const reqFilter = contract.filters.accessRequested(null, null, null, address);
            const reqEvents = await contract.queryFilter(reqFilter, fromBlock);

            // 2. Fetch ALL status change events where I am the subject
            // event accessGranted(bytes32 indexed hash, string cid, address indexed owner, address indexed requester);
            const grantedFilter = contract.filters.accessGranted(null, null, null, address);
            const grantedEvents = await contract.queryFilter(grantedFilter, fromBlock);

            // event accessDenied(bytes32 indexed hash, string cid, address indexed owner, address indexed requester);
            const deniedFilter = contract.filters.accessDenied(null, null, null, address);
            const deniedEvents = await contract.queryFilter(deniedFilter, fromBlock);

            // event accessRevoked(bytes32 indexed hash, string cid, address indexed owner, address indexed user);
            const revokedFilter = contract.filters.accessRevoked(null, null, null, address);
            const revokedEvents = await contract.queryFilter(revokedFilter, fromBlock);

            // 3. Process events to determine current status per CID
            // Map: CID -> { owner, status, blockNumber }
            const statusMap = new Map<string, { owner: string, status: number, blockNumber: number }>();

            // Helper to update status if event is newer
            const updateStatus = (cid: string, owner: string, status: number, blockNumber: number) => {
                const current = statusMap.get(cid);
                if (!current || blockNumber > current.blockNumber) {
                    statusMap.set(cid, { owner, status, blockNumber });
                }
            };

            // Process requests (Initial state = PENDING = 1)
            reqEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const owner = e.args[2];
                    updateStatus(cid, owner, 1, e.blockNumber);
                }
            });

            // Process grants (State = APPROVED = 2)
            grantedEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const owner = e.args[2];
                    updateStatus(cid, owner, 2, e.blockNumber);
                }
            });

            // Process denials (State = DENIED = 3)
            deniedEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const owner = e.args[2];
                    updateStatus(cid, owner, 3, e.blockNumber);
                }
            });

            // Process revocations (State = NONE = 0, effectively)
            // But usually we show "Revoked" or just remove it. Let's start with 0.
            revokedEvents.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const owner = e.args[2];
                    updateStatus(cid, owner, 0, e.blockNumber);
                }
            });

            const myRequests: RequestedFile[] = [];
            for (const [cid, data] of statusMap) {
                // Optional: Filter out logic if you don't want to see Revoked/None items
                myRequests.push({
                    cid,
                    owner: data.owner,
                    status: data.status,
                    statusText: getStatusText(data.status)
                });
            }

            setRequests(myRequests);
        } catch (error) {
            console.error("Error fetching requests:", error);
            setStatus("Failed to fetch requests");
        } finally {
            setLoading(false);
        }
    }, [address, signer, setStatus]);

    useEffect(() => {
        if (address && signer) {
            fetchRequests();
        }
    }, [address, signer, fetchRequests, refreshTrigger]);

    // Real-time updates
    useEffect(() => {
        if (!signer || !address) return;

        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

        // Filter events where *I* am the involved party (requester/user) which is index 3

        // We can listen to specific filters too
        const onAnyEvent = () => {
            // simplified refresh for any relevant event
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
