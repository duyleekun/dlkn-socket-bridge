/**
 * Internal reducer outputs used inside the state machine runtime.
 *
 * These are not the public host-facing events. `transitionSession()` converts the
 * observable subset into `SessionEvent` and consumes the protocol-only entries
 * internally.
 */
export type InternalAction =
  | {
      type: 'rpc_result';
      reqMsgId: string;
      requestName: string;
      result: unknown;
      requestId?: string;
    }
  | {
      type: 'update';
      update: unknown;
      msgId: string;
      seqNo: number;
      envelopeClassName?: string;
    }
  | { type: 'new_salt'; salt: string }
  | { type: 'bad_msg'; errorCode: number; badMsgId: string }
  | { type: 'ack'; msgIds: string[] }
  | { type: 'auth_key_ready' }
  | { type: 'login_qr_scanned' }
  | { type: 'login_qr_migrate'; targetDcId: number; tokenBase64Url: string }
  | { type: 'dc_migrate'; targetDcId: number }
  | { type: 'error'; message: string; code?: number };
