import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

interface RequestedFilesProps {
    signer: ethers.JsonRpcSigner | null;
    address: string;
    setStatus: (s: string) => void;
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
    setStatus
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

            // 1. Find all files I have EVER requested access to
            // event accessRequested(hash, cid, owner, requester)
            // Note: Parameters are not indexed in contract, so we must fetch all and filter client-side
            const filter = contract.filters.accessRequested();
            const events = await contract.queryFilter(filter);

            const uniqueCids = new Map<string, string>(); // cid -> owner

            events.forEach(e => {
                if ('args' in e) {
                    const cid = e.args[1];
                    const owner = e.args[2];
                    const requester = e.args[3];

                    if (requester.toLowerCase() === address.toLowerCase()) {
                        uniqueCids.set(cid, owner);
                    }
                }
            });

            const myRequests: RequestedFile[] = [];

            // 2. Check current status for each
            for (const [cid, owner] of uniqueCids) {
                const statusBigInt = await contract.getAccessStatus(cid, address);
                const status = Number(statusBigInt);

                // optionally filter out "NONE" if you only want active history
                // but user might want to see Revoked items too

                myRequests.push({
                    cid,
                    owner,
                    status,
                    statusText: getStatusText(status)
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
    }, [address, signer, fetchRequests]);

    // Real-time updates
    useEffect(() => {
        if (!signer || !address) return;

        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

        // Filter events where *I* am the involved party

        // Granted to ME
        const onAccessGranted = (_hash: string, cid: string, _owner: string, requester: string) => {
            if (requester.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] Access granted for ${cid}. Refreshing requests...`);
                fetchRequests();
            }
        };

        // Denied for ME
        const onAccessDenied = (_hash: string, cid: string, _owner: string, requester: string) => {
            if (requester.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] Access denied for ${cid}. Refreshing requests...`);
                fetchRequests();
            }
        };

        // Revoked from ME
        const onAccessRevoked = (_hash: string, cid: string, _owner: string, user: string) => {
            if (user.toLowerCase() === address.toLowerCase()) {
                console.log(`[CLIENT] Access revoked for ${cid}. Refreshing requests...`);
                fetchRequests();
            }
        };

        contract.on("accessGranted", onAccessGranted);
        contract.on("accessDenied", onAccessDenied);
        contract.on("accessRevoked", onAccessRevoked);

        return () => {
            contract.off("accessGranted", onAccessGranted);
            contract.off("accessDenied", onAccessDenied);
            contract.off("accessRevoked", onAccessRevoked);
        };
    }, [signer, address, fetchRequests]);

    if (!address) return null;

    return (
        <div style={{ marginTop: 20, borderTop: '1px solid #ccc', paddingTop: 20 }}>
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
                            Owner: <span style={{ fontFamily: 'monospace' }}>{req.owner.substring(0, 10)}...</span>
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
