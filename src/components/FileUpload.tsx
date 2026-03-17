
import React, { useState } from 'react';
import { ethers } from 'ethers';
import { generateAesKey, encryptFile, exportKeyRaw } from '../utils/crypto';
import { uploadToIPFS } from '../utils/ipfs';
import { encapsulate } from '../utils/umbral';
import { TimingCollector } from '../utils/timing';
import CONTRACT_ABI from '../abi.json';


const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

interface FileUploadProps {
    signer: ethers.JsonRpcSigner | null;
    isLoggedIn: boolean;
    myPublicKey: string | null;
    setStatus: (s: string) => void;
    onUploadSuccess?: () => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({
    signer,
    isLoggedIn,
    myPublicKey,
    setStatus,
    onUploadSuccess
}) => {
    const [file, setFile] = useState<File | null>(null);
    const [uploadedFileName, setUploadedFileName] = useState<string>("");

    const handleUpload = async () => {
        if (!file) {
            setStatus("Please select a file");
            return;
        }
        if (!signer || !isLoggedIn || !myPublicKey) {
            setStatus("Please login first");
            return;
        }

        setStatus("Encrypting file...");
        console.log("[CLIENT] Starting file upload...");

        const timing = new TimingCollector();
        timing.start("total_upload");

        try {
            const fileName = file.name;

            // Generate AES Key & Encrypt File locally
            console.log("[CLIENT] Generating AES key and encrypting file...");
            timing.start("aes_keygen_and_encrypt");
            const aesKey = await generateAesKey();
            const { encryptedBlob } = await encryptFile(file, aesKey);
            timing.end("aes_keygen_and_encrypt");
            console.log("[CLIENT] File encrypted. Encrypted size:", encryptedBlob.size);

            // Upload encrypted file to IPFS
            setStatus("Uploading to IPFS...");
            console.log("[CLIENT] Uploading encrypted file to IPFS...");
            timing.start("ipfs_upload");
            const cid = await uploadToIPFS(encryptedBlob);
            timing.end("ipfs_upload");
            console.log("[CLIENT] IPFS upload complete. CID:", cid);

            // Encapsulate AES key locally using our public key (PRE encryption)
            setStatus("Encapsulating key...");
            console.log("[CLIENT] Encapsulating AES key for self...");
            timing.start("umbral_encapsulate");
            const aesKeyRaw = await exportKeyRaw(aesKey);
            const aesKeyBytes = new Uint8Array(aesKeyRaw);

            // Encapsulate to our own public key
            const { capsule, ciphertext } = await encapsulate(myPublicKey, aesKeyBytes);
            timing.end("umbral_encapsulate");
            console.log("[CLIENT] Encapsulation complete. Capsule bytes:", capsule.length);

            // Register on Blockchain with capsule and ciphertext
            setStatus("Registering on Blockchain...");
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);

            // '0x' prefixes added to show it is a hex string
            const capsuleBytes = ethers.getBytes('0x' + capsule);
            const ciphertextBytes = ethers.getBytes('0x' + ciphertext);

            timing.start("blockchain_register");
            const tx = await contract.registerFile(cid, capsuleBytes, ciphertextBytes);
            console.log("[CLIENT] registerFile tx sent:", tx.hash);
            await tx.wait();
            timing.end("blockchain_register");
            console.log("[CLIENT] registerFile confirmed.");

            timing.end("total_upload");
            timing.logTable(`Upload (${fileName}, ${file.size} bytes)`);

            setStatus(`Success! File CID: ${cid}`);
            setUploadedFileName(fileName);
            setFile(null);
            if (onUploadSuccess) onUploadSuccess();
        } catch (error) {
            console.error("Upload error:", error);
            setStatus("Upload failed. Please check the browser console for details.");
        }
    };

    return (
        <div className="flex flex-col gap-md">
            <h2>Upload File</h2>
            <div
                className="flex flex-col items-center justify-center p-xl border-dashed rounded-lg bg-tertiary hover:bg-opacity-80 transition cursor-pointer"
                style={{ border: '2px dashed var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--spacing-xl)', textAlign: 'center' }}
            >
                <input
                    type="file"
                    id="file-upload"
                    className="hidden"
                    style={{ display: 'none' }}
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center gap-sm">
                    <span style={{ fontSize: '2rem' }}>📄</span>
                    <span className="text-secondary font-medium">
                        {file ? file.name : "Click to select a file"}
                    </span>
                </label>
            </div>

            <button
                className="btn btn-primary w-full"
                onClick={handleUpload}
                disabled={!file}
                style={{ width: '100%' }}
            >
                Encrypt & Upload
            </button>

            {uploadedFileName && (
                <div className="status-badge success animate-fade-in">
                    Last uploaded: {uploadedFileName}
                </div>
            )}
        </div>
    );
};
