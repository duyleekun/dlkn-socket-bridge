import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bigInt from 'big-integer';
import { AuthKey } from 'telegram/crypto/AuthKey.js';
import { BinaryReader } from 'telegram/extensions/index.js';
import { Api } from 'telegram/tl/index.js';
import { doAuthentication } from 'telegram/network/Authenticator.js';
import { Factorizator } from 'telegram/crypto/Factorizator.js';
import { getByteArray, generateKeyDataFromNonce, sha1 } from 'telegram/Helpers.js';
import { buildReqDhParams } from '../src/dh/dh-step2-server-dh.js';
import { buildSetClientDhParams } from '../src/dh/dh-step3-client-dh.js';
import { createInitialState } from '../src/types/state.js';
import { aesIgeDecrypt, aesIgeEncrypt } from '../src/session/crypto.js';
import { bigIntFromBytesBE, bigIntFromBytesLE } from '../src/session/bigint-helpers.js';
import type { SerializedState } from '../src/types/state.js';
import {
  FIXED_NOW_MS,
  makeRandomStream,
  parseFixedResPq,
  parsePlainBodyObject,
  withFixedNow,
} from './support.js';

const require = createRequire(import.meta.url);
const helpersModule = require('telegram/Helpers.js') as {
  generateRandomBytes: (count: number) => Buffer;
};

const NULL_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  canSend() {
    return false;
  },
};

function withPatchedRandomBytes<T>(
  source: Uint8Array,
  run: () => Promise<T>,
): Promise<T> {
  const original = helpersModule.generateRandomBytes;
  let offset = 0;
  const patched = (count: number): Buffer => {
    const slice = source.slice(offset, offset + count);
    if (slice.length !== count) {
      throw new Error(`random source underflow: wanted ${count}, have ${slice.length}`);
    }
    offset += count;
    return Buffer.from(slice);
  };

  helpersModule.generateRandomBytes = patched;
  return run().finally(() => {
    helpersModule.generateRandomBytes = original;
  });
}

class FakeAuthenticatorSender {
  requests: unknown[] = [];

  constructor(
    private readonly resPqTemplate: InstanceType<typeof Api.ResPQ>,
    private readonly encryptedAnswer: Uint8Array,
    private readonly newNonceHash1: ReturnType<typeof bigInt>,
  ) {}

  async send(request: unknown): Promise<unknown> {
    this.requests.push(request);

    if (request instanceof Api.ReqPqMulti) {
      return new Api.ResPQ({
        nonce: request.nonce,
        serverNonce: this.resPqTemplate.serverNonce,
        pq: this.resPqTemplate.pq,
        serverPublicKeyFingerprints: this.resPqTemplate.serverPublicKeyFingerprints,
      });
    }

    if (request instanceof Api.ReqDHParams) {
      return new Api.ServerDHParamsOk({
        nonce: request.nonce,
        serverNonce: request.serverNonce,
        encryptedAnswer: Buffer.from(this.encryptedAnswer),
      });
    }

    if (request instanceof Api.SetClientDHParams) {
      return new Api.DhGenOk({
        nonce: request.nonce,
        serverNonce: request.serverNonce,
        newNonceHash1: this.newNonceHash1,
      });
    }

    throw new Error(`Unexpected request ${(request as { className?: string } | null)?.className ?? typeof request}`);
  }
}

describe('GramJS Authenticator characterization', () => {
  it('stock Authenticator step 2 and step 3 match our builders under fixed entropy', async () => {
    const resPqTemplate = parseFixedResPq();
    const randomSource = Uint8Array.from(
      Array.from({ length: 1024 }, (_, index) => (index + 1) & 0xff),
    );
    const nonceBytes = randomSource.slice(0, 16);
    const newNonceBytes = randomSource.slice(16, 48);

    const pqInt = bigIntFromBytesBE(new Uint8Array(resPqTemplate.pq as Buffer));
    const { p, q } = Factorizator.factorize(pqInt);
    const nonceBig = bigIntFromBytesBE(nonceBytes);
    const pqInner = new Api.PQInnerData({
      pq: resPqTemplate.pq,
      p: getByteArray(p),
      q: getByteArray(q),
      nonce: nonceBig,
      serverNonce: resPqTemplate.serverNonce,
      newNonce: bigIntFromBytesLE(newNonceBytes),
    });
    const pqInnerLength = pqInner.getBytes().length;
    const paddingLength = 192 - pqInnerLength;
    const step2RandomOffset = 48;
    const step3RandomOffset = step2RandomOffset + paddingLength + 32;
    const step3RandomBytes = randomSource.slice(step3RandomOffset, step3RandomOffset + 256);

    const dhPrime = bigInt(257);
    const g = bigInt(3);
    const a = bigInt(5);
    const gA = g.modPow(a, dhPrime);
    const serverNonce = resPqTemplate.serverNonce;
    const newNonce = bigIntFromBytesLE(newNonceBytes);
    const { key, iv } = await generateKeyDataFromNonce(serverNonce, newNonce);
    const serverTime = Math.floor(FIXED_NOW_MS / 1000) + 123;
    const serverDhInner = new Api.ServerDHInnerData({
      nonce: nonceBig,
      serverNonce,
      g: g.toJSNumber(),
      dhPrime: getByteArray(dhPrime),
      gA: getByteArray(gA),
      serverTime,
    });
    const serverDhInnerBytes = Buffer.from(serverDhInner.getBytes());
    const serverDhInnerHash = await sha1(serverDhInnerBytes);
    const serverDhPayload = Buffer.concat([serverDhInnerHash, serverDhInnerBytes]);
    const serverDhPadding = Buffer.alloc((16 - (serverDhPayload.length % 16)) % 16);
    const encryptedAnswer = aesIgeEncrypt(
      new Uint8Array(Buffer.concat([serverDhPayload, serverDhPadding])),
      new Uint8Array(key),
      new Uint8Array(iv),
    );
    const bBig = bigIntFromBytesBE(step3RandomBytes);
    const authKeyBig = gA.modPow(bBig, dhPrime);
    const authKeyBytes = getByteArray(authKeyBig);
    const authKey = new AuthKey(
      Buffer.from(authKeyBytes),
      await sha1(Buffer.from(authKeyBytes)),
    );
    const newNonceHash1 = await authKey.calcNewNonceHash(newNonce, 1);

    const sender = new FakeAuthenticatorSender(resPqTemplate, encryptedAnswer, newNonceHash1);

    await withFixedNow(() =>
      withPatchedRandomBytes(randomSource, async () => {
        await doAuthentication(sender as never, NULL_LOGGER);
      }),
    );

    assert.equal(sender.requests.length, 3);
    const authReqDh = sender.requests[1] as InstanceType<typeof Api.ReqDHParams>;
    const authSetDh = sender.requests[2] as InstanceType<typeof Api.SetClientDHParams>;

    const initialState: SerializedState = {
      ...createInitialState({
        apiId: '12345',
        apiHash: '0123456789abcdef0123456789abcdef',
        dcMode: 'production',
        dcId: 2,
        dcIp: '149.154.167.50',
        dcPort: 443,
      }),
      phase: 'PQ_SENT',
      dhNonce: Buffer.from(nonceBytes).toString('hex'),
      lastMsgId: '7301444403200000000',
    };

    const oursReqDhResult = buildReqDhParams(
      initialState,
      resPqTemplate,
      newNonceBytes,
      makeRandomStream(randomSource, step2RandomOffset),
    );
    const oursReqDh = await parsePlainBodyObject<InstanceType<typeof Api.ReqDHParams>>(
      oursReqDhResult.outbound!,
    );

    assert.equal(authReqDh.nonce.toString(), oursReqDh.nonce.toString());
    assert.equal(authReqDh.serverNonce.toString(), oursReqDh.serverNonce.toString());
    assert.equal(Buffer.from(authReqDh.p).toString('hex'), Buffer.from(oursReqDh.p).toString('hex'));
    assert.equal(Buffer.from(authReqDh.q).toString('hex'), Buffer.from(oursReqDh.q).toString('hex'));
    assert.equal(
      authReqDh.publicKeyFingerprint.toString(),
      oursReqDh.publicKeyFingerprint.toString(),
    );
    assert.equal(
      Buffer.from(authReqDh.getBytes()).toString('hex'),
      Buffer.from(oursReqDh.getBytes()).toString('hex'),
    );

    const oursSetDhResult = await buildSetClientDhParams(
      oursReqDhResult.nextState,
      new Api.ServerDHParamsOk({
        nonce: nonceBig,
        serverNonce,
        encryptedAnswer: Buffer.from(encryptedAnswer),
      }),
      makeRandomStream(randomSource, step3RandomOffset),
      FIXED_NOW_MS,
    );
    const oursSetDh = await parsePlainBodyObject<InstanceType<typeof Api.SetClientDHParams>>(
      oursSetDhResult.outbound!,
    );

    assert.equal(
      Buffer.from(authSetDh.getBytes()).toString('hex'),
      Buffer.from(oursSetDh.getBytes()).toString('hex'),
    );

    const authSetDhPlain = aesIgeDecrypt(
      new Uint8Array(authSetDh.encryptedData as Buffer),
      new Uint8Array(key),
      new Uint8Array(iv),
    );
    const oursSetDhPlain = aesIgeDecrypt(
      new Uint8Array(oursSetDh.encryptedData as Buffer),
      new Uint8Array(key),
      new Uint8Array(iv),
    );
    const authInnerReader = new BinaryReader(Buffer.from(authSetDhPlain.slice(20)));
    const authInner = await Promise.resolve(
      authInnerReader.tgReadObject(),
    ) as InstanceType<typeof Api.ClientDHInnerData>;
    const oursInnerReader = new BinaryReader(Buffer.from(oursSetDhPlain.slice(20)));
    const oursInner = await Promise.resolve(
      oursInnerReader.tgReadObject(),
    ) as InstanceType<typeof Api.ClientDHInnerData>;

    assert.equal(authInner.nonce.toString(), oursInner.nonce.toString());
    assert.equal(authInner.serverNonce.toString(), oursInner.serverNonce.toString());
    assert.equal(Buffer.from(authInner.gB).toString('hex'), Buffer.from(oursInner.gB).toString('hex'));
    assert.equal(authInner.retryId.toString(), oursInner.retryId.toString());
    assert.equal(oursSetDhResult.nextState.timeOffset, 123);
  });
});
