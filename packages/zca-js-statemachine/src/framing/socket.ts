import { ThreadType, decodeEventData } from 'zca-js';
import type { TGroupMessage, TMessage } from 'zca-js';

export const ZALO_WS_CMD = {
  CIPHER_KEY: 1,
  PING: 2,
  PING_ACTIVE: 4,
  USER_MESSAGE: 501,
  USER_DELIVERY: 502,
  GET_MSG_1_1: 510,
  GET_MSG_GROUP: 511,
  GROUP_MESSAGE: 521,
  GROUP_DELIVERY: 522,
  CONTROL_EVENT: 601,
  TYPING_EVENT: 602,
  CTRL_PULL_CTRL: 603,
  CTRL_PULL_REACT: 610,
  CTRL_PULL_REACT_BIG_GR: 611,
  REACTION_EVENT: 612,
  DUPLICATE_CONNECTION: 3000,
} as const;

export const ZALO_WS_SUB_CMD = {
  DEFAULT: 0,
  CIPHER_INIT: 1,
  PING: 1,
  QUEUE_PULL: 1,
} as const;

export type ZaloWsCmd = (typeof ZALO_WS_CMD)[keyof typeof ZALO_WS_CMD];
export type ZaloWsSubCmd = (typeof ZALO_WS_SUB_CMD)[keyof typeof ZALO_WS_SUB_CMD];

const ZALO_WS_CMD_NAMES: Readonly<Record<number, string>> = {
  [ZALO_WS_CMD.CIPHER_KEY]: 'CIPHER_KEY',
  [ZALO_WS_CMD.PING]: 'PING',
  [ZALO_WS_CMD.PING_ACTIVE]: 'PING_ACTIVE',
  [ZALO_WS_CMD.USER_MESSAGE]: 'USER_MESSAGE',
  [ZALO_WS_CMD.USER_DELIVERY]: 'USER_DELIVERY',
  [ZALO_WS_CMD.GET_MSG_1_1]: 'GET_MSG_1_1',
  [ZALO_WS_CMD.GET_MSG_GROUP]: 'GET_MSG_GROUP',
  [ZALO_WS_CMD.GROUP_MESSAGE]: 'GROUP_MESSAGE',
  [ZALO_WS_CMD.GROUP_DELIVERY]: 'GROUP_DELIVERY',
  [ZALO_WS_CMD.CONTROL_EVENT]: 'CONTROL_EVENT',
  [ZALO_WS_CMD.TYPING_EVENT]: 'TYPING_EVENT',
  [ZALO_WS_CMD.CTRL_PULL_CTRL]: 'CTRL_PULL_CTRL',
  [ZALO_WS_CMD.CTRL_PULL_REACT]: 'CTRL_PULL_REACT',
  [ZALO_WS_CMD.CTRL_PULL_REACT_BIG_GR]: 'CTRL_PULL_REACT_BIG_GR',
  [ZALO_WS_CMD.REACTION_EVENT]: 'REACTION_EVENT',
  [ZALO_WS_CMD.DUPLICATE_CONNECTION]: 'DUPLICATE_CONNECTION',
};

export type DecodedWsFrame = {
  version: number;
  cmd: number;
  subCmd: number;
  payload: string;
};

export type InspectedSocketPayload = {
  wrapper: Record<string, unknown> | null;
  decrypted: { data?: Record<string, unknown> } | null;
};

export type SocketParseOptions = {
  cipherKey?: string;
};

export type SocketCipherKeyEvent = {
  type: 'cipher_key';
  key: string;
};

export type SocketDuplicateConnectionEvent = {
  type: 'duplicate_connection';
};

export type SocketFrameEvent = {
  type: 'frame';
  cmd: number;
  subCmd: number;
  payloadKind: 'decrypted' | 'wrapper' | 'raw';
  data: unknown;
};

export type ExtractedSocketMessage = {
  id: string;
  fromId: string;
  content: string;
  timestamp: number;
  msgType: string;
  isGroup: boolean;
  recovered: boolean;
};

export type SocketParsedEvent =
  | SocketCipherKeyEvent
  | SocketDuplicateConnectionEvent
  | SocketFrameEvent;

export function getZaloWsCmdName(cmd: number): string | undefined {
  return ZALO_WS_CMD_NAMES[cmd];
}

export function encodeWsFrame(version: number, cmd: number, subCmd: number, data: unknown): Uint8Array {
  const payloadStr = JSON.stringify(data);
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const buffer = new Uint8Array(4 + payloadBytes.length);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, version);
  view.setUint16(1, cmd, true);
  view.setUint8(3, subCmd);
  buffer.set(payloadBytes, 4);
  return buffer;
}

export function decodeWsFrame(bytes: Uint8Array): DecodedWsFrame {
  if (bytes.length < 4) {
    throw new Error('Invalid header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  const cmd = view.getUint16(1, true);
  const subCmd = view.getUint8(3);
  const payload = new TextDecoder().decode(bytes.slice(4));
  return { version, cmd, subCmd, payload };
}

export function buildPingFrame(): Uint8Array {
  return encodeWsFrame(1, ZALO_WS_CMD.PING, ZALO_WS_SUB_CMD.PING, {});
}

export function buildOldMessagesFrame(threadType: number, lastMessageId: string | null = null): Uint8Array {
  const isGroup = threadType === 1 || threadType === ThreadType.Group;
  return encodeWsFrame(
    1,
    isGroup ? ZALO_WS_CMD.GET_MSG_GROUP : ZALO_WS_CMD.GET_MSG_1_1,
    ZALO_WS_SUB_CMD.QUEUE_PULL,
    {
    first: true,
    lastId: lastMessageId,
    preIds: [],
    },
  );
}

export async function inspectSocketPayload(
  payload: string,
  cipherKey?: string,
): Promise<InspectedSocketPayload> {
  if (payload.length === 0) {
    return { wrapper: null, decrypted: null };
  }

  let wrapper: Record<string, unknown> | null = null;
  try {
    wrapper = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { wrapper: null, decrypted: null };
  }

  if (!cipherKey || typeof wrapper.data !== 'string') {
    return { wrapper, decrypted: null };
  }

  try {
    return {
      wrapper,
      decrypted: await decodeEventData(wrapper, cipherKey),
    };
  } catch {
    return { wrapper, decrypted: null };
  }
}

function createFrameEvent(
  cmd: number,
  subCmd: number,
  payloadKind: SocketFrameEvent['payloadKind'],
  data: unknown,
): SocketFrameEvent {
  return { type: 'frame', cmd, subCmd, payloadKind, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content == null) {
    return '';
  }
  return JSON.stringify(content);
}

function readMessageContainer(frame: SocketFrameEvent): Record<string, unknown> | null {
  if (frame.payloadKind !== 'decrypted' || !isRecord(frame.data) || !isRecord(frame.data.data)) {
    return null;
  }
  return frame.data.data;
}

export function extractSocketMessages(frame: SocketFrameEvent): ExtractedSocketMessage[] {
  const isGroup =
    frame.cmd === ZALO_WS_CMD.GROUP_MESSAGE || frame.cmd === ZALO_WS_CMD.GET_MSG_GROUP;
  const recovered =
    frame.cmd === ZALO_WS_CMD.GET_MSG_1_1 || frame.cmd === ZALO_WS_CMD.GET_MSG_GROUP;

  if (
    frame.cmd !== ZALO_WS_CMD.USER_MESSAGE &&
    frame.cmd !== ZALO_WS_CMD.GROUP_MESSAGE &&
    frame.cmd !== ZALO_WS_CMD.GET_MSG_1_1 &&
    frame.cmd !== ZALO_WS_CMD.GET_MSG_GROUP
  ) {
    return [];
  }

  const container = readMessageContainer(frame);
  if (!container) {
    return [];
  }

  const field = isGroup ? 'groupMsgs' : 'msgs';
  const messages = Array.isArray(container[field]) ? container[field] : [];

  return messages
    .filter((message): message is TMessage | TGroupMessage => isRecord(message))
    .map((message) => ({
      id: String(message.msgId ?? message.globalMsgId ?? '0'),
      fromId: String(message.uidFrom ?? ''),
      content: normalizeMessageContent(message.content),
      timestamp: Number(message.ts ?? 0),
      msgType: String(message.msgType ?? ''),
      isGroup,
      recovered,
    }));
}

export async function parseSocketFrame(
  frame: Uint8Array,
  options: SocketParseOptions = {},
): Promise<SocketParsedEvent[]> {
  let decoded: DecodedWsFrame;
  try {
    decoded = decodeWsFrame(frame);
  } catch {
    return [];
  }

  const { cmd, subCmd, payload } = decoded;
  const { wrapper: parsed, decrypted: decryptedData } = await inspectSocketPayload(
    payload,
    options.cipherKey,
  );

  if (payload.length > 0 && !parsed) {
    return [createFrameEvent(cmd, subCmd, 'raw', payload)];
  }

  if (cmd === ZALO_WS_CMD.CIPHER_KEY && subCmd === ZALO_WS_SUB_CMD.CIPHER_INIT && parsed) {
    const cipherKey =
      typeof parsed.key === 'string'
        ? parsed.key
        : typeof parsed.data === 'string'
          ? parsed.data
          : null;
    return cipherKey ? [{ type: 'cipher_key', key: cipherKey }] : [];
  }

  if (cmd === ZALO_WS_CMD.PING) {
    return [];
  }

  if (cmd === ZALO_WS_CMD.DUPLICATE_CONNECTION) {
    return [{ type: 'duplicate_connection' }];
  }

  if (!parsed) {
    return [createFrameEvent(cmd, subCmd, 'raw', payload)];
  }

  if (!options.cipherKey) {
    return [createFrameEvent(cmd, subCmd, 'wrapper', parsed)];
  }

  return [createFrameEvent(cmd, subCmd, decryptedData ? 'decrypted' : 'wrapper', decryptedData ?? parsed)];
}
