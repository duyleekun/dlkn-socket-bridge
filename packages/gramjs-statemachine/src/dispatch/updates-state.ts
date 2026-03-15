import type { SessionEvent } from '../types/session-event.js';
import { parseRpcResultFrame } from './inbound-dispatch.js';

export type TelegramUpdatesStateSource =
  | 'getState'
  | 'getDifference'
  | 'inboundUpdate';

export interface TelegramUpdatesState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
  updatedAt: number;
  source?: TelegramUpdatesStateSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function mergeUpdatesState(
  current: TelegramUpdatesState | null,
  partial: Partial<Pick<TelegramUpdatesState, 'pts' | 'qts' | 'date' | 'seq'>>,
  source: TelegramUpdatesStateSource,
  updatedAt: number,
): TelegramUpdatesState | null {
  const pts = partial.pts ?? current?.pts;
  const qts = partial.qts ?? current?.qts;
  const date = partial.date ?? current?.date;
  const seq = partial.seq ?? current?.seq;

  if (
    pts === undefined
    || qts === undefined
    || date === undefined
    || seq === undefined
  ) {
    return null;
  }

  return {
    pts: current ? Math.max(current.pts, pts) : pts,
    qts: current ? Math.max(current.qts, qts) : qts,
    date: current ? Math.max(current.date, date) : date,
    seq: current ? Math.max(current.seq, seq) : seq,
    updatedAt,
    source,
  };
}

function stateFromUpdatesStateRecord(
  value: unknown,
  source: TelegramUpdatesStateSource,
  current: TelegramUpdatesState | null,
  updatedAt: number,
): TelegramUpdatesState | null {
  const record = asRecord(value);
  if (!record || record.className !== 'updates.State') {
    return null;
  }
  return mergeUpdatesState(
    current,
    {
      pts: readNumber(record.pts),
      qts: readNumber(record.qts),
      date: readNumber(record.date),
      seq: readNumber(record.seq),
    },
    source,
    updatedAt,
  );
}

function stateFromDifferenceResult(
  value: unknown,
  current: TelegramUpdatesState | null,
  updatedAt: number,
): TelegramUpdatesState | null {
  const record = asRecord(value);
  if (!record || typeof record.className !== 'string') {
    return null;
  }

  switch (record.className) {
    case 'updates.Difference':
      return stateFromUpdatesStateRecord(
        record.state,
        'getDifference',
        current,
        updatedAt,
      );

    case 'updates.DifferenceSlice':
      return stateFromUpdatesStateRecord(
        record.intermediateState,
        'getDifference',
        current,
        updatedAt,
      );

    case 'updates.DifferenceEmpty':
      return mergeUpdatesState(
        current,
        {
          date: readNumber(record.date),
          seq: readNumber(record.seq),
        },
        'getDifference',
        updatedAt,
      );

    case 'updates.DifferenceTooLong':
      return mergeUpdatesState(
        current,
        {
          pts: readNumber(record.pts),
        },
        'getDifference',
        updatedAt,
      );

    default:
      return null;
  }
}

function stateFromUpdateEnvelope(
  value: unknown,
  current: TelegramUpdatesState | null,
  updatedAt: number,
): TelegramUpdatesState | null {
  const record = asRecord(value);
  if (!record || typeof record.className !== 'string') {
    return null;
  }

  switch (record.className) {
    case 'Updates':
    case 'UpdatesCombined':
      return mergeUpdatesState(
        current,
        {
          date: readNumber(record.date),
          seq: readNumber(record.seq),
        },
        'inboundUpdate',
        updatedAt,
      );

    case 'UpdateShortMessage':
    case 'UpdateShortChatMessage':
    case 'UpdateShortSentMessage':
      return mergeUpdatesState(
        current,
        {
          pts: readNumber(record.pts),
          date: readNumber(record.date),
        },
        'inboundUpdate',
        updatedAt,
      );

    default:
      return null;
  }
}

export function buildTelegramGetDifferenceParams(
  updatesState: Pick<TelegramUpdatesState, 'pts' | 'date' | 'qts'>,
): {
  pts: number;
  date: number;
  qts: number;
} {
  return {
    pts: updatesState.pts,
    date: updatesState.date,
    qts: updatesState.qts,
  };
}

export async function extractTelegramUpdatesState(
  event: SessionEvent,
  current: TelegramUpdatesState | null,
  opts: { updatedAt?: number } = {},
): Promise<TelegramUpdatesState | null> {
  const updatedAt = opts.updatedAt ?? Date.now();
  const rpc = await parseRpcResultFrame(event.object, {
    requestName: event.requestName,
  });
  if (rpc && !rpc.error) {
    switch (rpc.requestName) {
      case 'updates.GetState':
        return stateFromUpdatesStateRecord(
          rpc.result,
          'getState',
          current,
          updatedAt,
        );

      case 'updates.GetDifference':
        return stateFromDifferenceResult(rpc.result, current, updatedAt);

      default:
        break;
    }
  }

  return stateFromUpdateEnvelope(event.object, current, updatedAt);
}
