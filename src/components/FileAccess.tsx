
import React, { useState } from 'react';
import { ethers } from 'ethers';
import { decryptFile, generateEphemeralKeyPair, exportKeyRaw, deriveSharedSecret, decryptResponse } from '../utils/crypto';
import { downloadFromIPFS } from '../utils/ipfs';
import { TimingCollector } from '../utils/timing';
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

        const timing = new TimingCollector();
        timing.start("total_download");

        try {
            // Generate signature for Enclave verification
            setStatus("Please sign the decryption request...");

            console.log("[CLIENT] Generating ephemeral key pair for secure channel...");
            timing.start("ephemeral_keygen");
            const ephemeralKeyPair = await generateEphemeralKeyPair();
            const ephemeralPublicKeyRaw = await exportKeyRaw(ephemeralKeyPair.publicKey);
            const ephemeralPublicKeyHex = Array.from(ephemeralPublicKeyRaw)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            timing.end("ephemeral_keygen");

            console.log("[CLIENT] Ephemeral Public Key:", ephemeralPublicKeyHex);

            console.log("[CLIENT] Requesting signature for decrypt intent...");
            // MITM Fix: Bind the ephemeral key to the signature
            const message = `Sign to decrypt file: ${cidInput} with session key: ${ephemeralPublicKeyHex}`;
            timing.start("wallet_signature");
            const signature = await signer.signMessage(message);
            timing.end("wallet_signature");
            console.log("[CLIENT] Signature complete. Proceeding to decrypt...");

            setStatus("Decrypting via secure processing enclave...");
            console.log("[CLIENT] Sending optimized decryption request to server...");

            timing.start("proxy_decrypt_request");
            const decryptRes = await fetch(`${PROXY_API_URL}/api/decrypt-capsule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    address: address,
                    cid: cidInput,
                    signature: signature,
                    message: message,
                    ephemeral_public_key: ephemeralPublicKeyHex // Send ephemeral key
                })
            });

            if (!decryptRes.ok) throw new Error("Failed to decrypt capsule via server");
            const encryptedResponse = await decryptRes.json();
            timing.end("proxy_decrypt_request");
            console.log("[CLIENT] Decrypt response received.");

            // Log server-side timings if present
            if (encryptedResponse.timings) {
                console.log("\n⏱ Server-Side Timings (EC2 Proxy):");
                console.table(encryptedResponse.timings);
            }
            if (encryptedResponse.enclave_timings) {
                console.log("\n⏱ Server-Side Timings (Enclave):");
                console.table(encryptedResponse.enclave_timings);
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
            timing.start("ecdh_derive_session_key");
            const sessionKey = await deriveSharedSecret(ephemeralKeyPair.privateKey, enclavePubKeyRaw);
            timing.end("ecdh_derive_session_key");

            // Decrypt the AES Key
            console.log("[CLIENT] Decrypting inner payload (AES Key)...");
            timing.start("decrypt_aes_key");
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
            timing.end("decrypt_aes_key");

            // Download & Decrypt File from IPFS
            setStatus("Downloading from IPFS...");
            console.log("[CLIENT] Downloading encrypted file from IPFS...");
            timing.start("ipfs_download");
            const encryptedBlob = await downloadFromIPFS(cidInput);
            timing.end("ipfs_download");
            console.log("[CLIENT] Encrypted blob size:", encryptedBlob.size);

            timing.start("aes_decrypt_file");
            const decryptedBlob = await decryptFile(encryptedBlob, aesKey);
            timing.end("aes_decrypt_file");
            console.log("[CLIENT] File decrypted. Triggering download.");

            timing.end("total_download");
            timing.logTable(`Download & Decrypt (CID: ${cidInput})`);

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
