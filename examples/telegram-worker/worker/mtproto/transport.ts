/**
 * MTProto Intermediate Transport framing.
 *
 * The bridge uses the "intermediate" transport:
 *   - On connect, bridge auto-sends 0xeeeeeeee
 *   - Each message is framed as: [4-byte LE length][payload]
 *   - The callback delivers the full frame (4-byte header + payload)
 *
 * On send, we must prepend the 4-byte LE length header.
 * On receive, the bridge already framed it — we strip the header.
 */

/** Wrap a payload with a 4-byte LE length prefix for intermediate transport. */
export function wrapTransportFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, true); // little-endian
  frame.set(payload, 4);
  return frame;
}

/** Strip the 4-byte LE length prefix from a bridge callback frame. */
export function stripTransportFrame(frame: Uint8Array): Uint8Array {
  if (frame.length < 4) {
    throw new Error(`transport frame too short: ${frame.length} bytes`);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getUint32(0, true);

  // Quick ack: high bit set, only 4 bytes total
  if ((length & 0x80000000) !== 0) {
    return frame.slice(0, 4);
  }

  if (frame.length < 4 + length) {
    throw new Error(
      `transport frame truncated: expected ${4 + length}, got ${frame.length}`,
    );
  }
  return frame.slice(4, 4 + length);
}

/** Check if a frame is a quick ack (high bit set in length field). */
export function isQuickAck(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return (view.getUint32(0, true) & 0x80000000) !== 0;
}
