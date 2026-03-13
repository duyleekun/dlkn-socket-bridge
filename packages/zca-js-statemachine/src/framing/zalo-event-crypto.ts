import { inflate } from 'pako';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(keyBase64);
  return crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
}

async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer as ArrayBuffer,
      additionalData: aad.buffer as ArrayBuffer,
      tagLength: 128,
    },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
  return new Uint8Array(decrypted);
}

/**
 * Decrypt a Zalo event payload.
 *
 * @param encryptedData - the raw `data` string from the payload JSON
 * @param encryptType - encryption type (0, 1, 2, or 3)
 * @param cipherKey - base64-encoded AES-256 key (from cmd=1 subCmd=1 handshake)
 * @returns parsed JSON object
 */
export async function decryptZaloPayload(
  encryptedData: string,
  encryptType: 0 | 1 | 2 | 3,
  cipherKey: string,
): Promise<unknown> {
  switch (encryptType) {
    case 0:
      // Plain JSON
      return JSON.parse(encryptedData);

    case 1: {
      // Base64-encoded compressed JSON
      const decoded = base64ToBytes(encryptedData);
      const inflated = inflate(decoded);
      return JSON.parse(new TextDecoder().decode(inflated));
    }

    case 2:
    case 3: {
      // AES-GCM encrypted. zca-js URL-decodes encryptType 2/3 payloads first.
      const rawBytes = base64ToBytes(decodeURIComponent(encryptedData));
      const iv = rawBytes.slice(0, 16);
      const aad = rawBytes.slice(16, 32);
      const ciphertext = rawBytes.slice(32);

      const key = await importAesKey(cipherKey);
      const decrypted = await aesGcmDecrypt(key, iv, aad, ciphertext);

      // zca-js treats encryptType 3 as uncompressed, all other non-zero types as compressed.
      const payloadBytes = encryptType === 3 ? decrypted : inflate(decrypted);
      return JSON.parse(new TextDecoder().decode(payloadBytes));
    }

    default: {
      const _: never = encryptType;
      throw new Error(`Unknown Zalo encrypt type: ${_}`);
    }
  }
}
