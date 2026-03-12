import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bigInt from 'big-integer';
import { AuthKey } from 'telegram/crypto/AuthKey.js';
import { BinaryReader, BinaryWriter } from 'telegram/extensions/index.js';
import { readBigIntFromBuffer } from 'telegram/Helpers.js';
import { MTProtoPlainSender } from 'telegram/network/MTProtoPlainSender.js';
import { MTProtoState } from 'telegram/network/MTProtoState.js';
import { GZIPPacked, RPCResult } from 'telegram/tl/core/index.js';
import { serializeBytes } from 'telegram/tl/generationHelpers.js';
import { Api } from 'telegram/tl/index.js';
import { sendApiRequest } from '../src/api/invoke.js';
import { buildReqPqMultiFrame } from '../src/dh/dh-step1-req-pq.js';
import {
  stripTransportFrame,
  wrapTransportFrame,
} from '../src/framing/intermediate-codec.js';
import { createInitialState, step } from '../src/index.js';
import {
  aesIgeDecrypt,
  aesIgeEncrypt,
  decryptMessage,
  deriveAesKeyIv,
  encryptMessage,
  toHex,
} from '../src/session/crypto.js';
import { FIXED_RESPQ_HEX, fromHex, withFixedNow } from './support.js';

const FIXED_AUTH_KEY = Uint8Array.from(
  Array.from({ length: 256 }, (_, index) => (index * 17 + 29) % 256),
);
const FIXED_AUTH_KEY_ID = createHash('sha1')
  .update(Buffer.from(FIXED_AUTH_KEY))
  .digest()
  .subarray(12, 20);
const FIXED_SERVER_SALT = fromHex('0123456789abcde0');
const FIXED_SESSION_ID = fromHex('1032547698badcfe');

class FakeConnection {
  sent: Buffer[] = [];

  async send(data: Buffer): Promise<void> {
    this.sent.push(Buffer.from(data));
  }

  async recv(): Promise<Buffer> {
    return Buffer.from(stripTransportFrame(fromHex(FIXED_RESPQ_HEX)));
  }
}

type TestMtProtoState = MTProtoState & {
  id: ReturnType<typeof bigInt>;
  salt: ReturnType<typeof bigInt>;
  timeOffset: number;
  _sequence: number;
  _lastMsgId: ReturnType<typeof bigInt>;
  _getNewMsgId: () => ReturnType<typeof bigInt>;
  _calcKey: (
    authKey: Buffer,
    msgKey: Buffer,
    client: boolean,
  ) => Promise<{ key: Buffer; iv: Buffer }>;
};

async function createGramJsEncryptedState(): Promise<TestMtProtoState> {
  const authKey = new AuthKey();
  await authKey.setKey(Buffer.from(FIXED_AUTH_KEY));

  const state = new MTProtoState(authKey, NULL_LOGGER) as TestMtProtoState;
  state.id = readBigIntFromBuffer(Buffer.from(FIXED_SESSION_ID), true, false);
  state.salt = readBigIntFromBuffer(Buffer.from(FIXED_SERVER_SALT), true, false);
  state.timeOffset = 0;
  state._sequence = 0;
  state._lastMsgId = bigInt.zero;
  return state;
}

function createSerializedSessionState() {
  return {
    ...createInitialState({
      apiId: '12345',
      apiHash: '0123456789abcdef0123456789abcdef',
      dcMode: 'production',
      dcId: 2,
      dcIp: '149.154.167.50',
      dcPort: 443,
    }),
    phase: 'AUTH_KEY_READY' as const,
    authKey: toHex(FIXED_AUTH_KEY),
    authKeyId: toHex(FIXED_AUTH_KEY_ID),
    serverSalt: toHex(FIXED_SERVER_SALT),
    sessionId: toHex(FIXED_SESSION_ID),
    connectionInited: true,
  };
}

async function decryptOutgoingClientEnvelopeWithGramJs(
  encrypted: Uint8Array,
): Promise<Uint8Array> {
  const gramjs = await createGramJsEncryptedState();
  const msgKey = Buffer.from(encrypted.slice(8, 24));
  const encryptedData = encrypted.slice(24);
  const { key, iv } = await gramjs._calcKey(
    Buffer.from(FIXED_AUTH_KEY),
    msgKey,
    true,
  );
  return aesIgeDecrypt(encryptedData, new Uint8Array(key), new Uint8Array(iv));
}

async function buildInboundServerEnvelopeWithGramJs(opts: {
  msgId: bigint;
  seqNo: number;
  body: Uint8Array;
  padding: Uint8Array;
}): Promise<Uint8Array> {
  const gramjs = await createGramJsEncryptedState();
  const header = Buffer.alloc(32);
  header.set(FIXED_SERVER_SALT, 0);
  header.set(FIXED_SESSION_ID, 8);
  header.writeBigUInt64LE(opts.msgId, 16);
  header.writeUInt32LE(opts.seqNo, 24);
  header.writeUInt32LE(opts.body.length, 28);

  const plain = Buffer.concat([
    header,
    Buffer.from(opts.body),
    Buffer.from(opts.padding),
  ]);
  const msgKey = createHash('sha256')
    .update(Buffer.from(FIXED_AUTH_KEY.slice(96, 128)))
    .update(plain)
    .digest()
    .subarray(8, 24);
  const { key, iv } = await gramjs._calcKey(
    Buffer.from(FIXED_AUTH_KEY),
    msgKey,
    false,
  );
  const encryptedData = aesIgeEncrypt(
    new Uint8Array(plain),
    new Uint8Array(key),
    new Uint8Array(iv),
  );

  return new Uint8Array(
    Buffer.concat([Buffer.from(FIXED_AUTH_KEY_ID), msgKey, Buffer.from(encryptedData)]),
  );
}

const NULL_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  canSend() {
    return false;
  },
};

describe('GramJS internal compatibility', () => {
  it('MTProtoPlainSender request framing matches our req_pq_multi plain payload', async () => {
    const state = createInitialState({
      apiId: '12345',
      apiHash: '0123456789abcdef0123456789abcdef',
      dcMode: 'production',
      dcId: 2,
      dcIp: '149.154.167.50',
      dcPort: 443,
    });
    const nonceBytes = fromHex('8d0ba199738749712f5a56ebedf25bf0');
    const nonce = readBigIntFromBuffer(Buffer.from(nonceBytes), false, true);
    const ours = withFixedNow(() =>
      stripTransportFrame(
        buildReqPqMultiFrame(
          { ...state, lastMsgId: '0', timeOffset: 0 },
          nonceBytes,
        ).outbound!,
      ),
    );

    const connection = new FakeConnection();
    const sender = new MTProtoPlainSender(
      connection as unknown as ConstructorParameters<typeof MTProtoPlainSender>[0],
      NULL_LOGGER,
    ) as MTProtoPlainSender & { _state: { _getNewMsgId: () => ReturnType<typeof bigInt> } };

    sender._state._getNewMsgId = () => bigInt('7301444403200000000');
    await sender.send(new Api.ReqPqMulti({ nonce }));

    assert.equal(connection.sent.length, 1);
    assert.equal(connection.sent[0]!.toString('hex'), Buffer.from(ours).toString('hex'));
  });

  it('our plain message id generation matches GramJS MTProtoState', () => {
    withFixedNow(() => {
      const gramjs = new MTProtoState(undefined, NULL_LOGGER) as MTProtoState & {
        _lastMsgId: ReturnType<typeof bigInt>;
        _getNewMsgId: () => ReturnType<typeof bigInt>;
      };
      gramjs._lastMsgId = bigInt.zero;

      const first = gramjs._getNewMsgId().toString();
      const second = gramjs._getNewMsgId().toString();

      const state = createInitialState({ apiId: '1', apiHash: 'h' });
      const oursFirst = buildReqPqMultiFrame(
        { ...state, lastMsgId: '0', timeOffset: 0 },
        fromHex('000102030405060708090a0b0c0d0e0f'),
      ).nextState.lastMsgId;
      const oursSecond = buildReqPqMultiFrame(
        { ...state, lastMsgId: oursFirst, timeOffset: 0 },
        fromHex('101112131415161718191a1b1c1d1e1f'),
      ).nextState.lastMsgId;

      assert.equal(oursFirst, first);
      assert.equal(oursSecond, second);
    });
  });

  it('BinaryReader returns GramJS-decoded GZIPPacked data', async () => {
    const inner = new Api.Pong({ msgId: bigInt(11), pingId: bigInt(22) }).getBytes();
    const constructor = Buffer.alloc(4);
    constructor.writeUInt32LE(GZIPPacked.CONSTRUCTOR_ID, 0);
    const packet = Buffer.concat([
      constructor,
      serializeBytes(deflateSync(Buffer.from(inner))),
    ]);

    const reader = new BinaryReader(packet);
    const packed = await Promise.resolve(reader.tgReadObject()) as GZIPPacked & {
      data: Buffer;
    };

    assert.equal(packed.constructor.name.replace(/^_+/, ''), 'GZIPPacked');
    assert.equal(Buffer.from(packed.data).toString('hex'), Buffer.from(inner).toString('hex'));
  });

  it('deriveAesKeyIv matches GramJS _calcKey for both traffic directions', async () => {
    const gramjs = await createGramJsEncryptedState();
    const msgKey = fromHex('00112233445566778899aabbccddeeff');

    const oursClient = await deriveAesKeyIv(FIXED_AUTH_KEY, msgKey, true);
    const gramClient = await gramjs._calcKey(
      Buffer.from(FIXED_AUTH_KEY),
      Buffer.from(msgKey),
      true,
    );
    assert.equal(Buffer.from(oursClient.aesKey).toString('hex'), gramClient.key.toString('hex'));
    assert.equal(Buffer.from(oursClient.aesIv).toString('hex'), gramClient.iv.toString('hex'));

    const oursServer = await deriveAesKeyIv(FIXED_AUTH_KEY, msgKey, false);
    const gramServer = await gramjs._calcKey(
      Buffer.from(FIXED_AUTH_KEY),
      Buffer.from(msgKey),
      false,
    );
    assert.equal(Buffer.from(oursServer.aesKey).toString('hex'), gramServer.key.toString('hex'));
    assert.equal(Buffer.from(oursServer.aesIv).toString('hex'), gramServer.iv.toString('hex'));
  });

  it('our encryptMessage produces the same outbound plain envelope shape as GramJS', async () => {
    const gramjs = await createGramJsEncryptedState();
    const request = new Api.Ping({ pingId: bigInt(22) });

    await withFixedNow(async () => {
      const ours = await encryptMessage({
        authKey: FIXED_AUTH_KEY,
        serverSalt: FIXED_SERVER_SALT,
        sessionId: FIXED_SESSION_ID,
        seqNo: 1,
        body: new Uint8Array(request.getBytes()),
        timeOffset: 0,
        lastMsgId: 0n,
      });
      const writer = new BinaryWriter(Buffer.alloc(0));
      const gramMsgId = await gramjs.writeDataAsMessage(writer, request.getBytes(), true);
      const decryptedPlain = await decryptOutgoingClientEnvelopeWithGramJs(ours.encrypted);
      const expectedPrefix = Buffer.concat([
        Buffer.from(FIXED_SERVER_SALT),
        Buffer.from(FIXED_SESSION_ID),
        writer.getValue(),
      ]);

      assert.equal(
        Buffer.from(decryptedPlain.slice(0, expectedPrefix.length)).toString('hex'),
        expectedPrefix.toString('hex'),
      );
      assert.equal(ours.msgId.toString(), gramMsgId.toString());
    });
  });

  it('our decryptMessage parses a GramJS-compatible inbound server envelope', async () => {
    const request = new Api.Pong({ msgId: bigInt(44), pingId: bigInt(55) });
    const msgId = 0x6554433221100004n;
    const seqNo = 2;
    const padding = fromHex('aabbccddeeff001122334455');

    const encrypted = await buildInboundServerEnvelopeWithGramJs({
      msgId,
      seqNo,
      body: new Uint8Array(request.getBytes()),
      padding,
    });

    const decrypted = await decryptMessage({
      authKey: FIXED_AUTH_KEY,
      data: encrypted,
    });

    assert.equal(decrypted.msgId.toString(), msgId.toString());
    assert.equal(decrypted.seqNo, seqNo);
    assert.equal(Buffer.from(decrypted.salt).toString('hex'), toHex(FIXED_SERVER_SALT));
    assert.equal(Buffer.from(decrypted.sessionId).toString('hex'), toHex(FIXED_SESSION_ID));
    assert.equal(
      Buffer.from(decrypted.body).toString('hex'),
      request.getBytes().toString('hex'),
    );
  });

  it('sendApiRequest stays in lockstep with GramJS sequence and msg ids', async () => {
    const gramjs = await createGramJsEncryptedState();
    let state = createSerializedSessionState();
    const steps = [
      { request: new Api.Ping({ pingId: bigInt(101) }), contentRelated: true, expectedSeqNo: 1 },
      { request: new Api.Ping({ pingId: bigInt(102) }), contentRelated: false, expectedSeqNo: 2 },
      { request: new Api.Ping({ pingId: bigInt(103) }), contentRelated: true, expectedSeqNo: 3 },
    ] as const;

    await withFixedNow(async () => {
      for (const step of steps) {
        const ours = await sendApiRequest(state, step.request, {
          contentRelated: step.contentRelated,
        });
        const writer = new BinaryWriter(Buffer.alloc(0));
        const gramMsgId = await gramjs.writeDataAsMessage(
          writer,
          step.request.getBytes(),
          step.contentRelated,
        );
        const decryptedPlain = await decryptOutgoingClientEnvelopeWithGramJs(
          stripTransportFrame(ours.outbound!),
        );
        const expectedPrefix = Buffer.concat([
          Buffer.from(FIXED_SERVER_SALT),
          Buffer.from(FIXED_SESSION_ID),
          writer.getValue(),
        ]);

        assert.equal(step.expectedSeqNo, writer.getValue().readInt32LE(8));
        assert.equal(
          Buffer.from(decryptedPlain.slice(0, expectedPrefix.length)).toString('hex'),
          expectedPrefix.toString('hex'),
        );
        assert.equal(ours.nextState.lastMsgId, gramMsgId.toString());
        assert.equal(ours.nextState.sequence, gramjs._sequence);

        state = ours.nextState;
      }
    });
  });

  it('salt round-trips preserve signed 64-bit GramJS values', async () => {
    const negativeSaltHex = 'efcdab89674523f1';
    const state = {
      ...createSerializedSessionState(),
      serverSalt: negativeSaltHex,
    };
    const request = new Api.Ping({ pingId: bigInt(404) });

    await withFixedNow(async () => {
      const outbound = await sendApiRequest(state, request);
      const decryptedPlain = await decryptOutgoingClientEnvelopeWithGramJs(
        stripTransportFrame(outbound.outbound!),
      );

      assert.equal(
        Buffer.from(decryptedPlain.slice(0, 8)).toString('hex'),
        negativeSaltHex,
      );
    });
  });

  it('step resolves async RPCResult objects returned by GramJS decryptMessageData', async () => {
    const requestMsgId = 0x6554433221100002n;
    const responseMsgId = 0x6554433221100004n;
    const qrToken = Buffer.from('handshake-still-good');
    const loginToken = new Api.auth.LoginToken({
      token: qrToken,
      expires: 1_700_000_123,
    });
    const rpcResultBody = Buffer.alloc(12 + loginToken.getBytes().length);
    rpcResultBody.writeUInt32LE(RPCResult.CONSTRUCTOR_ID, 0);
    rpcResultBody.writeBigInt64LE(requestMsgId, 4);
    Buffer.from(loginToken.getBytes()).copy(rpcResultBody, 12);
    const paddingLength = (16 - ((32 + rpcResultBody.length) % 16)) % 16;

    const encrypted = await buildInboundServerEnvelopeWithGramJs({
      msgId: responseMsgId,
      seqNo: 2,
      body: new Uint8Array(rpcResultBody),
      padding: new Uint8Array(paddingLength),
    });

    const state = {
      ...createSerializedSessionState(),
      phase: 'QR_TOKEN_SENT' as const,
      pendingRequests: {
        [requestMsgId.toString()]: { requestName: 'auth.ExportLoginToken' },
      },
    };

    const result = await step(state, wrapTransportFrame(encrypted));

    assert.equal(result.nextState.phase, 'AWAITING_QR_SCAN');
    assert.deepEqual(result.nextState.pendingRequests, {});
    assert.equal(result.actions[0]?.type, 'login_qr_url');
    assert.equal(
      (result.actions[0] as { url: string }).url,
      `tg://login?token=${qrToken.toString('base64url')}`,
    );
  });
});
