import { useState } from 'react';
import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import { uploadToIPFS, downloadFromIPFS } from './utils/ipfs';
import { generateAesKey, encryptFile, decryptFile, exportKeyRaw } from './utils/crypto';
import CONTRACT_ABI from './abi.json' with { type: 'json' };

// --- TypeScript fix for MetaMask ---
declare global {
  interface Window {
    ethereum?: any;
  }
}

// --- Configuration ---
const CONTRACT_ADDRESS = "YOUR_DEPLOYED_CONTRACT_ADDRESS";
const PROXY_API_URL = "http://localhost:8000";

function App() {
  // State
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string>("");
  
  // Self-Custody Keys
  const [mySecretKey, setMySecretKey] = useState<string | null>(null);
  const [myPublicKey, setMyPublicKey] = useState<string | null>(null);

  // UI State
  const [file, setFile] = useState<File | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string>("");
  const [cidInput, setCidInput] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  // 1. Connect Wallet & Initialize
  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        alert("Install MetaMask");
        return;
      }
      
      const _provider = new ethers.BrowserProvider(window.ethereum);
      const _signer = await _provider.getSigner();
      const _address = await _signer.getAddress();
      
      setProvider(_provider);
      setSigner(_signer);
      setAddress(_address);
      setStatus("Wallet connected");
    } catch (error) {
      console.error("Wallet connection failed:", error);
      setStatus("Failed to connect wallet");
    }
  };

  // 2. SIWE Login & Key Retrieval
  const signInWithEthereum = async () => {
    if (!signer || !address) {
      setStatus("Please connect wallet first");
      return;
    }
    
    setStatus("Signing in...");

    try {
      // A. Get Nonce
      const nonceRes = await fetch(`${PROXY_API_URL}/api/nonce`);
      if (!nonceRes.ok) throw new Error("Failed to get nonce");
      const { nonce } = await nonceRes.json();

      // B. Create Message
      const message = new SiweMessage({
        domain: window.location.host,
        address: address,
        statement: 'Sign in to SecureShare PRE.',
        uri: window.location.origin,
        version: '1',
        chainId: 1,
        nonce: nonce
      });
      const preparedMessage = message.prepareMessage();
      const signature = await signer.signMessage(preparedMessage);

      // C. Verify & Get Keys
      const verifyRes = await fetch(`${PROXY_API_URL}/api/verify`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ message: preparedMessage, signature })
      });
      
      if (!verifyRes.ok) throw new Error("Verification failed");
      
      const data = await verifyRes.json();
      if (data.status === 'success') {
        setMySecretKey(data.sk); 
        setMyPublicKey(data.pk);
        
        // D. Auto-Register Public Key
        await registerPublicKeyOnChain(data.pk);
        setStatus("Logged in! Keys received.");
      } else {
        throw new Error("Invalid response from server");
      }
    } catch (error) {
      console.error("Login error:", error);
      setStatus("Login failed: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  };

  const registerPublicKeyOnChain = async (pk: string) => {
    if (!signer) return;
    
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
      const tx = await contract.registerPublicKey(pk);
      await tx.wait();
      console.log("Public Key Registered on Blockchain");
    } catch (error) {
      console.log("Key registration failed (may already be registered):", error);
    }
  };

  // 3. Upload Flow
  const handleUpload = async () => {
    if (!file) {
      setStatus("Please select a file");
      return;
    }
    if (!signer || !myPublicKey) {
      setStatus("Please login first");
      return;
    }
    
    setStatus("Encrypting file...");

    try {
      // Save filename before clearing file state
      const fileName = file.name;
      
      // A. Generate AES Key & Encrypt File
      const aesKey = await generateAesKey();
      const { encryptedBlob } = await encryptFile(file, aesKey);
      
      // B. Upload File to IPFS
      setStatus("Uploading to IPFS...");
      const cid = await uploadToIPFS(encryptedBlob);

      // C. Encrypt AES Key into Capsule
      const aesKeyRaw = await exportKeyRaw(aesKey);
      
      // --- BROWSER-COMPATIBLE: Convert to hex ---
      const aesKeyArray = new Uint8Array(aesKeyRaw);
      const aesKeyHex = Array.from(aesKeyArray)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      const capsuleString = "mock_capsule_" + aesKeyHex; 
      
      // D. Register on Blockchain
      setStatus("Registering on Blockchain...");
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI as ethers.InterfaceAbi, signer);
      const tx = await contract.registerFile(cid, capsuleString);
      await tx.wait();

      setStatus(`Success! File CID: ${cid}`);
      setUploadedFileName(fileName); // Save for later download
      setFile(null); // Reset file input
    } catch (error) {
      console.error("Upload error:", error);
      setStatus("Upload failed: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  };

  // 4. Request Access
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

  // 5. Download & Decrypt
  const handleDownload = async () => {
    if (!cidInput.trim()) {
      setStatus("Please enter a CID");
      return;
    }
    if (!signer || !mySecretKey) {
      setStatus("Please login first");
      return;
    }
    
    setStatus("Downloading...");

    try {
      // A. Fetch Capsule from Proxy
      const res = await fetch(`${PROXY_API_URL}/api/capsule/${cidInput}?user=${address}`);
      if (!res.ok) throw new Error("Failed to fetch capsule");
      const { capsuleB } = await res.json();

      // B. Decrypt Capsule (MOCK)
      const aesKeyHex = capsuleB.replace("mock_capsule_reencrypted_", ""); 
      
      // Convert hex to Uint8Array (browser-compatible)
      const aesKeyArray = new Uint8Array(
        aesKeyHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
      );

      // Import AES key
      const aesKey = await window.crypto.subtle.importKey(
        "raw", 
        aesKeyArray, 
        "AES-GCM", 
        true, 
        ["decrypt"]
      );

      // C. Download & Decrypt File
      const encryptedBlob = await downloadFromIPFS(cidInput);
      const decryptedBlob = await decryptFile(encryptedBlob, aesKey);

      // D. Trigger Browser Download
      const url = URL.createObjectURL(decryptedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = uploadedFileName || "decrypted_file"; // Use saved filename
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setStatus("Downloaded!");
    } catch (error) {
      console.error("Download error:", error);
      setStatus("Download failed: " + (error instanceof Error ? error.message : "Unknown error"));
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>SecureShare PRE Client</h1>
      <p>Status: {status}</p>

      {!address ? (
        <button onClick={connectWallet}>Connect Wallet</button>
      ) : (
        <div>
          <p>Connected: {address}</p>
          {!mySecretKey && <button onClick={signInWithEthereum}>Login (SIWE)</button>}
        </div>
      )}

      {mySecretKey && (
        <div style={{ marginTop: 20, borderTop: '1px solid #ccc', paddingTop: 20 }}>
          <h2>Upload File</h2>
          <input 
            type="file" 
            onChange={(e) => setFile(e.target.files?.[0] || null)} 
          />
          <button onClick={handleUpload} disabled={!file}>
            Encrypt & Upload
          </button>

          <h2 style={{ marginTop: 20 }}>Access File</h2>
          <input 
            type="text" 
            placeholder="IPFS CID" 
            value={cidInput}
            onChange={(e) => setCidInput(e.target.value)}
            style={{ width: 300, marginRight: 10 }}
          />
          <button onClick={handleRequestAccess}>Request Access</button>
          <button onClick={handleDownload}>Download & Decrypt</button>
        </div>
      )}
    </div>
  );
}

export default App;