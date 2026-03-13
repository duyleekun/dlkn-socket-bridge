/**
 * Decrypt a Zalo event payload.
 *
 * @param encryptedData - the raw `data` string from the payload JSON
 * @param encryptType - encryption type (0, 1, 2, or 3)
 * @param cipherKey - base64-encoded AES-256 key (from cmd=1 subCmd=1 handshake)
 * @returns parsed JSON object
 */
export declare function decryptZaloPayload(encryptedData: string, encryptType: 0 | 1 | 2 | 3, cipherKey: string): Promise<unknown>;
//# sourceMappingURL=zalo-event-crypto.d.ts.map