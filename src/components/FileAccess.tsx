
import React, { useState } from 'react';
import { ethers } from 'ethers';
import { decryptFile, generateEphemeralKeyPair, exportKeyRaw, deriveSharedSecret, decryptResponse } from '../utils/crypto';
import { downloadFromIPFS } from '../utils/ipfs';
import CONTRACT_ABI from '../abi.json';


const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";
const PROXY_API_URL = import.meta.env.VITE_PROXY_API_URL || "http://localhost:8000";

interface FileAccessProps {
    signer: ethers.JsonRpcSigner | null;
    isLoggedIn: boolean;
    address: string;
    setStatus: (s: string) => void;
    onRequestSuccess?: () => void;
}

export const FileAccess: React.FC<FileAccessProps> = ({
    signer,
    isLoggedIn,
    address,
    setStatus,
    onRequestSuccess
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
            if (onRequestSuccess) onRequestSuccess();
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
            // Get file info from blockchain
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
            const fileData = await contract.getFile(cidInput);
            const fileOwner = fileData.owner;
            const capsuleHex = ethers.hexlify(fileData.capsule).slice(2); // Remove 0x prefix


            // Generate signature for Enclave verification
            setStatus("Please sign the decryption request...");
            console.log("[CLIENT] File info fetched. Owner:", fileOwner);


            console.log("[CLIENT] Generating ephemeral key pair for secure channel...");
            const ephemeralKeyPair = await generateEphemeralKeyPair();
            const ephemeralPublicKeyRaw = await exportKeyRaw(ephemeralKeyPair.publicKey);
            const ephemeralPublicKeyHex = Array.from(ephemeralPublicKeyRaw)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            console.log("[CLIENT] Ephemeral Public Key:", ephemeralPublicKeyHex);

            console.log("[CLIENT] Requesting signature for decrypt intent...");
            // MITM Fix: Bind the ephemeral key to the signature
            const message = `Sign to decrypt file: ${cidInput} with session key: ${ephemeralPublicKeyHex}`;
            const signature = await signer.signMessage(message);
            console.log("[CLIENT] Signature complete. Proceeding to decrypt...");

            const isOwner = fileOwner.toLowerCase() === address.toLowerCase();
            console.log("[CLIENT] Decrypt path:", isOwner ? "OWNER" : "REQUESTER");



            let encryptedResponse: any;

            if (isOwner) {
                // Owner: Direct decryption via enclave
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
                        signature: signature,
                        message: message,
                        ephemeral_public_key: ephemeralPublicKeyHex // Send ephemeral key
                    })
                });

                if (!decryptRes.ok) throw new Error("Failed to decrypt capsule");
                encryptedResponse = await decryptRes.json();
                console.log("[CLIENT] Owner decrypt response received.");

            } else {
                // Requester: Get re-encrypted capsule from proxy, then decrypt
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
                        signature: signature,
                        message: message,
                        ephemeral_public_key: ephemeralPublicKeyHex // Send ephemeral key
                    })
                });

                if (!decryptRes.ok) throw new Error("Failed to decrypt re-encrypted capsule");
                encryptedResponse = await decryptRes.json();
                console.log("[CLIENT] Requester decrypt response received.");
            }


            if (encryptedResponse.status !== 'success') {
                throw new Error(encryptedResponse.message || "Decryption failed");
            }

            console.log("[CLIENT] Processing encrypted response from enclave...");

            // Extract Enclave's Ephemeral Public Key
            const enclavePubKeyHex = encryptedResponse.enclave_ephemeral_public_key;
            if (!enclavePubKeyHex) throw new Error("Missing enclave public key");

            const enclavePubKeyRaw = new Uint8Array(
                enclavePubKeyHex.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16))
            );

            // Derive Shared Session Key
            console.log("[CLIENT] Deriving shared session key...");
            const sessionKey = await deriveSharedSecret(ephemeralKeyPair.privateKey, enclavePubKeyRaw);

            // Decrypt the AES Key
            console.log("[CLIENT] Decrypting inner payload (AES Key)...");
            const decryptedAesKeyRaw = await decryptResponse(
                encryptedResponse.encrypted_data,
                encryptedResponse.iv,
                sessionKey
            );

            // Import the actual AES Key
            console.log("[CLIENT] Importing AES key for file decryption...");
            const aesKey = await window.crypto.subtle.importKey(
                "raw",
                decryptedAesKeyRaw as any, // Cast to avoid SharedArrayBuffer lint
                "AES-GCM",
                true,
                ["decrypt"]
            );

            // Download & Decrypt File from IPFS
            setStatus("Downloading from IPFS...");
            console.log("[CLIENT] Downloading encrypted file from IPFS...");
            const encryptedBlob = await downloadFromIPFS(cidInput);
            console.log("[CLIENT] Encrypted blob size:", encryptedBlob.size);
            const decryptedBlob = await decryptFile(encryptedBlob, aesKey);
            console.log("[CLIENT] File decrypted. Triggering download.");

            // Trigger Browser Download
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
