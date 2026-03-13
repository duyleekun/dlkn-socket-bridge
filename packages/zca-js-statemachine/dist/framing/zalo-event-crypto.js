import { inflate } from 'pako';
function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
async function importAesKey(keyBase64) {
    const keyBytes = base64ToBytes(keyBase64);
    return crypto.subtle.importKey('raw', keyBytes.buffer, { name: 'AES-GCM' }, false, ['decrypt']);
}
async function aesGcmDecrypt(key, iv, aad, ciphertext) {
    const decrypted = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: iv.buffer,
        additionalData: aad.buffer,
        tagLength: 128,
    }, key, ciphertext.buffer);
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
export async function decryptZaloPayload(encryptedData, encryptType, cipherKey) {
    switch (encryptType) {
        case 0:
            // Plain JSON
            return JSON.parse(encryptedData);
        case 1: {
            // Base64-encoded JSON
            const bytes = base64ToBytes(encryptedData);
            return JSON.parse(new TextDecoder().decode(bytes));
        }
        case 2:
        case 3: {
            // AES-GCM encrypted
            const rawBytes = base64ToBytes(encryptedData);
            const iv = rawBytes.slice(0, 16);
            const aad = rawBytes.slice(16, 32);
            const ciphertext = rawBytes.slice(32);
            const key = await importAesKey(cipherKey);
            const decrypted = await aesGcmDecrypt(key, iv, aad, ciphertext);
            if (encryptType === 2) {
                // Inflate compressed data
                const inflated = inflate(decrypted);
                return JSON.parse(new TextDecoder().decode(inflated));
            }
            else {
                // No compression
                return JSON.parse(new TextDecoder().decode(decrypted));
            }
        }
        default: {
            const _ = encryptType;
            throw new Error(`Unknown Zalo encrypt type: ${_}`);
        }
    }
}
//# sourceMappingURL=zalo-event-crypto.js.map