/**
 * Side-effect actions produced by the state machine.
 * The consumer processes these to update UI, trigger re-sends, etc.
 */
export type Action =
  /** An API call response arrived */
  | {
      type: 'rpc_result';
      reqMsgId: string;
      requestName: string;
      result: unknown;
      /** Optional consumer-supplied correlation ID */
      requestId?: string;
    }
  /** A Telegram update (message, notification, etc.) */
  | {
      type: 'update';
      update: unknown;
      msgId: string;
      seqNo: number;
      envelopeClassName?: string;
    }
  /** Server sent a new salt; state already updated */
  | { type: 'new_salt'; salt: string }
  /** Server rejected a message */
  | { type: 'bad_msg'; errorCode: number; badMsgId: string }
  /** After a salt update, consumer should resend this pending request */
  | { type: 'resend_request'; msgId: string }
  /** Server acknowledged these message IDs */
  | { type: 'ack'; msgIds: string[] }
  /** DH key exchange completed; state is AUTH_KEY_READY */
  | { type: 'auth_key_ready' }
  /** auth.SendCode succeeded; consumer should prompt for code */
  | { type: 'login_code_sent'; phoneCodeHash: string; codeLength: number }
  /** auth.SignIn / auth.CheckPassword succeeded */
  | { type: 'login_success'; user: Record<string, unknown> }
  /** 2FA is required; consumer should prompt for password */
  | { type: 'login_password_needed'; hint: string; srpData: NonNullable<import('./state.ts').SerializedState['passwordSrp']> }
  /** QR login URL ready; consumer should display QR */
  | { type: 'login_qr_url'; url: string; expires: number }
  /** Telegram signaled that the QR code was scanned; export a fresh token */
  | { type: 'login_qr_scanned' }
  /** QR login must continue on another DC using the provided import token */
  | { type: 'login_qr_migrate'; targetDcId: number; tokenBase64Url: string }
  /** Server is directing us to migrate to another DC */
  | { type: 'dc_migrate'; targetDcId: number }
  /** An RPC error occurred */
  | { type: 'error'; message: string; code?: number };
