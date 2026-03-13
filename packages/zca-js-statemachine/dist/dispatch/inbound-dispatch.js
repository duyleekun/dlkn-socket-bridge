import { decodeFrame } from '../framing/zalo-frame-codec.js';
import { decryptZaloPayload } from '../framing/zalo-event-crypto.js';
export async function dispatchInboundFrame(context, frame) {
    const commands = [];
    const events = [];
    let nextContext = context;
    let decoded;
    try {
        decoded = decodeFrame(frame);
    }
    catch (err) {
        console.warn('[zalo-dispatch] failed to decode frame:', err);
        return { commands, events, nextContext };
    }
    const { cmd, subCmd } = decoded;
    let parsedPayload = null;
    try {
        parsedPayload = JSON.parse(decoded.payload);
    }
    catch {
        // payload may be empty for some cmds
    }
    // cmd=1 subCmd=1: cipher key exchange
    if (cmd === 1 && subCmd === 1 && parsedPayload) {
        const keyData = parsedPayload.data;
        let cipherKey = null;
        if (typeof keyData === 'string') {
            try {
                const parsed = JSON.parse(keyData);
                cipherKey = parsed.key ?? null;
            }
            catch {
                // data is the key directly
                cipherKey = keyData;
            }
        }
        else if (typeof keyData === 'object' && keyData.key) {
            cipherKey = keyData.key;
        }
        if (cipherKey) {
            nextContext = { ...context, cipherKey };
        }
        return { commands, events, nextContext };
    }
    // cmd=2: ping/pong — ignore
    if (cmd === 2) {
        return { commands, events, nextContext };
    }
    // cmd=3000: duplicate connection — fatal
    if (cmd === 3000) {
        events.push({ type: 'update', data: { duplicateConnection: true } });
        return { commands, events, nextContext };
    }
    // For all other cmds that carry encrypted event data
    if (!parsedPayload || !context.cipherKey) {
        return { commands, events, nextContext };
    }
    const encryptType = (parsedPayload.encrypt ?? 0);
    let decryptedData;
    try {
        decryptedData = await decryptZaloPayload(parsedPayload.data, encryptType, context.cipherKey);
    }
    catch (err) {
        console.warn(`[zalo-dispatch] decrypt failed cmd=${cmd}:`, err);
        return { commands, events, nextContext };
    }
    // cmd=501, cmd=521: incoming message
    if (cmd === 501 || cmd === 521) {
        const msgData = decryptedData;
        const message = {
            id: String(msgData.msgId ?? msgData.globalMsgId ?? Date.now()),
            threadId: String(msgData.cliMsgId ?? msgData.threadId ?? ''),
            threadType: Number(msgData.msgType ?? 0),
            fromId: String(msgData.uidFrom ?? ''),
            content: String(msgData.content ?? ''),
            attachments: msgData.attach ?? [],
            timestamp: Number(msgData.ts ?? Date.now()),
            msgType: String(msgData.msgType ?? ''),
        };
        events.push({ type: 'message', message });
        return { commands, events, nextContext };
    }
    // cmd=601: group/friend event
    if (cmd === 601) {
        events.push({ type: 'group_event', data: decryptedData });
        return { commands, events, nextContext };
    }
    // cmd=612: reaction
    if (cmd === 612) {
        events.push({ type: 'reaction', data: decryptedData });
        return { commands, events, nextContext };
    }
    // Unknown cmd — emit as generic update
    events.push({ type: 'update', data: { cmd, subCmd, data: decryptedData } });
    return { commands, events, nextContext };
}
//# sourceMappingURL=inbound-dispatch.js.map