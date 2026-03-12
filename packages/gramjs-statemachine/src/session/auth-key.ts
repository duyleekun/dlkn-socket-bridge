import { createHash } from 'node:crypto';
import { AuthKey } from 'telegram/crypto/AuthKey.js';

export interface GramJsAuthKeyMaterial {
  authKey: AuthKey;
  keyIdBytes: Uint8Array;
}

/**
 * Build GramJS AuthKey metadata from raw auth-key bytes without introducing an
 * extra async step into the state machine.
 */
export function createGramJsAuthKey(
  authKeyBytes: Uint8Array,
): GramJsAuthKeyMaterial {
  const hash = createHash('sha1').update(Buffer.from(authKeyBytes)).digest();
  return {
    authKey: new AuthKey(Buffer.from(authKeyBytes), hash),
    keyIdBytes: new Uint8Array(hash.subarray(12, 20)),
  };
}
