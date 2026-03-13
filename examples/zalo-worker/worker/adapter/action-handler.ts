/**
 * Runtime event handler for the Zalo worker.
 *
 * Protocol follow-up behavior lives inside `zca-js-statemachine`.
 * This module only performs worker-specific persistence (message log, etc.).
 */
import type { ZaloSessionEvent } from "zca-js-statemachine";
import { appendMessage } from "../runtime-store";
import type { Env, ZaloMessage } from "../types";

export async function handleSessionEvents(
  env: Env,
  sessionKey: string,
  events: ZaloSessionEvent[],
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case "message": {
        const msg: ZaloMessage = {
          id: event.message.id,
          threadId: event.message.threadId,
          threadType: event.message.threadType,
          fromId: event.message.fromId,
          content: event.message.content,
          timestamp: event.message.timestamp,
          msgType: event.message.msgType,
          recovered: event.message.recovered,
        };
        await appendMessage(env, sessionKey, msg);
        break;
      }

      case "login_success":
        console.log(`[action-handler] login success for session ${sessionKey}`, {
          uid: event.userProfile.uid,
          displayName: event.userProfile.displayName,
        });
        break;

      case "qr_ready":
        console.log(`[action-handler] QR ready for session ${sessionKey}`, {
          expiresAt: event.expiresAt,
        });
        break;

      case "qr_scanned":
        console.log(`[action-handler] QR scanned for session ${sessionKey}`, {
          displayName: event.scanInfo?.displayName,
        });
        break;

      case "group_event":
        console.log(`[action-handler] group event for session ${sessionKey}`);
        break;

      case "reaction":
        console.log(`[action-handler] reaction for session ${sessionKey}`);
        break;

      case "update":
        console.log(`[action-handler] update for session ${sessionKey}`);
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}
