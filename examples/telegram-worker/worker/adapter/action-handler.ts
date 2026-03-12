/**
 * Action handler — processes side effects emitted by gramjs-statemachine step().
 *
 * Each Action type maps to a specific side effect:
 *   auth_key_ready   → start post-auth flow (sendCode / exportQrToken)
 *   login_code_sent  → update bridge session with code metadata
 *   login_success    → persist ready session
 *   login_password_needed → bridge session already updated by library
 *   login_qr_url     → update bridge session with QR URL
 *   login_qr_scanned → export a fresh QR token
 *   login_qr_migrate → restart auth on new DC and import the provided token
 *   dc_migrate       → restart auth on new DC
 *   rpc_result       → dispatch to pending requests / conversation cache
 *   update           → append to packet log
 *   new_salt         → state already updated by library
 *   bad_msg          → log (library handles state corrections internally)
 *   resend_request   → (no-op; handled inside library)
 *   ack              → (no-op; ack already handled)
 *   error            → persist error state
 */

import type { Action, SerializedState } from "gramjs-statemachine";
import {
  sendCode,
  exportQrToken,
  importLoginToken,
  sendGetPassword,
  startDhExchange,
  createInitialState,
  resolveTelegramDc,
} from "gramjs-statemachine";
import {
  saveBridgeSession,
  saveSerializedState,
  saveCallbackBinding,
  deleteCallbackBinding,
  loadPersistedSession,
  savePersistedSession,
  savePersistedLink,
  persistReadySession,
} from "../session-store";
import { sendBytes } from "../bridge-client";
import { cleanupSocket } from "../socket-health";
import { appendPacketLog, resolvePendingRequest, saveConversationCache } from "../runtime-store";
import { buildConversationCacheFromDialogs } from "../inbound";
import { createSession } from "../bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "../bridge-url";
import type { BridgeSession, Env } from "../types";

export async function handleAction(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  state: SerializedState,
  bridge: BridgeSession,
  action: Action,
): Promise<void> {
  switch (action.type) {
    case "auth_key_ready":
      await startPostAuthFlow(env, workerUrl, sessionKey, state, bridge);
      break;

    case "login_code_sent": {
      // State already updated by library (phoneCodeHash, phoneCodeLength, phase=AWAITING_CODE)
      const updatedBridge: BridgeSession = {
        ...bridge,
        socketStatus: bridge.socketStatus,
      };
      await saveBridgeSession(env, sessionKey, updatedBridge);
      console.log(`[action-handler] ${sessionKey}: login_code_sent`, {
        phone: state.phone,
        phoneCodeHash: action.phoneCodeHash,
        codeLength: action.codeLength,
      });
      break;
    }

    case "login_success":
      await persistReadySession(env, sessionKey, state, bridge, action.user);
      console.log(`[action-handler] ${sessionKey}: login_success → READY`);
      break;

    case "login_password_needed":
      // Library updated state with passwordSrp; just log
      console.log(`[action-handler] ${sessionKey}: login_password_needed`, {
        hint: action.hint,
      });
      break;

    case "login_qr_url": {
      // Store QR URL in BridgeSession so status endpoint can return it
      const updatedBridge: BridgeSession = {
        ...bridge,
        qrLoginUrl: action.url,
        qrExpiresAt: action.expires,
      };
      await saveBridgeSession(env, sessionKey, updatedBridge);
      console.log(`[action-handler] ${sessionKey}: QR URL ready`, {
        url: action.url,
        expires: action.expires,
      });
      break;
    }

    case "login_qr_scanned": {
      const result = await exportQrToken(state);
      await saveSerializedState(env, sessionKey, result.nextState);
      await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
      console.log(`[action-handler] ${sessionKey}: login_qr_scanned → QR_TOKEN_SENT`);
      break;
    }

    case "login_qr_migrate":
      await restartAuthOnDc(
        env,
        workerUrl,
        sessionKey,
        state,
        bridge,
        action.targetDcId,
        action.tokenBase64Url,
      );
      break;

    case "dc_migrate":
      await restartAuthOnDc(
        env,
        workerUrl,
        sessionKey,
        state,
        bridge,
        action.targetDcId,
        bridge.pendingQrImportTokenBase64Url,
      );
      break;

    case "rpc_result":
      await handleRpcResult(env, sessionKey, state, bridge, action);
      break;

    case "update":
      // Append the raw update to the packet log
      await appendPacketLog(env, sessionKey, [
        {
          id: `update:${Date.now()}`,
          msgId: action.msgId,
          seqNo: action.seqNo,
          receivedAt: Date.now(),
          requiresAck: false,
          className: (action.update as { className?: string })?.className || "Update",
          envelopeClassName: action.envelopeClassName,
          payload: action.update,
        },
      ]);
      break;

    case "new_salt":
      // State already updated by library — nothing to do
      break;

    case "bad_msg":
      console.warn(`[action-handler] ${sessionKey}: bad_msg errorCode=${action.errorCode}`, {
        badMsgId: action.badMsgId,
      });
      if (action.errorCode === 48) {
        if (state.phase === "QR_TOKEN_SENT" || state.phase === "AWAITING_QR_SCAN") {
          const result = await exportQrToken(state);
          await saveSerializedState(env, sessionKey, result.nextState);
          await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
          console.log(`[action-handler] ${sessionKey}: resent QR token after BadServerSalt`);
          break;
        }

        if (state.phase === "QR_IMPORT_SENT" && bridge.pendingQrImportTokenBase64Url) {
          const result = await importLoginToken(state, {
            tokenBase64Url: bridge.pendingQrImportTokenBase64Url,
          });
          await saveSerializedState(env, sessionKey, result.nextState);
          await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
          console.log(`[action-handler] ${sessionKey}: resent QR import after BadServerSalt`);
          break;
        }
      }
      break;

    case "resend_request":
      console.log(`[action-handler] ${sessionKey}: resend_request for msgId=${action.msgId}`);
      break;

    case "ack":
      // Already handled by library
      break;

    case "error":
      if (action.message === "AUTH_TOKEN_EXPIRED" && state.phase === "QR_IMPORT_SENT") {
        const result = await exportQrToken(state);
        const updatedBridge: BridgeSession = {
          ...bridge,
          pendingQrImportTokenBase64Url: undefined,
          qrLoginUrl: undefined,
          qrExpiresAt: undefined,
        };
        await Promise.all([
          saveSerializedState(env, sessionKey, result.nextState),
          saveBridgeSession(env, sessionKey, updatedBridge),
        ]);
        await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
        console.warn(
          `[action-handler] ${sessionKey}: QR import token expired, requesting fresh QR token`,
          {
            code: action.code,
            message: action.message,
          },
        );
        break;
      }

      if (action.message === "SESSION_PASSWORD_NEEDED") {
        if (state.phase === "QR_IMPORT_SENT" || state.phase === "SIGN_IN_SENT") {
          const result = await sendGetPassword(state);
          await saveSerializedState(env, sessionKey, result.nextState);
          await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
          console.log(`[action-handler] ${sessionKey}: ${state.phase} → PASSWORD_INFO_SENT`, {
            code: action.code,
            message: action.message,
          });
          break;
        }
      }
      console.error(`[action-handler] ${sessionKey}: error action`, {
        message: action.message,
        code: action.code,
      });
      break;
  }
}

// ── Post-auth flow ────────────────────────────────────────────────────────────

async function startPostAuthFlow(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  state: SerializedState,
  bridge: BridgeSession,
): Promise<void> {
  // If we have a pending QR import token, send importLoginToken immediately
  if (bridge.pendingQrImportTokenBase64Url) {
    const result = await importLoginToken(state, {
      tokenBase64Url: bridge.pendingQrImportTokenBase64Url,
    });
    const updatedBridge: BridgeSession = {
      ...bridge,
      pendingQrImportTokenBase64Url: undefined,
    };
    await Promise.all([
      saveSerializedState(env, sessionKey, result.nextState),
      saveBridgeSession(env, sessionKey, updatedBridge),
    ]);
    await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
    console.log(`[action-handler] ${sessionKey}: AUTH_KEY_READY → QR_IMPORT_SENT`);
    return;
  }

  if (bridge.authMode === "qr") {
    const result = await exportQrToken(state);
    await saveSerializedState(env, sessionKey, result.nextState);
    await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
    console.log(`[action-handler] ${sessionKey}: AUTH_KEY_READY → QR_TOKEN_SENT`);
    return;
  }

  // Phone auth: send code (uses state.phone)
  const stateWithPhone: SerializedState = { ...state, phone: state.phone || bridge.phone };
  const result = await sendCode(stateWithPhone);
  await saveSerializedState(env, sessionKey, result.nextState);
  await sendBridgeBytes(bridge.bridgeUrl, bridge.socketId, result.outbound!);
  console.log(`[action-handler] ${sessionKey}: AUTH_KEY_READY → CODE_SENT`);
}

// ── DC migration ──────────────────────────────────────────────────────────────

async function restartAuthOnDc(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  state: SerializedState,
  bridge: BridgeSession,
  targetDcId: number,
  pendingQrImportTokenBase64Url?: string,
): Promise<void> {
  const resolvedDc = resolveTelegramDc(state.dcMode, targetDcId);
  const newCallbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const bridgeUrl = bridge.bridgeUrl;

  const bridgeResp = await createSession(
    bridgeUrl,
    `mtproto-frame://${resolvedDc.ip}:${resolvedDc.port}`,
    `${normalizedWorkerUrl}/cb/${newCallbackKey}`,
  );

  const newState = createInitialState({
    dcId: resolvedDc.id,
    dcIp: resolvedDc.ip,
    dcPort: resolvedDc.port,
    dcMode: state.dcMode,
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
  });

  const dhResult = await startDhExchange(newState);

  const newBridge: BridgeSession = {
    ...bridge,
    callbackKey: newCallbackKey,
    socketId: bridgeResp.socket_id,
    pendingQrImportTokenBase64Url,
    qrLoginUrl: undefined,
    qrExpiresAt: undefined,
    socketStatus: "unknown",
    socketLastCheckedAt: undefined,
    socketLastHealthyAt: undefined,
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, dhResult.nextState),
    saveBridgeSession(env, sessionKey, newBridge),
    saveCallbackBinding(env, newCallbackKey, sessionKey),
    deleteCallbackBinding(env, bridge.callbackKey),
  ]);

  await sendBridgeBytes(bridgeUrl, bridgeResp.socket_id, dhResult.outbound!);
  await cleanupSocket(bridgeUrl, bridge.socketId);

  console.log(
    `[action-handler] ${sessionKey}: dc_migrate → DC ${targetDcId} (${resolvedDc.ip}:${resolvedDc.port})`,
  );
}

// ── RPC result dispatch ───────────────────────────────────────────────────────

async function handleRpcResult(
  env: Env,
  sessionKey: string,
  state: SerializedState,
  bridge: BridgeSession,
  action: Extract<Action, { type: "rpc_result" }>,
): Promise<void> {
  // Resolve pending request for this message
  const request = await resolvePendingRequest(env, sessionKey, action.reqMsgId);
  if (request) {
    await env.TG_KV.put(
      `result:${sessionKey}:${request.requestId}`,
      JSON.stringify({
        requestId: request.requestId,
        kind: request.kind,
        method: request.method,
        reqMsgId: action.reqMsgId,
        className: action.requestName,
        payload: action.result,
        receivedAt: Date.now(),
      }),
      { expirationTtl: 300 },
    );
  }

  // Try to build conversation cache from a dialogs result
  const cache = buildConversationCacheFromDialogs(action.result);
  if (cache) {
    await saveConversationCache(env, sessionKey, cache);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendBridgeBytes(
  bridgeUrl: string,
  socketId: string,
  bytes: Uint8Array,
): Promise<void> {
  await sendBytes(bridgeUrl, socketId, bytes);
}
