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
    // 1. Upload to local Helia node (Browser In-Memory)
    const fs = await getFs();
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const heliaCid = await fs.addBytes(buffer);
    const cidString = heliaCid.toString();
    console.log(`[CLIENT] Uploaded to Helia (Local): ${cidString}`);

    // 2. Upload to Pinata (Persistance) - Fire and Forget (mostly)
    try {
      await uploadToPinata(blob);
    } catch (pinError) {
      console.error("[CLIENT] Pinata upload failed (Data not persisted):", pinError);
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