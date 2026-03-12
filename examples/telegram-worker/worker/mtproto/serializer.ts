/**
 * TL (Type Language) serialization/deserialization using gramjs internals.
 *
 * We use `telegram` (gramjs) only as a library for:
 *   - Constructing TL objects (Api.*)
 *   - Serializing to bytes (getBytes())
 *   - Deserializing from bytes (BinaryReader)
 *
 * No TelegramClient, no Connection, no socket management.
 */

// gramjs TL layer — the full API schema
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { Api } from "telegram/tl";
import { BinaryReader } from "telegram/extensions";

export { Api };

/** Serialize a TL object to bytes. */
export function serializeTLObject(obj: { getBytes(): Buffer }): Uint8Array {
  return new Uint8Array(obj.getBytes());
}

/**
 * Deserialize a TL response from raw bytes.
 * Returns a gramjs Api object.
 */
export async function deserializeTLResponse(data: Uint8Array): Promise<unknown> {
  const reader = new BinaryReader(Buffer.from(data));
  return Promise.resolve(reader.tgReadObject());
}

/**
 * Read a TL object from a BinaryReader — useful when you need
 * to control the reader position (e.g., reading inner_data from
 * decrypted DH params).
 */
export async function readTLObject(reader: InstanceType<typeof BinaryReader>): Promise<unknown> {
  return Promise.resolve(reader.tgReadObject());
}

/** Create a new BinaryReader from raw bytes. */
export function createReader(data: Uint8Array): InstanceType<typeof BinaryReader> {
  return new BinaryReader(Buffer.from(data));
}
