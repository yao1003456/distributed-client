
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';

// Components
import { WalletConnect } from './components/WalletConnect';
import { FileUpload } from './components/FileUpload';
import { FileAccess } from './components/FileAccess';

import { MyFiles } from './components/MyFiles';
import { RequestedFiles } from './components/RequestedFiles';

// Add Window interface for Ethereum
declare global {
  interface Window {
    ethereum?: unknown;
  }
}

import CONTRACT_ABI_JSON from './abi.json';

// Configuration
const PROXY_API_URL = import.meta.env.VITE_PROXY_API_URL || "http://localhost:8000";
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";

interface InjectedProvider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  providers?: unknown[];
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
}

interface ProviderCandidate {
  provider: InjectedProvider;
  isMetaMask: boolean;
  isCoinbaseWallet: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInjectedProvider(value: unknown): value is InjectedProvider {
  return isObject(value) && typeof value.request === "function";
}

function extractCandidate(value: unknown): ProviderCandidate | null {
  if (!isObject(value)) return null;

  const directProvider = isInjectedProvider(value) ? value : null;

  const nestedProvider =
    isInjectedProvider(value.provider) ? value.provider : null;

  const provider = directProvider ?? nestedProvider;
  if (!provider) return null;

  return {
    provider,
    isMetaMask: Boolean(value.isMetaMask || provider.isMetaMask),
    isCoinbaseWallet: Boolean(value.isCoinbaseWallet || provider.isCoinbaseWallet),
  };
}

function pickInjectedProvider(): InjectedProvider | null {
  const injected = window.ethereum;
  if (!injected) return null;

  const candidates: ProviderCandidate[] = [];
  const seen = new Set<InjectedProvider>();

  const addCandidate = (value: unknown) => {
    const candidate = extractCandidate(value);
    if (!candidate || seen.has(candidate.provider)) return;
    seen.add(candidate.provider);
    candidates.push(candidate);
  };

  addCandidate(injected);

  if (isObject(injected) && Array.isArray(injected.providers)) {
    for (const candidate of injected.providers) {
      addCandidate(candidate);
    }
  }

  const selected =
    candidates.find((candidate) => candidate.isMetaMask) ??
    candidates.find((candidate) => candidate.isCoinbaseWallet) ??
    candidates[0] ??
    null;

  return selected?.provider ?? null;
}

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
    const injectedProvider = pickInjectedProvider();
    if (injectedProvider) {
      injectedProvider.request({ method: 'eth_accounts' })
        .then((accounts) => {
          const accountList = Array.isArray(accounts) ? accounts as string[] : [];
          if (accountList.length > 0) {
            void connectWallet(injectedProvider, false);
          }
        })
        .catch((error) => {
          // Some wallet injectors throw during passive account checks; don't block manual connect.
          console.warn("Unable to check existing wallet session:", error);
        });
    }
  }, []);

  async function connectWallet(providerOverride?: InjectedProvider, requestAccounts: boolean = true) {
    const injectedProvider = providerOverride ?? pickInjectedProvider();
    if (!injectedProvider) {
      setStatus(
        window.ethereum
          ? "Wallet detected but no compatible provider found. Disable other wallet extensions and refresh."
          : "No crypto wallet found. Please install MetaMask."
      );
      return;
    }

    try {
      if (requestAccounts) {
        await injectedProvider.request({ method: 'eth_requestAccounts' });
      }

      const _provider = new ethers.BrowserProvider(injectedProvider);
      const _signer = await _provider.getSigner();
      const _address = await _signer.getAddress();

      setSigner(_signer);
      setAddress(_address);
      console.log("[CLIENT] Wallet connected:", _address);
      setStatus("Wallet connected");
    } catch (error) {
      console.error("Wallet connection failed:", error);
      const message = error instanceof Error ? error.message : "Unknown wallet error";
      setStatus(`Connection failed: ${message}`);
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
        chainId: import.meta.env.VITE_CHAIN_ID ? parseInt(import.meta.env.VITE_CHAIN_ID) : 31337,
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

  const [requestsRefreshTrigger, setRequestsRefreshTrigger] = useState<number>(0);

  const handleRequestSuccess = () => {
    setRequestsRefreshTrigger(prev => prev + 1);
  };

  return (
    <div className="container">
      <header className="flex flex-col gap-md" style={{ marginBottom: 'var(--spacing-xl)' }}>
        <div className="flex justify-between items-center">
          <h1>Secure Data Share</h1>
          <WalletConnect
            address={address}
            isLoggedIn={isLoggedIn}
            connectWallet={connectWallet}
            signInWithEthereum={signInWithEthereum}
          />
        </div>

        {/* Status Bar */}
        <div
          className={`status-badge ${status.toLowerCase().includes('failed') || status.toLowerCase().includes('error') ? 'error' : 'success'}`}
          style={{
            fontSize: 'var(--font-size-lg)',
            padding: 'var(--spacing-sm) var(--spacing-lg)',
            width: '100%',
            textAlign: 'center',
            borderRadius: 'var(--radius-md)'
          }}
        >
          {status}
        </div>
      </header>

      <main className="flex flex-col gap-lg">
        {/* Top Row: File Upload and Access */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))' }}>
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
              onRequestSuccess={handleRequestSuccess}
            />
          </div>
        </div>

        {/* Full Width Sections */}
        <div className="card">
          <MyFiles
            signer={signer}
            address={address}
            setStatus={setStatus}
            refreshTrigger={refreshTrigger}
          />
        </div>

        <div className="card">
          <RequestedFiles
            signer={signer}
            address={address}
            setStatus={setStatus}
            refreshTrigger={requestsRefreshTrigger}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
