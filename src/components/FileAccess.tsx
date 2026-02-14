
import React, { useState } from 'react';
import { ethers } from 'ethers';
import { decryptFile } from '../utils/crypto';
import { downloadFromIPFS } from '../utils/ipfs';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";
const PROXY_API_URL = import.meta.env.VITE_PROXY_API_URL || "http://localhost:8000";

interface FileAccessProps {
    signer: ethers.JsonRpcSigner | null;
    isLoggedIn: boolean;
    address: string;
    setStatus: (s: string) => void;
}

export const FileAccess: React.FC<FileAccessProps> = ({
    signer,
    isLoggedIn,
    address,
    setStatus
}) => {
    const [cidInput, setCidInput] = useState<string>("");

    const handleRequestAccess = async () => {
        if (!cidInput.trim()) {
            setStatus("Please enter a CID");
            return;
        }
        if (!signer) {
            setStatus("Please connect wallet first");
            return;
        }

        try {
            console.log("[CLIENT] Requesting access for CID:", cidInput);
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.requestAccess(cidInput);
            console.log("[CLIENT] requestAccess tx sent:", tx.hash);
            await tx.wait();
            console.log("[CLIENT] requestAccess confirmed.");
            setStatus("Access requested!");
        } catch (error) {
            console.error("Request access error:", error);
            setStatus("Request failed. Please check the browser console for details.");
        }
    };

    const handleDownload = async () => {
        if (!cidInput.trim()) {
            setStatus("Please enter a CID");
            return;
        }
        if (!signer || !isLoggedIn) {
            setStatus("Please login first");
            return;
        }

        setStatus("Fetching file info...");
        console.log(`[CLIENT] Starting download for CID: ${cidInput}`);

        try {
            // A. Get file info from blockchain
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const fileData = await contract.getFile(cidInput);
            const fileOwner = fileData.owner;
            const capsuleHex = ethers.hexlify(fileData.capsule).slice(2); // Remove 0x prefix
            // might need to adjust depending on how data is stored

            // Generate signature for Enclave verification
            setStatus("Please sign the decryption request...");
            console.log("[CLIENT] File info fetched. Owner:", fileOwner);
            console.log("[CLIENT] Requesting signature for decrypt intent...");
            const message = `Sign to decrypt file: ${cidInput}`;
            const signature = await signer.signMessage(message);
            console.log("[CLIENT] Signature complete. Proceeding to decrypt...");

            const isOwner = fileOwner.toLowerCase() === address.toLowerCase();
            console.log("[CLIENT] Decrypt path:", isOwner ? "OWNER" : "REQUESTER");

            let aesKeyHex: string;

            if (isOwner) {
                // B1. Owner: Direct decryption via enclave
                setStatus("Decrypting as owner...");
                console.log("[CLIENT] Decrypting as OWNER (direct)...");
                const decryptRes = await fetch(`${PROXY_API_URL}/api/decrypt-capsule`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address: address,
                        capsule: capsuleHex,
                        cid: cidInput,
                        is_reencrypted: false,
                        owner: fileOwner,
                        signature,
                        message
                    })
                });

                if (!decryptRes.ok) throw new Error("Failed to decrypt capsule");
                const decryptData = await decryptRes.json();
                console.log("[CLIENT] Owner decrypt response:", decryptData.status);

                if (decryptData.status !== 'success') {
                    throw new Error(decryptData.message || "Decryption failed");
                }

                aesKeyHex = decryptData.aes_key;

            } else {
                // B2. Requester: Get re-encrypted capsule from proxy, then decrypt
                setStatus("Getting re-encrypted capsule...");
                console.log("[CLIENT] Decrypting as REQUESTER (re-encrypted)...");

                console.log("[CLIENT] Requesting re-encrypted capsule from proxy...");

                const reencRes = await fetch(
                    `${PROXY_API_URL}/api/capsule/${cidInput}?requester=${address}&owner=${fileOwner}`
                );

                if (!reencRes.ok) throw new Error("Failed to get re-encrypted capsule");
                const reencData = await reencRes.json();
                console.log("[CLIENT] Re-encrypted capsule response:", reencData.status);

                if (reencData.status !== 'success') {
                    throw new Error(reencData.message || "Re-encryption failed");
                }

                const cfragHex = reencData.cfrag;
                const originalCapsuleHex = reencData.original_capsule;
                console.log("[CLIENT] cfrag length:", cfragHex?.length || 0);

                // Decrypt re-encrypted capsule via enclave
                setStatus("Decrypting shared file...");
                const decryptRes = await fetch(`${PROXY_API_URL}/api/decrypt-capsule`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address: address,
                        capsule: originalCapsuleHex,
                        cfrag: cfragHex,
                        cid: cidInput,
                        is_reencrypted: true,
                        owner: fileOwner,
                        signature,
                        message
                    })
                });

                if (!decryptRes.ok) throw new Error("Failed to decrypt re-encrypted capsule");
                const decryptData = await decryptRes.json();
                console.log("[CLIENT] Requester decrypt response:", decryptData.status);

                if (decryptData.status !== 'success') {
                    throw new Error(decryptData.message || "Decryption failed");
                }

                aesKeyHex = decryptData.aes_key;
            }

            // C. Import AES key
            console.log("[CLIENT] Importing AES key for decryption...");
            const aesKeyArray = new Uint8Array(
                aesKeyHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
            );

            const aesKey = await window.crypto.subtle.importKey(
                "raw",
                aesKeyArray,
                "AES-GCM",
                true,
                ["decrypt"]
            );

            // D. Download & Decrypt File from IPFS
            setStatus("Downloading from IPFS...");
            console.log("[CLIENT] Downloading encrypted file from IPFS...");
            const encryptedBlob = await downloadFromIPFS(cidInput);
            console.log("[CLIENT] Encrypted blob size:", encryptedBlob.size);
            const decryptedBlob = await decryptFile(encryptedBlob, aesKey);
            console.log("[CLIENT] File decrypted. Triggering download.");

            // E. Trigger Browser Download
            const url = URL.createObjectURL(decryptedBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `decrypted_${cidInput}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            setStatus("Downloaded successfully!");
        } catch (error) {
            console.error("Download error:", error);
            setStatus("Download failed. Please check the browser console for details.");
        }
    };

    return (
        <div className="flex flex-col gap-md">
            <h2>Access File</h2>
            <div className="flex gap-sm">
                <input
                    type="text"
                    className="input"
                    placeholder="Enter IPFS CID..."
                    value={cidInput}
                    onChange={(e) => setCidInput(e.target.value)}
                    style={{ flex: 1 }}
                />
            </div>
            <div className="flex gap-sm">
                <button className="btn btn-secondary" onClick={handleRequestAccess} style={{ flex: 1 }}>
                    Request Access
                </button>
                <button className="btn btn-primary" onClick={handleDownload} style={{ flex: 1 }}>
                    Download & Decrypt
                </button>
            </div>
        </div>
    );
};
