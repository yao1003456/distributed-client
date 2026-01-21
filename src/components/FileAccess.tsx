
import React, { useState } from 'react';
import { ethers } from 'ethers';
import { decryptFile } from '../utils/crypto';
import { downloadFromIPFS } from '../utils/ipfs';
import CONTRACT_ABI from '../abi.json';

// Configuration
const CONTRACT_ADDRESS = import.meta.env.CONTRACT_ADDRESS || "";
const PROXY_API_URL = import.meta.env.PROXY_API_URL || "http://localhost:8000";

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
    const [ownerAddressInput, setOwnerAddressInput] = useState<string>("");

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
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const tx = await contract.requestAccess(cidInput);
            await tx.wait();
            setStatus("Access requested!");
        } catch (error) {
            console.error("Request access error:", error);
            setStatus("Request failed: " + (error instanceof Error ? error.message : "Unknown error"));
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

            // Generate signature for Enclave verification
            setStatus("Please sign the decryption request...");
            console.log("[CLIENT] File info fetched. Owner:", fileOwner);
            const message = `Sign to decrypt file: ${cidInput}`;
            const signature = await signer.signMessage(message);

            const isOwner = fileOwner.toLowerCase() === address.toLowerCase();

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
                        signature,
                        message
                    })
                });

                if (!decryptRes.ok) throw new Error("Failed to decrypt capsule");
                const decryptData = await decryptRes.json();

                if (decryptData.status !== 'success') {
                    throw new Error(decryptData.message || "Decryption failed");
                }

                aesKeyHex = decryptData.aes_key;

            } else {
                // B2. Requester: Get re-encrypted capsule from proxy, then decrypt
                setStatus("Getting re-encrypted capsule...");
                console.log("[CLIENT] Decrypting as REQUESTER (re-encrypted)...");

                const ownerAddr = ownerAddressInput.trim() || fileOwner;

                const reencRes = await fetch(
                    `${PROXY_API_URL}/api/capsule/${cidInput}?requester=${address}&owner=${ownerAddr}`
                );

                if (!reencRes.ok) throw new Error("Failed to get re-encrypted capsule");
                const reencData = await reencRes.json();

                if (reencData.status !== 'success') {
                    throw new Error(reencData.message || "Re-encryption failed");
                }

                // Decode base64 cfrag to hex for the enclave
                const cfragBase64 = reencData.reenc_capsule;
                const cfragBinary = atob(cfragBase64);
                const cfragHex = Array.from(cfragBinary, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

                // Use original capsule from proxy response (or from blockchain)
                const originalCapsuleHex = reencData.original_capsule || capsuleHex;

                // Decrypt re-encrypted capsule via enclave
                setStatus("Decrypting shared file...");
                const decryptRes = await fetch(`${PROXY_API_URL}/api/decrypt-capsule`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address: address,
                        capsule: cfragHex,  // Hex-encoded cfrag
                        cid: cidInput,
                        is_reencrypted: true,
                        owner: ownerAddr,
                        original_capsule: originalCapsuleHex,  // Hex-encoded original capsule
                        signature,
                        message
                    })
                });

                if (!decryptRes.ok) throw new Error("Failed to decrypt re-encrypted capsule");
                const decryptData = await decryptRes.json();

                if (decryptData.status !== 'success') {
                    throw new Error(decryptData.message || "Decryption failed");
                }

                aesKeyHex = decryptData.aes_key;
            }

            // C. Import AES key
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
            const encryptedBlob = await downloadFromIPFS(cidInput);
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
            setStatus("Download failed: " + (error instanceof Error ? error.message : "Unknown error"));
        }
    };

    return (
        <div style={{ marginTop: 20 }}>
            <h2 style={{ marginTop: 20 }}>Access File</h2>
            <div>
                <input
                    type="text"
                    placeholder="IPFS CID"
                    value={cidInput}
                    onChange={(e) => setCidInput(e.target.value)}
                    style={{ width: 300, marginRight: 10 }}
                />
                <input
                    type="text"
                    placeholder="Owner Address (for shared files)"
                    value={ownerAddressInput}
                    onChange={(e) => setOwnerAddressInput(e.target.value)}
                    style={{ width: 300, marginRight: 10 }}
                />
            </div>
            <div style={{ marginTop: 10 }}>
                <button onClick={handleRequestAccess} style={{ marginRight: 10 }}>
                    Request Access
                </button>
                <button onClick={handleDownload}>
                    Download & Decrypt
                </button>
            </div>
        </div>
    );
};
