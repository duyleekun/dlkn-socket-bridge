/**
 * worker/inbound.ts — conversation cache helpers.
 *
 * Thin top-level module that provides:
 *   - buildConversationCacheFromDialogs()  — used by action-handler
 *   - buildInputPeerFromConversation()     — used by server actions (sendMessage)
 *   - normalizeTlValue re-export           — from gramjs-statemachine
 */

export {
  buildConversationCacheFromDialogs,
  buildInputPeerFromConversation,
  normalizeTlValue,
} from "./mtproto/inbound";
