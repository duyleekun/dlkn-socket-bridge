import { buildPingFrame } from '../framing/zalo-frame-codec.js';
/**
 * Build a PING frame to send as keepalive (cmd=2, subCmd=1).
 */
export function buildPingFrameBytes() {
    return buildPingFrame();
}
//# sourceMappingURL=login-steps.js.map