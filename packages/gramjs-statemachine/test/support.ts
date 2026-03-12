import { Api } from 'telegram/tl/index.js';
import { BinaryReader } from 'telegram/extensions/index.js';
import { stripTransportFrame } from '../src/framing/intermediate-codec.js';
import { unwrapPlainMessage } from '../src/framing/plain-message.js';

export const FIXED_NOW_MS = 1_700_000_000_000;
export const FIXED_RESPQ_HEX =
  '640000000000000000000000015485c79283b2695000000063241605f05bf2edeb565a2f7149877399a10b8dc2a74ba9ac120c709f7d942803727959082d5eacb6daa4b2e500000015c4b51c0300000085fd64de851d9dd0a5b7f709355fc30b216be86c022bb4c3';

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function withFixedNow<T>(run: () => T | Promise<T>): T | Promise<T> {
  const OriginalDate = Date;
  class FixedDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(args.length > 0 ? args[0] : FIXED_NOW_MS);
    }

    static now(): number {
      return FIXED_NOW_MS;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.Date = FixedDate as any;
  const result = run();
  if (
    typeof result === 'object' &&
    result !== null &&
    'then' in result &&
    typeof result.then === 'function'
  ) {
    return (result as Promise<T>).finally(() => {
      globalThis.Date = OriginalDate;
    });
  }
  globalThis.Date = OriginalDate;
  return result;
}

export function parseFixedResPq(): InstanceType<typeof Api.ResPQ> {
  const stripped = stripTransportFrame(fromHex(FIXED_RESPQ_HEX));
  const { body } = unwrapPlainMessage(stripped);
  const reader = new BinaryReader(Buffer.from(body));
  return reader.tgReadObject() as InstanceType<typeof Api.ResPQ>;
}

export async function parsePlainBodyObject<T>(outbound: Uint8Array): Promise<T> {
  const stripped = stripTransportFrame(outbound);
  const { body } = unwrapPlainMessage(stripped);
  const reader = new BinaryReader(Buffer.from(body));
  return await Promise.resolve(reader.tgReadObject()) as T;
}

export function makeRandomStream(
  source: Uint8Array,
  startOffset: number,
): (size: number) => Uint8Array {
  let offset = startOffset;
  return (size: number) => {
    const slice = source.slice(offset, offset + size);
    if (slice.length !== size) {
      throw new Error(`random stream underflow at offset ${offset}: wanted ${size}, got ${slice.length}`);
    }
    offset += size;
    return slice;
  };
}
