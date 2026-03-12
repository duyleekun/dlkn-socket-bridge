/**
 * Unencrypted (plain) MTProto message wrapper.
 *
 * Used during DH key exchange (auth phase) before auth_key is established.
 *
 * Format:
 *   [8 bytes] auth_key_id = 0 (unencrypted)
 *   [8 bytes] message_id  (unique, time-based)
 *   [4 bytes] message_data_length
 *   [N bytes] message_data (the TL-serialized body)
 */

/** Generate a GramJS-compatible message_id based on current time + offset. */
export function generateMessageId(
  timeOffset: number = 0,
  previousMsgId?: bigint,
): bigint {
  const now = Date.now() / 1000 + timeOffset;
  const seconds = Math.floor(now);
  const nanoseconds = Math.floor((now - seconds) * 1e9);

  let msgId = (BigInt(seconds) << 32n) | (BigInt(nanoseconds) << 2n);
  if (previousMsgId !== undefined && previousMsgId >= msgId) {
    msgId = previousMsgId + 4n;
  }
  return msgId;
}

/**
 * Wrap a TL body into an unencrypted MTProto message.
 *
 * @param body Serialized TL object bytes
 * @param timeOffset Server time offset in seconds
 * @returns The full unencrypted message bytes
 */
export function wrapPlainMessage(
  body: Uint8Array,
  timeOffset: number = 0,
  previousMsgId?: bigint,
): { message: Uint8Array; msgId: bigint } {
  const msgId = generateMessageId(timeOffset, previousMsgId);
  const result = new Uint8Array(8 + 8 + 4 + body.length);
  const view = new DataView(result.buffer);

  // auth_key_id = 0 (8 bytes, all zeros — already default)
  // message_id (8 bytes, little-endian)
  view.setBigUint64(8, msgId, true);
  // message_data_length (4 bytes, little-endian)
  view.setUint32(16, body.length, true);
  // body
  result.set(body, 20);

  return { message: result, msgId };
}

/**
 * Unwrap an unencrypted MTProto message.
 *
 * @param data Raw message bytes (after transport frame is stripped)
 * @returns { msgId, body }
 */
export function unwrapPlainMessage(
  data: Uint8Array,
): { msgId: bigint; body: Uint8Array } {
  if (data.length < 20) {
    throw new Error(`plain message too short: ${data.length} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Verify auth_key_id = 0
  const authKeyId = view.getBigUint64(0, true);
  if (authKeyId !== 0n) {
    throw new Error(`expected unencrypted message (auth_key_id=0), got ${authKeyId}`);
  }

  const msgId = view.getBigUint64(8, true);
  const bodyLength = view.getUint32(16, true);

  if (data.length < 20 + bodyLength) {
    throw new Error(
      `plain message body truncated: expected ${bodyLength}, available ${data.length - 20}`,
    );
  }

  const body = data.slice(20, 20 + bodyLength);
  return { msgId, body };
}
