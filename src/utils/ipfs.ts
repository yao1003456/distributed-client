import type { Helia } from 'helia'
import type { UnixFS } from '@helia/unixfs';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';

let heliaInstance: Helia|null = null;
let fsInstance: UnixFS|null = null;

export async function getHelia() {
  if (!heliaInstance) {
    heliaInstance = await createHelia();
  }
  return heliaInstance;
}

async function getFs(): Promise<UnixFS> {
  const helia = await getHelia();
  if (!fsInstance){
    fsInstance = unixfs(helia);
  }
  return fsInstance;
}

export async function uploadToIPFS(blob: Blob): Promise<string> {
  try {
    const fs = await getFs();  
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const cid = await fs.addBytes(buffer);
    return cid.toString();
  } catch (error) {
    console.log("failed to upload to IPFS", error);
    throw new Error("IPFS upload failed");
  }
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

export async function stopHelia(){
  if (heliaInstance){
    await heliaInstance.stop();
    heliaInstance = null;
    fsInstance = null;
  }
}