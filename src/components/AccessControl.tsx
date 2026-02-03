
import React, { useState } from 'react';
import { ethers } from 'ethers';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

interface AccessControlProps {
    signer: ethers.JsonRpcSigner | null;
    setStatus: (s: string) => void;
}

export const AccessControl: React.FC<AccessControlProps> = ({ signer, setStatus }) => {
    const [cidInput, setCidInput] = useState<string>("");
    const [requesterInput, setRequesterInput] = useState<string>("");

    const handleGrantAccess = async () => {
        if (!cidInput.trim() || !requesterInput.trim()) {
            setStatus("Please enter CID and Beneficiary Address");
            return;
        }
        if (!signer) {
            setStatus("Wallet not connected, please connect wallet");
            return;
        }

        try {
            setStatus("Granting access on blockchain...");
            console.log("[CLIENT] Granting access... CID:", cidInput, "Requester:", requesterInput);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.grantAccess(cidInput, requesterInput);
            console.log("[CLIENT] grantAccess tx sent:", tx.hash);
            await tx.wait();
            console.log("[CLIENT] grantAccess confirmed.");

            setStatus(`Access GRANTED to ${requesterInput}`);
        } catch (error) {
            console.error("Grant access error:", error);
            setStatus("Grant failed: " + (error instanceof Error ? error.message : "Unknown error"));
        }
    };

    const handleDenyAccess = async () => {
        if (!cidInput.trim() || !requesterInput.trim()) {
            setStatus("Please enter CID and Beneficiary Address");
            return;
        }
        if (!signer) {
            setStatus("Wallet not connected, please connect wallet");
            return;
        }

        try {
            setStatus("Denying access...");
            console.log("[CLIENT] Denying access... CID:", cidInput, "Requester:", requesterInput);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.denyAccess(cidInput, requesterInput);
            console.log("[CLIENT] denyAccess tx sent:", tx.hash);
            await tx.wait();
            console.log("[CLIENT] denyAccess confirmed.");

            setStatus(`Access DENIED for ${requesterInput}`);
        } catch (error) {
            console.error("Deny access error:", error);
            setStatus("Deny failed: " + (error instanceof Error ? error.message : "Unknown error"));
        }
    };

    return (
        <div style={{ marginTop: 20, borderTop: '1px solid #ccc', paddingTop: 20 }}>
            <h2>Manage Access (Owner Only)</h2>

            <div style={{ marginBottom: 10 }}>
                <input
                    type="text"
                    placeholder="File CID"
                    value={cidInput}
                    onChange={(e) => setCidInput(e.target.value)}
                    style={{ width: 300, marginRight: 10 }}
                />
                <input
                    type="text"
                    placeholder="Beneficiary Address"
                    value={requesterInput}
                    onChange={(e) => setRequesterInput(e.target.value)}
                    style={{ width: 300, marginRight: 10 }}
                />
            </div>
            <button onClick={handleGrantAccess} style={{ marginRight: 10, backgroundColor: '#d4edda' }}>
                Grant Access
            </button>
            <button onClick={handleDenyAccess} style={{ backgroundColor: '#f8d7da' }}>
                Deny Access
            </button>
        </div>
    );
};
