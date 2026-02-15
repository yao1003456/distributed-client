import type { Helia } from 'helia'
import type { UnixFS } from '@helia/unixfs';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';

let heliaInstance: Helia | null = null;
let fsInstance: UnixFS | null = null;

async function getHelia() {
  if (!heliaInstance) {
    heliaInstance = await createHelia();
  }
  return heliaInstance;
}

async function getFs(): Promise<UnixFS> {
  const helia = await getHelia();
  if (!fsInstance) {
    fsInstance = unixfs(helia);
  }
  return fsInstance;
}

export async function uploadToIPFS(blob: Blob): Promise<string> {
  try {
    let cidString = "";

    // 1. Upload to Pinata (Persistance) - Primary Source of Truth
    try {
      cidString = await uploadToPinata(blob);
    } catch (pinError) {
      console.error("[CLIENT] Pinata upload failed:", pinError);
    }

    // 2. Upload/Add to local Helia node (Browser In-Memory)
    const fs = await getFs();
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const heliaCid = await fs.addBytes(buffer);
    const localCidString = heliaCid.toString();

    console.log(`[CLIENT] Local Helia CID: ${localCidString}`);

    // logic: If Pinata succeeded, use ITS CID. If not, fallback to local.
    // Ideally they match if config is identical, but if not, Pinata wins for persistence.
    if (cidString && cidString !== localCidString) {
      console.warn(`[CLIENT] CID Mismatch! Pinata: ${cidString}, Local: ${localCidString}. Using Pinata CID.`);
    }

    if (!cidString) {
      console.warn("[CLIENT] Using Local CID (Not persisted!). Data will be lost on refresh.");
      cidString = localCidString;
    }

    return cidString;
  } catch (error) {
    console.log("failed to upload to IPFS", error);
    throw new Error("IPFS upload failed");
  }
}

async function uploadToPinata(blob: Blob): Promise<string> {
  const jwt = import.meta.env.VITE_PINATA_JWT;
  if (!jwt) {
    console.warn("[CLIENT] Pinata JWT missing. Skipping persistence.");
    return "";
  }

  const formData = new FormData();
  formData.append('file', blob);

  formData.append('pinataMetadata', JSON.stringify({
    name: `secure_share_${Date.now()}`
  }));
  formData.append('pinataOptions', JSON.stringify({
    cidVersion: 1,
  }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Pinata Error: ${res.statusText}`);
  }

  const data = await res.json();
  console.log(`[CLIENT] Uploaded to Pinata (Persisted): ${data.IpfsHash}`);
  return data.IpfsHash;
}

export async function downloadFromIPFS(cidString: string): Promise<Blob> {
  try {
    const fs = await getFs();
    const { CID } = await import('multiformats/cid');
    const cid = CID.parse(cidString);

    // getting chunks from IPFS
    const chunks: Uint8Array[] = [];
    for await (const chunk of fs.cat(cid)) {
      chunks.push(chunk);
    }

    // combining the chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    return new Blob([buffer]);
  } catch (error) {
    console.error('Failed to download from IPFS:', error);
    throw new Error('IPFS download failed');
  }
}

export async function stopHelia() {
  if (heliaInstance) {
    await heliaInstance.stop();
    heliaInstance = null;
    fsInstance = null;
  }
}