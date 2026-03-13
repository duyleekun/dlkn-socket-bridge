/**
 * Encode a Zalo WebSocket frame.
 * @param version - protocol version (usually 1)
 * @param cmd - command ID (UInt16LE)
 * @param subCmd - sub-command ID (UInt8)
 * @param data - payload object, serialized to UTF-8 JSON
 */
export function encodeFrame(version, cmd, subCmd, data) {
    const payloadStr = JSON.stringify(data);
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const buffer = new Uint8Array(4 + payloadBytes.length);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, version);
    view.setUint16(1, cmd, true); // little endian
    view.setUint8(3, subCmd);
    buffer.set(payloadBytes, 4);
    return buffer;
}
/**
 * Decode a Zalo WebSocket frame.
 */
export function decodeFrame(bytes) {
    if (bytes.length < 4) {
        throw new Error(`Zalo frame too short: ${bytes.length} bytes`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(0);
    const cmd = view.getUint16(1, true); // little endian
    const subCmd = view.getUint8(3);
    const payload = new TextDecoder().decode(bytes.slice(4));
    return { version, cmd, subCmd, payload };
}
/**
 * Build a PING frame (cmd=2, subCmd=1).
 */
export function buildPingFrame() {
    return encodeFrame(1, 2, 1, {});
}
//# sourceMappingURL=zalo-frame-codec.js.map