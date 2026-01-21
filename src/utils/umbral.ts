import * as umbral from '@nucypher/umbral-pre';
/**
 * Encapsulate (encrypt) plaintext to a public key.
 * 
 * This creates a capsule that can only be decrypted by:
 * 1. The owner of the corresponding secret key (direct decryption)
 * 2. Anyone with a valid re-encryption key fragment (proxy re-encryption)
 * 
 * @param publicKeyHex - The recipient's public key as hex string
 * @param plaintext - The data to encrypt (e.g., AES key)
 * @returns Object containing capsule and ciphertext as hex strings
 */

async function initUmbralWasm() {
  // If the module exposes a `ready` promise, await it.
  if ((umbral as any).ready) {
    await (umbral as any).ready;
    return;
  }
  // If the module requires explicit init(wasmUrl), provide the URL to the asset.
  if (typeof (umbral as any).init === 'function') {
    // Point this to where bundler serves the .wasm file.
    // Vite/webpack-friendly URL:
    const wasmUrl = new URL('../../assets/umbral_pre.wasm', import.meta.url).toString();
    await (umbral as any).init(wasmUrl);
    return;
  }
}

export async function encapsulate(
  publicKeyHex: string,
  plaintext: Uint8Array
): Promise<{ capsule: string; ciphertext: string }> {
  try {
    // Initialize WASM module if needed
    await initUmbralWasm();

    // Deserialize public key from hex
    const pkBytes = hexToBytes(publicKeyHex);
    const publicKey = umbral.PublicKey.fromCompressedBytes(pkBytes);

    // Encrypt plaintext to the public key
    const [capsule, ciphertext] = umbral.encrypt(publicKey, plaintext);

    // Serialize to hex for storage/transmission
    return {
      capsule: bytesToHex(capsule.toBytes()),
      ciphertext: bytesToHex(ciphertext)
    };
  } catch (error) {
    console.error('Encapsulation failed:', error);
    throw new Error(`Encapsulation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Verify a public key is valid
export function isValidPublicKey(publicKeyHex: string): boolean {
  try {
    const pkBytes = hexToBytes(publicKeyHex);
    umbral.PublicKey.fromCompressedBytes(pkBytes);
    return true;
  } catch {
    return false;
  }
}

// ============ Helper Functions ============
//Convert hex string to Uint8Array
export function hexToBytes(hex: string): Uint8Array {
  // Remove 0x prefix if present
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

//Convert Uint8Array to hex string
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
