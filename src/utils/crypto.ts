
export async function generateAesKey(): Promise<CryptoKey> {
  return window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encryptFile(file: File, key: CryptoKey) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const fileBuffer = await file.arrayBuffer();

  const encryptedContent = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, fileBuffer);

  return {
    encryptedBlob: new Blob([iv, encryptedContent]),
    iv
  };
}

export async function decryptFile(encryptedBlob: Blob, key: CryptoKey) {
  const buffer = await encryptedBlob.arrayBuffer();
  const iv = buffer.slice(0, 12);
  const data = buffer.slice(12);

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    data
  );

  return new Blob([decryptedBuffer]);
}

// 2. Export AES Key to Raw Bytes (for Umbrella Encapsulation)
export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  const exported = await window.crypto.subtle.exportKey("raw", key);
  return new Uint8Array(exported);
}


// --- SECURE CHANNEL UTILITIES ---

/**
 * Generate an ephemeral ECDH key pair (P-256).
 */
export async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  return window.crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true, // extractable (need to send public key)
    ["deriveKey", "deriveBits"]
  );
}

/**
 * Derive a shared AES-GCM session key using ECDH + HKDF.
 * 
 * @param privateKey The client's ephemeral private key
 * @param peerPublicKeyRaw The enclave's ephemeral public key (raw bytes)
 */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKeyRaw: Uint8Array
): Promise<CryptoKey> {
  // 1. Import Peer Public Key
  const peerPublicKey = await window.crypto.subtle.importKey(
    "raw",
    peerPublicKeyRaw as any,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // 2. Derive Shared Secret (ECDH)
  const sharedSecret = await window.crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: peerPublicKey,
    },
    privateKey,
    256 // 256 bits
  );

  // 3. Derive Session Key (HKDF)
  const hkdfKey = await window.crypto.subtle.importKey(
    "raw",
    sharedSecret as any,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  const sessionKey = await window.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0), // Empty salt
      info: new TextEncoder().encode("distributed-data-management-secure-channel"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"] // Only used to decrypt the response
  );

  return sessionKey;
}

/**
 * Decrypt the enclave's response using the shared session key.
 */
export async function decryptResponse(
  encryptedDataHex: string,
  ivHex: string,
  sessionKey: CryptoKey
): Promise<Uint8Array> {
  const encryptedData = new Uint8Array(
    encryptedDataHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );
  const iv = new Uint8Array(
    ivHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );

  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    sessionKey,
    encryptedData as any
  );

  return new Uint8Array(decrypted);
}