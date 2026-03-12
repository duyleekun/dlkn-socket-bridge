/**
 * Encrypted MTProto 2.0 message wrapper.
 *
 * After DH key exchange, all messages use this format:
 *
 *   [8 bytes] auth_key_id (lower 64 bits of SHA-1(auth_key))
 *   [16 bytes] msg_key (middle 128 bits of SHA-256(auth_key[88..120] + plaintext))
 *   [N bytes] encrypted_data (AES-256-IGE)
 *
 * Plaintext (before encryption):
 *   [8 bytes] server_salt
 *   [8 bytes] session_id
 *   [8 bytes] message_id
 *   [4 bytes] seq_no
 *   [4 bytes] message_data_length
 *   [N bytes] message_data
 *   [0-15 bytes] padding (12-1024 random bytes, total must be % 16 == 0)
 */

import {
  sha1,
  sha256,
  aesIgeEncrypt,
  aesIgeDecrypt,
  concatBytes,
  fromHex,
  generateNonce,
} from "./crypto";
import { generateMessageId } from "./plain-message";

/**
 * Derive AES key + IV for MTProto 2.0 encryption.
 *
 * @param authKey 256-byte auth key
 * @param msgKey 16-byte message key
 * @param isClient true for client→server (x=0), false for server→client (x=8)
 */
export function deriveAesKeyIv(
  authKey: Uint8Array,
  msgKey: Uint8Array,
  isClient: boolean,
): { aesKey: Uint8Array; aesIv: Uint8Array } {
  const x = isClient ? 0 : 8;

  const sha256a = sha256(concatBytes(msgKey, authKey.slice(x, x + 36)));
  const sha256b = sha256(concatBytes(authKey.slice(40 + x, 40 + x + 36), msgKey));

  const aesKey = concatBytes(
    sha256a.slice(0, 8),
    sha256b.slice(8, 24),
    sha256a.slice(24, 32),
  );
  const aesIv = concatBytes(
    sha256b.slice(0, 8),
    sha256a.slice(8, 24),
    sha256b.slice(24, 32),
  );

  return { aesKey, aesIv };
}

/**
 * Encrypt a message for sending to Telegram server.
 *
 * @param authKeyHex hex-encoded 256-byte auth key
 * @param saltHex hex-encoded 8-byte server salt
 * @param sessionIdHex hex-encoded 8-byte session ID
 * @param seqNo sequence number
 * @param body serialized TL object bytes
 * @param timeOffset server time offset
 * @returns Full encrypted message bytes (ready for transport framing)
 */
export function encryptMessage(
  authKeyHex: string,
  saltHex: string,
  sessionIdHex: string,
  seqNo: number,
  body: Uint8Array,
  timeOffset: number = 0,
  lastMsgId?: bigint,
): { encrypted: Uint8Array; msgId: bigint } {
  const authKey = fromHex(authKeyHex);
  const salt = fromHex(saltHex);
  const sessionId = fromHex(sessionIdHex);
  const msgId = generateMessageId(timeOffset, lastMsgId);

  // Build plaintext
  const header = new Uint8Array(8 + 8 + 8 + 4 + 4);
  const headerView = new DataView(header.buffer);
  header.set(salt, 0); // server_salt (8 bytes)
  header.set(sessionId, 8); // session_id (8 bytes)
  headerView.setBigUint64(16, msgId, true); // message_id (8 bytes LE)
  headerView.setUint32(24, seqNo, true); // seq_no (4 bytes LE)
  headerView.setUint32(28, body.length, true); // message_data_length (4 bytes LE)

  const plainNopad = concatBytes(header, body);

  // Add padding: total must be multiple of 16, padding between 12-1024 bytes
  const padNeeded = 16 - (plainNopad.length % 16);
  const padding = padNeeded < 12 ? padNeeded + 16 : padNeeded;
  const plain = concatBytes(plainNopad, generateNonce(padding));

  // Compute msg_key = middle 128 bits of SHA-256(auth_key[88..120] + plain)
  const msgKeyFull = sha256(concatBytes(authKey.slice(88, 120), plain));
  const msgKey = msgKeyFull.slice(8, 24);

  // Derive AES key + IV
  const { aesKey, aesIv } = deriveAesKeyIv(authKey, msgKey, true);

  // Encrypt
  const encrypted = aesIgeEncrypt(plain, aesKey, aesIv);

  // Compute auth_key_id = sha1(auth_key)[12..20] — the lower 8 bytes
  const authKeyIdBytes = sha1(authKey).slice(12, 20);

  // Assemble: auth_key_id + msg_key + encrypted_data
  return {
    encrypted: concatBytes(authKeyIdBytes, msgKey, encrypted),
    msgId,
  };
}

/**
 * Decrypt a message received from Telegram server.
 *
 * @param authKeyHex hex-encoded 256-byte auth key
 * @param data raw message bytes (after transport frame stripped)
 * @returns { body, msgId, seqNo, salt, sessionId }
 */
export function decryptMessage(
  authKeyHex: string,
  data: Uint8Array,
): {
  body: Uint8Array;
  msgId: bigint;
  seqNo: number;
  salt: Uint8Array;
  sessionId: Uint8Array;
} {
  if (data.length < 24) {
    throw new Error(`encrypted message too short: ${data.length} bytes`);
  }

  const authKey = fromHex(authKeyHex);
  const authKeyId = data.slice(0, 8);
  const msgKey = data.slice(8, 24);
  const encryptedData = data.slice(24);

  const expectedAuthKeyId = sha1(authKey).slice(12, 20);
  if (!authKeyId.every((value, index) => value === expectedAuthKeyId[index])) {
    throw new Error("encrypted message auth_key_id mismatch");
  }

  // Derive AES key + IV for server→client (x=8)
  const { aesKey, aesIv } = deriveAesKeyIv(authKey, msgKey, false);

  // Decrypt
  const plain = aesIgeDecrypt(encryptedData, aesKey, aesIv);
  const expectedMsgKey = sha256(concatBytes(authKey.slice(96, 128), plain)).slice(8, 24);
  if (!msgKey.every((value, index) => value === expectedMsgKey[index])) {
    throw new Error("encrypted message msg_key mismatch");
  }

  // Parse plaintext
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const salt = plain.slice(0, 8);
  const sessionId = plain.slice(8, 16);
  const msgId = view.getBigUint64(16, true);
  const seqNo = view.getUint32(24, true);
  const bodyLength = view.getUint32(28, true);
  if (bodyLength > plain.length - 32) {
    throw new Error(`encrypted message body truncated: expected ${bodyLength}, got ${plain.length - 32}`);
  }
  const body = plain.slice(32, 32 + bodyLength);

  return { body, msgId, seqNo, salt, sessionId };
}
