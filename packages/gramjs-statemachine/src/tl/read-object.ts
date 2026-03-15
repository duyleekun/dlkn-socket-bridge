import { BinaryReader } from 'telegram/extensions/index.js';

function getTlObjectClassName(value: unknown): string | undefined {
  const direct = (value as { className?: string } | null)?.className;
  if (direct) return direct;
  const ctorName = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
  if (ctorName && ctorName !== 'Object') return ctorName.replace(/^_+/, '');
  return undefined;
}

function isGzipped(value: unknown): value is { data: Buffer | Uint8Array } {
  return getTlObjectClassName(value) === 'GZIPPacked';
}

export async function readTlObject(bytes: Uint8Array | Buffer): Promise<unknown> {
  const reader = new BinaryReader(Buffer.from(bytes));
  return Promise.resolve(reader.tgReadObject());
}

export async function unwrapTlObject(value: unknown): Promise<unknown> {
  let current = value;
  while (isGzipped(current)) {
    current = await readTlObject(current.data);
  }
  return current;
}

export async function readTlObjectUnwrapped(
  bytes: Uint8Array | Buffer,
): Promise<unknown> {
  return unwrapTlObject(await readTlObject(bytes));
}
