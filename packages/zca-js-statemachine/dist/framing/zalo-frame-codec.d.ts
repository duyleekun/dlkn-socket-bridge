export interface ZaloFrameHeader {
    version: number;
    cmd: number;
    subCmd: number;
}
export interface DecodedZaloFrame {
    version: number;
    cmd: number;
    subCmd: number;
    payload: string;
}
/**
 * Encode a Zalo WebSocket frame.
 * @param version - protocol version (usually 1)
 * @param cmd - command ID (UInt16LE)
 * @param subCmd - sub-command ID (UInt8)
 * @param data - payload object, serialized to UTF-8 JSON
 */
export declare function encodeFrame(version: number, cmd: number, subCmd: number, data: object): Uint8Array;
/**
 * Decode a Zalo WebSocket frame.
 */
export declare function decodeFrame(bytes: Uint8Array): DecodedZaloFrame;
/**
 * Build a PING frame (cmd=2, subCmd=1).
 */
export declare function buildPingFrame(): Uint8Array;
//# sourceMappingURL=zalo-frame-codec.d.ts.map