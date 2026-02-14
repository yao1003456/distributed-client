
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';

// Components
import { WalletConnect } from './components/WalletConnect';
import { FileUpload } from './components/FileUpload';
import { FileAccess } from './components/FileAccess';

import { MyFiles } from './components/MyFiles';

// Add Window interface for Ethereum
declare global {
  interface Window {
    ethereum: any;
  }
}

import CONTRACT_ABI_JSON from './abi.json';

// Configuration
const PROXY_API_URL = import.meta.env.VITE_PROXY_API_URL || "http://localhost:8000";
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

// Verify ABI is valid
const CONTRACT_ABI = CONTRACT_ABI_JSON;

function App() {
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string>("");
  const [status, setStatus] = useState<string>("Ready");
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [myPublicKey, setMyPublicKey] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);


  useEffect(() => {
    // Check if wallet is already connected
    if (window.ethereum) {
      window.ethereum.request({ method: 'eth_accounts' })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            connectWallet();
          }
        });
    }
  }, []);

  async function connectWallet() {
    if (!window.ethereum) {
      setStatus("No crypto wallet found. Please install MetaMask.");
      return;
    }

    try {
      const _provider = new ethers.BrowserProvider(window.ethereum);
      const _signer = await _provider.getSigner();
      const _address = await _signer.getAddress();

      setSigner(_signer);
      setAddress(_address);
      console.log("[CLIENT] Wallet connected:", _address);
      setStatus("Wallet connected");
    } catch (error) {
      console.error("Wallet connection failed:", error);
      setStatus("Connection failed");
    }
  }

  async function signInWithEthereum() {
    if (!signer || !address) return;
    setStatus("Signing in...");

    try {
      console.log("[CLIENT] Starting SIWE login sequence...");
      // A. Get Nonce from EC2 proxy
      console.log("[CLIENT] Requesting nonce from proxy...");
      const nonceRes = await fetch(`${PROXY_API_URL}/api/nonce`);
      if (!nonceRes.ok) throw new Error("Failed to get nonce");
      const { nonce } = await nonceRes.json();
      console.log("[CLIENT] Nonce received.");

      // B. Create SIWE Message
      const domain = window.location.host;
      const origin = window.location.origin;
      const statement = "Sign in to Decentralized Data Management System";

      const message = new SiweMessage({
        domain,
        address,
        statement,
        uri: origin,
        version: '1',
        chainId: 31337, // TODO: change to sepolia network, currently hardhat network
        nonce
      });

      const preparedMessage = message.prepareMessage();
      console.log("[CLIENT] SIWE message prepared. Requesting signature...");
      const signature = await signer.signMessage(preparedMessage);
      console.log("[CLIENT] Signature generated.");

      // TODO: get public key from blockchain in the future (prove cryptographic ownership)
      // C. Verify signature & get public key from enclave
      console.log("[CLIENT] Signature generated. Verifying with enclave...");
      const verifyRes = await fetch(`${PROXY_API_URL}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: preparedMessage,
          signature,
          address
        })
      });

      if (!verifyRes.ok) throw new Error("Verification failed");
      const data = await verifyRes.json();
      console.log("[CLIENT] Enclave verification complete.");

      if (data.status !== 'success') {
        throw new Error("Verification failed. Please check the browser console for details.");
      }

      setMyPublicKey(data.pk);
      setIsLoggedIn(true);
      setStatus("Logged in via Enclave!");

      // D. Register public key on-chain (if not already)
      if (data.pk) {
        try {
          const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
          const isReg = await contract.isRegistered(address);
          if (!isReg) {
            console.log("[CLIENT] Registering public key on-chain...");
            setStatus("Registering Identity...");
            const tx = await contract.registerPublicKey(data.pk);
            console.log("[CLIENT] Registration tx sent:", tx.hash);
            await tx.wait();
            console.log("[CLIENT] Identity registered!");
            setStatus("Login Complete & Identity Registered");
          } else {
            console.log("[CLIENT] already registered on-chain");
          }
        } catch (regErr) {
          console.error("Failed to register identity:", regErr);
          // Don't fail the whole login, just warn
        }
      }

    } catch (error) {
      console.error("Login failed:", error);
      setStatus("Login failed");
    }
  }

  const handleUploadSuccess = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <div className="container">
      <header className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-xl)' }}>
        <h1>Secure Data Share</h1>
        <WalletConnect
          address={address}
          isLoggedIn={isLoggedIn}
          status={status}
          connectWallet={connectWallet}
          signInWithEthereum={signInWithEthereum}
        />
      </header>

      <main className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card">
          <FileUpload
            signer={signer}
            isLoggedIn={isLoggedIn}
            myPublicKey={myPublicKey}
            setStatus={setStatus}
            onUploadSuccess={handleUploadSuccess}
          />
        </div>

        <div className="card">
          <FileAccess
            signer={signer}
            isLoggedIn={isLoggedIn}
            address={address}
            setStatus={setStatus}
          />
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <MyFiles
            signer={signer}
            address={address}
            setStatus={setStatus}
            refreshTrigger={refreshTrigger}
          />
        </div>
      </main>
    </div>
  );
}

export default App;