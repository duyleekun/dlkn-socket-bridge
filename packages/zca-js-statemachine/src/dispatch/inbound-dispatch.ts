import { decodeFrame } from '../framing/zalo-frame-codec.js';
import { decryptZaloPayload } from '../framing/zalo-event-crypto.js';
import type { ZaloSerializedState } from '../types/state.js';
import type { ZaloSessionCommand } from '../types/session-command.js';
import type { ZaloSessionEvent, ZaloIncomingMessage } from '../types/session-event.js';

export interface DispatchResult {
  commands: ZaloSessionCommand[];
  events: ZaloSessionEvent[];
  nextContext: ZaloSerializedState;
}

interface ZaloPayload {
  data: string;
  encrypt?: 0 | 1 | 2 | 3;
  [key: string]: unknown;
}

interface ZaloSocketMessage {
  msgId?: unknown;
  cliMsgId?: unknown;
  globalMsgId?: unknown;
  msgType?: unknown;
  uidFrom?: unknown;
  idTo?: unknown;
  ts?: unknown;
  content?: unknown;
  attach?: unknown[];
}

interface DecodedEventEnvelope {
  data?: {
    msgs?: ZaloSocketMessage[];
    groupMsgs?: ZaloSocketMessage[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content == null) {
    return '';
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toIncomingMessage(
  msg: ZaloSocketMessage,
  threadType: number,
  recovered: boolean = false,
): ZaloIncomingMessage {
  const fromId = String(msg.uidFrom ?? '');
  const toId = String(msg.idTo ?? '');
  return {
    id: String(msg.msgId ?? msg.globalMsgId ?? Date.now()),
    threadId: threadType === 1 ? toId : fromId === '0' ? toId : fromId,
    threadType,
    fromId,
    content: normalizeMessageContent(msg.content),
    attachments: Array.isArray(msg.attach) ? msg.attach : [],
    timestamp: Number(msg.ts ?? Date.now()),
    msgType: String(msg.msgType ?? ''),
    recovered,
  };
}

export async function dispatchInboundFrame(
  context: ZaloSerializedState,
  frame: Uint8Array,
): Promise<DispatchResult> {
  const commands: ZaloSessionCommand[] = [];
  const events: ZaloSessionEvent[] = [];
  let nextContext = context;

  let decoded: ReturnType<typeof decodeFrame>;
  try {
    decoded = decodeFrame(frame);
  } catch (err) {
    console.warn('[zalo-dispatch] failed to decode frame:', err);
    return { commands, events, nextContext };
  }

  const { cmd, subCmd } = decoded;

  let parsedPayload: ZaloPayload | null = null;
  try {
    parsedPayload = JSON.parse(decoded.payload) as ZaloPayload;
  } catch {
    // payload may be empty for some cmds
  }

  // cmd=1 subCmd=1: cipher key exchange
  if (cmd === 1 && subCmd === 1 && parsedPayload) {
    const directKey = typeof parsedPayload.key === 'string' ? parsedPayload.key : null;
    const dataKey = typeof parsedPayload.data === 'string' ? parsedPayload.data : null;
    const cipherKey = directKey ?? dataKey;
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

  const encryptType = (parsedPayload.encrypt ?? 0) as 0 | 1 | 2 | 3;

  let decryptedData: unknown;
  try {
    decryptedData = await decryptZaloPayload(parsedPayload.data, encryptType, context.cipherKey);
  } catch (err) {
    console.warn(`[zalo-dispatch] decrypt failed cmd=${cmd}:`, err);
    return { commands, events, nextContext };
  }

  const eventData = (decryptedData as DecodedEventEnvelope | undefined)?.data;

  // cmd=501, cmd=521: incoming message
  if (cmd === 501 || cmd === 521) {
    const threadType = cmd === 521 ? 1 : 0;
    const messages = cmd === 521 ? eventData?.groupMsgs : eventData?.msgs;
    for (const msg of messages ?? []) {
      events.push({ type: 'message', message: toIncomingMessage(msg, threadType) });
    }
    return { commands, events, nextContext };
  }

  // cmd=510, cmd=511: recovered old messages
  if (cmd === 510 || cmd === 511) {
    const threadType = cmd === 511 ? 1 : 0;
    const messages = cmd === 511 ? eventData?.groupMsgs : eventData?.msgs;
    for (const msg of messages ?? []) {
      events.push({
        type: 'message',
        message: toIncomingMessage(msg, threadType, true),
      });
    }
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
