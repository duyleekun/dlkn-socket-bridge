/**
 * Smoke tests for gramjs-statemachine
 *
 * Tests type-level and structural properties without requiring a live
 * Telegram connection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyDataFromNonce, sha1 } from 'telegram/Helpers.js';
import { Api } from 'telegram/tl/index.js';
import { createInitialState } from '../src/types/state.js';
import type { SerializedState } from '../src/types/state.js';
import { sendApiMethod } from '../src/api/invoke.js';
import { sendCode, signIn, exportQrToken } from '../src/auth/login-steps.js';
import { resolveTelegramDc, parseMigrateDc } from '../src/dc/dc-resolver.js';
import { startDhExchange } from '../src/dh/dh-step1-req-pq.js';
import { normalizeTlValue } from '../src/dispatch/inbound-dispatch.js';
import { step } from '../src/step.js';
import { buildReqPqMultiFrame } from '../src/dh/dh-step1-req-pq.js';
import { buildReqDhParams } from '../src/dh/dh-step2-server-dh.js';
import { buildSetClientDhParams } from '../src/dh/dh-step3-client-dh.js';
import { handleDhGenResult } from '../src/dh/dh-step4-verify.js';
import {
  buildLoginActions,
  containsUpdateLoginToken,
  dispatch,
  dispatchDecodedObject,
} from '../src/dispatch/inbound-dispatch.js';
import { wrapTransportFrame } from '../src/framing/intermediate-codec.js';
import { wrapPlainMessage } from '../src/framing/plain-message.js';
import { createGramJsAuthKey } from '../src/session/auth-key.js';
import { aesIgeEncrypt, toHex } from '../src/session/crypto.js';
import { bigIntFromBytesBE, bigIntFromBytesLE, bigIntToBytesLE } from '../src/session/bigint-helpers.js';
import {
  fromHex,
  makeRandomStream,
  parsePlainBodyObject,
  parseFixedResPq,
  withFixedNow,
} from './support.js';

const FIXED_STEP1_OUTBOUND_HEX =
  '2800000000000000000000000000000000f1536514000000f18e7ebef05bf2edeb565a2f7149877399a10b8d';
const FIXED_STEP2_PREFIX_HEX =
  '5401000000000000000000000400000000f1536540010000bee412d7f05bf2edeb565a2f7149877399a10b8dc2a74ba9ac120c709f7d94280372795904665a272f00000004717a422b00000085fd64de851d9dd0fe000100';

// ── createInitialState ────────────────────────────────────────────────────────

describe('createInitialState', () => {
  it('creates a valid INIT state', () => {
    const state = createInitialState({ apiId: '123', apiHash: 'abc' });
    assert.equal(state.version, 1);
    assert.equal(state.phase, 'INIT');
    assert.equal(state.dcId, 2);
    assert.equal(state.dcMode, 'production');
    assert.equal(state.apiId, '123');
    assert.equal(state.apiHash, 'abc');
    assert.equal(state.timeOffset, 0);
    assert.equal(state.sequence, 0);
    assert.equal(state.lastMsgId, '0');
    assert.equal(state.connectionInited, false);
    assert.deepEqual(state.pendingRequests, {});
  });

  it('respects overrides', () => {
    const state = createInitialState({
      apiId: '1',
      apiHash: 'h',
      dcId: 5,
      dcMode: 'test',
      dcIp: '1.2.3.4',
      dcPort: 80,
    });
    assert.equal(state.dcId, 5);
    assert.equal(state.dcMode, 'test');
    assert.equal(state.dcIp, '1.2.3.4');
    assert.equal(state.dcPort, 80);
  });

  it('stores auth metadata in initial state', () => {
    const state = createInitialState({
      apiId: '1',
      apiHash: 'h',
      authMode: 'phone',
      phone: '+123',
      pendingQrImportTokenBase64Url: 'token-1',
      qrLoginUrl: 'tg://login?token=abc',
      qrExpiresAt: 123,
    });
    assert.equal(state.authMode, 'phone');
    assert.equal(state.phone, '+123');
    assert.equal(state.pendingQrImportTokenBase64Url, 'token-1');
    assert.equal(state.qrLoginUrl, 'tg://login?token=abc');
    assert.equal(state.qrExpiresAt, 123);
  });
});

// ── startDhExchange ───────────────────────────────────────────────────────────

describe('startDhExchange', () => {
  it('transitions from INIT to PQ_SENT', async () => {
    const state = createInitialState({ apiId: '1', apiHash: 'h' });
    const result = await startDhExchange(state);
    assert.equal(result.nextState.phase, 'PQ_SENT');
    assert.ok(result.outbound instanceof Uint8Array, 'should produce outbound bytes');
    assert.ok(result.outbound.length > 0, 'outbound should be non-empty');
    assert.ok(result.nextState.dhNonce, 'dhNonce should be set');
    assert.equal(result.nextState.dhNonce?.length, 32, 'dhNonce should be 16 bytes = 32 hex chars');
    assert.deepEqual(result.actions, []);
  });

  it('outbound starts with 4-byte LE transport frame header', async () => {
    const state = createInitialState({ apiId: '1', apiHash: 'h' });
    const { outbound } = await startDhExchange(state);
    const view = new DataView(outbound!.buffer, outbound!.byteOffset);
    const frameLen = view.getUint32(0, true);
    assert.equal(outbound!.length, 4 + frameLen, 'frame length field should match actual payload');
  });

  it('last msgId is updated in nextState', async () => {
    const state = createInitialState({ apiId: '1', apiHash: 'h' });
    const result = await startDhExchange(state);
    assert.notEqual(result.nextState.lastMsgId, '0', 'msgId should be updated');
  });

  it('matches the legacy req_pq_multi transport frame for fixed inputs', () => {
    withFixedNow(() => {
      const state = createInitialState({
        apiId: '12345',
        apiHash: '0123456789abcdef0123456789abcdef',
        dcMode: 'production',
        dcId: 2,
        dcIp: '149.154.167.50',
        dcPort: 443,
      });

      const result = buildReqPqMultiFrame(
        { ...state, lastMsgId: '0', timeOffset: 0 },
        fromHex('8d0ba199738749712f5a56ebedf25bf0'),
      );

      assert.equal(Buffer.from(result.outbound!).toString('hex'), FIXED_STEP1_OUTBOUND_HEX);
      assert.equal(result.nextState.dhNonce, '8d0ba199738749712f5a56ebedf25bf0');
      assert.equal(result.nextState.lastMsgId, '7301444403200000000');
    });
  });
});

describe('handleResPq', () => {
  it('matches the legacy req_DH_params envelope for fixed inputs', () => {
    const state: SerializedState = {
      ...createInitialState({
        apiId: '12345',
        apiHash: '0123456789abcdef0123456789abcdef',
        dcMode: 'production',
        dcId: 2,
        dcIp: '149.154.167.50',
        dcPort: 443,
      }),
      phase: 'PQ_SENT',
      dhNonce: '8d0ba199738749712f5a56ebedf25bf0',
      lastMsgId: '7301444403200000000',
    };
    const resPq = parseFixedResPq();

    withFixedNow(() => {
      const randomBytes = makeRandomStream(
        fromHex(
          '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20' +
          '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40' +
          '4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60' +
          '6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80' +
          '8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0' +
          'a1a2a3a4a5a6a7a8a9aaabacadaeafb0',
        ),
        0,
      );

      const result = buildReqDhParams(
        state,
        resPq,
        fromHex('364c948ec6a29b95e638c8f25287dac5250cc1ecd767c3f004543dbdceae53a3'),
        randomBytes,
      );

      const outboundHex = Buffer.from(result.outbound!).toString('hex');
      assert.ok(outboundHex.startsWith(FIXED_STEP2_PREFIX_HEX));
      assert.equal(result.outbound!.length, 344);
      assert.equal(result.nextState.phase, 'DH_SENT');
      assert.equal(result.nextState.dhServerNonce, 'c2a74ba9ac120c709f7d942803727959');
      assert.equal(
        result.nextState.dhNewNonce,
        '364c948ec6a29b95e638c8f25287dac5250cc1ecd767c3f004543dbdceae53a3',
      );
      assert.equal(result.nextState.lastMsgId, '7301444403200000004');
    });
  });
});

describe('handleServerDHParams', () => {
  it('derives auth key metadata compatibly with GramJS AuthKey', async () => {
    const state: SerializedState = {
      ...createInitialState({
        apiId: '12345',
        apiHash: '0123456789abcdef0123456789abcdef',
        dcMode: 'production',
        dcId: 2,
        dcIp: '149.154.167.50',
        dcPort: 443,
      }),
      phase: 'DH_SENT',
      dhNonce: '8d0ba199738749712f5a56ebedf25bf0',
      dhServerNonce: 'c2a74ba9ac120c709f7d942803727959',
      dhNewNonce: '364c948ec6a29b95e638c8f25287dac5250cc1ecd767c3f004543dbdceae53a3',
      lastMsgId: '7301444403200000004',
    };

    const nonceBig = bigIntFromBytesBE(fromHex(state.dhNonce!));
    const serverNonceBig = bigIntFromBytesLE(fromHex(state.dhServerNonce!));
    const newNonceBig = bigIntFromBytesLE(fromHex(state.dhNewNonce!));
    const { key, iv } = await generateKeyDataFromNonce(serverNonceBig, newNonceBig);

    const inner = new Api.ServerDHInnerData({
      nonce: nonceBig,
      serverNonce: serverNonceBig,
      g: 3,
      dhPrime: Buffer.from('0101', 'hex'),
      gA: Buffer.from('0005', 'hex'),
      serverTime: 1_700_000_123,
    });
    const innerBytes = Buffer.from(inner.getBytes());
    const innerHash = await sha1(innerBytes);
    const prefix = Buffer.concat([innerHash, innerBytes]);
    const padding = Buffer.alloc((16 - (prefix.length % 16)) % 16);
    const encryptedAnswer = aesIgeEncrypt(
      new Uint8Array(Buffer.concat([prefix, padding])),
      new Uint8Array(key),
      new Uint8Array(iv),
    );

    const dhParams = new Api.ServerDHParamsOk({
      nonce: nonceBig,
      serverNonce: serverNonceBig,
      encryptedAnswer: Buffer.from(encryptedAnswer),
    });

    const fixedB = new Uint8Array(256);
    fixedB[255] = 7;

    const result = await buildSetClientDhParams(
      state,
      dhParams,
      (size) => fixedB.slice(0, size),
      1_700_000_000_000,
    );

    assert.equal(result.nextState.phase, 'DH_GEN_SENT');
    assert.equal(result.nextState.timeOffset, 123);

    const authKeyBytes = fromHex(result.nextState.authKey!);
    const expectedAuthKey = createGramJsAuthKey(authKeyBytes);
    assert.equal(result.nextState.authKeyId, toHex(expectedAuthKey.keyIdBytes));

    const expectedSalt = new Uint8Array(8);
    const newNonce = fromHex(state.dhNewNonce!);
    const serverNonce = fromHex(state.dhServerNonce!);
    for (let index = 0; index < 8; index += 1) {
      expectedSalt[index] = newNonce[index]! ^ serverNonce[index]!;
    }
    assert.equal(result.nextState.serverSalt, toHex(expectedSalt));

    const setDh = await parsePlainBodyObject<InstanceType<typeof Api.SetClientDHParams>>(
      result.outbound!,
    );
    assert.equal(setDh.className, 'SetClientDHParams');
    assert.equal(Buffer.from(bigIntToBytesLE(setDh.serverNonce, 16)).toString('hex'), state.dhServerNonce);
  });
});

describe('handleDhGenResult', () => {
  it('accepts a GramJS AuthKey-compatible DhGenOk response', async () => {
    const authKeyBytes = fromHex('11'.repeat(256));
    const { authKey } = createGramJsAuthKey(authKeyBytes);
    const dhNewNonce = '22'.repeat(32);
    const expectedHash = await authKey.calcNewNonceHash(
      bigIntFromBytesLE(fromHex(dhNewNonce)),
      1,
    );
    const nonce = bigIntFromBytesBE(fromHex('33'.repeat(16)));
    const serverNonce = bigIntFromBytesLE(fromHex('44'.repeat(16)));

    const body = new Uint8Array(new Api.DhGenOk({
      nonce,
      serverNonce,
      newNonceHash1: expectedHash,
    }).getBytes());
    const { message } = wrapPlainMessage(body, 0, 0n);
    const inbound = wrapTransportFrame(message);

    const state: SerializedState = {
      ...createInitialState({ apiId: '1', apiHash: 'h' }),
      phase: 'DH_GEN_SENT',
      authKey: toHex(authKeyBytes),
      authKeyId: toHex(createGramJsAuthKey(authKeyBytes).keyIdBytes),
      serverSalt: '00'.repeat(8),
      dhNonce: '33'.repeat(16),
      dhServerNonce: '44'.repeat(16),
      dhNewNonce,
      lastMsgId: '1',
    };

    const result = await handleDhGenResult(state, inbound);
    assert.equal(result.nextState.phase, 'AUTH_KEY_READY');
    assert.equal(result.actions[0]?.type, 'auth_key_ready');
    assert.equal(result.nextState.sequence, 0);
    assert.equal(result.nextState.dhNonce, undefined);
    assert.equal(result.nextState.dhServerNonce, undefined);
    assert.equal(result.nextState.dhNewNonce, undefined);
    assert.ok(result.nextState.sessionId);
  });
});

// ── step() in INIT phase throws ───────────────────────────────────────────────

describe('step() edge cases', () => {
  it('throws for INIT phase', async () => {
    const state = createInitialState({ apiId: '1', apiHash: 'h' });
    await assert.rejects(
      () => step(state, new Uint8Array(10)),
      /INIT phase/,
    );
  });

  it('throws for ERROR phase', async () => {
    const state: SerializedState = {
      ...createInitialState({ apiId: '1', apiHash: 'h' }),
      phase: 'ERROR',
      error: { message: 'test error' },
    };
    await assert.rejects(
      () => step(state, new Uint8Array(10)),
      /ERROR phase/,
    );
  });
});

// ── login steps throw without required state ──────────────────────────────────

describe('login steps', () => {
  it('sendCode throws if no phone', async () => {
    // Need an AUTH_KEY_READY state for login steps to work
    const baseState: SerializedState = {
      ...createInitialState({ apiId: '1', apiHash: 'h' }),
      phase: 'AUTH_KEY_READY',
      authKey: 'aa'.repeat(256),
      authKeyId: 'bb'.repeat(8),
      serverSalt: 'cc'.repeat(8),
      sessionId: 'dd'.repeat(8),
    };
    await assert.rejects(() => sendCode(baseState), /phone/i);
  });

  it('signIn throws if no phone', async () => {
    const baseState: SerializedState = {
      ...createInitialState({ apiId: '1', apiHash: 'h' }),
      phase: 'AWAITING_CODE',
      authKey: 'aa'.repeat(256),
      authKeyId: 'bb'.repeat(8),
      serverSalt: 'cc'.repeat(8),
      sessionId: 'dd'.repeat(8),
      phoneCodeHash: 'abc123',
    };
    await assert.rejects(() => signIn(baseState, { code: '12345' }), /phone/i);
  });
});

describe('sendApiMethod', () => {
  const readyState: SerializedState = {
    ...createInitialState({ apiId: '1', apiHash: 'h' }),
    phase: 'READY',
    connectionInited: true,
    authKey: 'aa'.repeat(256),
    authKeyId: 'bb'.repeat(8),
    serverSalt: 'cc'.repeat(8),
    sessionId: 'dd'.repeat(8),
  };

  it('resolves messages.GetDialogs and records the request class name', async () => {
    const result = await sendApiMethod(readyState, 'messages.GetDialogs', {
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      limit: 20,
      hash: 0n,
    });

    assert.equal(result.nextState.pendingRequests[result.nextState.lastMsgId]?.requestName, 'messages.GetDialogs');
    assert.ok(result.outbound instanceof Uint8Array);
  });

  it('sends messages.SendMessage with native bigint params', async () => {
    const result = await sendApiMethod(readyState, 'messages.SendMessage', {
      peer: new Api.InputPeerSelf(),
      message: 'hello',
      randomId: 1n,
      noWebpage: true,
    });

    assert.equal(result.nextState.pendingRequests[result.nextState.lastMsgId]?.requestName, 'messages.SendMessage');
    assert.ok(result.outbound instanceof Uint8Array);
  });

  it('rejects unknown method paths', async () => {
    await assert.rejects(
      () => sendApiMethod(readyState, 'messages.DoesNotExist' as never, {}),
      /Unknown API method: messages\.DoesNotExist/,
    );
  });

  it('rejects constructor-only paths', async () => {
    await assert.rejects(
      () => sendApiMethod(readyState, 'InputPeerEmpty' as never, undefined as never),
      /API path is not a request: InputPeerEmpty/,
    );
  });
});

describe('QR login dispatch', () => {
  const readyState: SerializedState = {
    ...createInitialState({ apiId: '1', apiHash: 'h' }),
    phase: 'QR_TOKEN_SENT',
    authMode: 'qr',
    authKey: 'aa'.repeat(256),
    authKeyId: 'bb'.repeat(8),
    serverSalt: 'cc'.repeat(8),
    sessionId: 'dd'.repeat(8),
  };

  it('maps auth.LoginTokenSuccess to login_success', () => {
    const result = buildLoginActions(
      'auth.ImportLoginToken',
      new Api.auth.LoginTokenSuccess({
        authorization: new Api.auth.Authorization({
          user: new Api.User({
            id: BigInt(1),
            firstName: 'Duy',
          }),
          otherwiseReloginDays: 0,
        }),
      }),
      readyState,
    );

    assert.ok(result);
    assert.deepEqual(result?.actions, []);
    assert.equal(result?.updatedState.phase, 'READY');
    assert.equal(
      (result?.updatedState.user as Record<string, unknown>).id,
      '1',
    );
  });

  it('maps auth.LoginTokenMigrateTo to login_qr_migrate', () => {
    const result = buildLoginActions(
      'auth.ImportLoginToken',
      new Api.auth.LoginTokenMigrateTo({
        dcId: 4,
        token: Buffer.from('migrate-me'),
      }),
      readyState,
    );

    assert.deepEqual(result?.actions, [{
      type: 'login_qr_migrate',
      targetDcId: 4,
      tokenBase64Url: Buffer.from('migrate-me').toString('base64url'),
    }]);
  });

  it('detects UpdateLoginToken nested inside updates', () => {
    const updates = new Api.Updates({
      updates: [new Api.UpdateLoginToken()],
      users: [],
      chats: [],
      date: 0,
      seq: 1,
    });

    assert.equal(containsUpdateLoginToken(updates), true);
  });

  it('dispatchDecodedObject matches raw-byte dispatch for QR migrate results', async () => {
    const message = new Api.auth.LoginTokenMigrateTo({
      dcId: 4,
      token: Buffer.from('migrate-me'),
    });
    const msgId = 123n;
    const seqNo = 2;

    const fromBytes = await dispatch(
      readyState,
      new Uint8Array(message.getBytes()),
      msgId,
      seqNo,
    );
    const fromObject = await dispatchDecodedObject(
      readyState,
      message,
      msgId,
      seqNo,
    );

    assert.deepEqual(fromObject, fromBytes);
  });
});

// ── DC resolver ───────────────────────────────────────────────────────────────

describe('resolveTelegramDc', () => {
  it('resolves production DC 2', () => {
    const dc = resolveTelegramDc('production', 2);
    assert.equal(dc.id, 2);
    assert.equal(dc.ip, '149.154.167.50');
    assert.equal(dc.port, 443);
  });

  it('resolves test DC 2', () => {
    const dc = resolveTelegramDc('test', 2);
    assert.equal(dc.ip, '149.154.167.40');
  });

  it('throws for unknown DC', () => {
    assert.throws(() => resolveTelegramDc('production', 99), /unsupported/);
  });
});

// ── parseMigrateDc ────────────────────────────────────────────────────────────

describe('parseMigrateDc', () => {
  it('parses PHONE_MIGRATE_4', () => {
    assert.equal(parseMigrateDc('PHONE_MIGRATE_4'), 4);
  });
  it('parses USER_MIGRATE_2', () => {
    assert.equal(parseMigrateDc('USER_MIGRATE_2'), 2);
  });
  it('returns undefined for non-migrate errors', () => {
    assert.equal(parseMigrateDc('FLOOD_WAIT_60'), undefined);
    assert.equal(parseMigrateDc(undefined), undefined);
  });
});

// ── normalizeTlValue ──────────────────────────────────────────────────────────

describe('normalizeTlValue', () => {
  it('passes through primitives', () => {
    assert.equal(normalizeTlValue(42), 42);
    assert.equal(normalizeTlValue('hello'), 'hello');
    assert.equal(normalizeTlValue(true), true);
    assert.equal(normalizeTlValue(null), null);
  });

  it('converts bigint to string', () => {
    assert.equal(normalizeTlValue(12345n), '12345');
  });

  it('converts Uint8Array to base64url object', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = normalizeTlValue(bytes) as Record<string, unknown>;
    assert.equal(result.type, 'bytes');
    assert.equal(result.length, 3);
    assert.ok(typeof result.base64url === 'string');
  });

  it('recursively normalizes nested objects', () => {
    const obj = { id: 123n, name: 'test', nested: { val: 456n } };
    const result = normalizeTlValue(obj) as Record<string, unknown>;
    assert.equal(result.id, '123');
    assert.equal(result.name, 'test');
    assert.equal((result.nested as Record<string, unknown>).val, '456');
  });

  it('strips internal GramJS fields', () => {
    const obj = { CONSTRUCTOR_ID: 123, className: 'Foo', value: 1 };
    const result = normalizeTlValue(obj) as Record<string, unknown>;
    assert.ok(!('CONSTRUCTOR_ID' in result));
    assert.equal(result.className, 'Foo');
    assert.equal(result.value, 1);
  });

  it('normalizes arrays recursively', () => {
    const arr = [1n, 2n, 3n];
    const result = normalizeTlValue(arr) as unknown[];
    assert.deepEqual(result, ['1', '2', '3']);
  });
});
