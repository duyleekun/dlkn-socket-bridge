/**
 * Internal reducer outputs used only for protocol/session transitions.
 */
export type InternalAction =
  | { type: 'new_salt'; salt: string }
  | { type: 'bad_msg'; errorCode: number; badMsgId: string }
  | { type: 'ack'; msgIds: string[] }
  | { type: 'auth_key_ready' }
  | { type: 'login_qr_scanned' }
  | { type: 'login_qr_migrate'; targetDcId: number; tokenBase64Url: string }
  | { type: 'dc_migrate'; targetDcId: number }
  | { type: 'error'; message: string; code?: number };
