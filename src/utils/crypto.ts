export async function generateAesKey(): Promise<CryptoKey> {
    return window.crypto.subtle.generateKey(
        {name: "AES-GCM", length: 256},
        true,
        ["encrypt", "decrypt"]
    );
}

export async function encryptFile(file:File, key: CryptoKey) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const fileBuffer = await file.arrayBuffer();

    const encryptedContent = await window.crypto.subtle.encrypt({name: "AES-GCM", iv: iv}, key, fileBuffer);

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