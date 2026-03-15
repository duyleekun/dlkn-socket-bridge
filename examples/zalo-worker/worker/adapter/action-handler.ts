/**
 * Runtime event handler for the Zalo worker.
 *
 * Protocol follow-up behavior lives inside `zca-js-statemachine`.
 * This module only performs worker-specific persistence (message log, etc.).
 */
import type { ZaloSessionEvent } from "zca-js-statemachine";
import { extractSocketMessages } from "zca-js-statemachine";
import { appendMessage } from "../runtime-store";
import type { Env } from "../types";

export async function handleSessionEvents(
  env: Env,
  sessionKey: string,
  events: ZaloSessionEvent[],
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
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

      case "frame":
        for (const message of extractSocketMessages(event)) {
          await appendMessage(env, sessionKey, message);
        }
        console.log(`[action-handler] frame for session ${sessionKey}`, {
          cmd: event.cmd,
          subCmd: event.subCmd,
          payloadKind: event.payloadKind,
        });
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}
