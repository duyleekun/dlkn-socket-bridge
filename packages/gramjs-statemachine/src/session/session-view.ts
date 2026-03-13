import type { SessionSnapshot } from './session-snapshot.js';

export type SessionScreen =
  | 'phone'
  | 'waiting'
  | 'code'
  | 'password'
  | 'qr'
  | 'ready'
  | 'error';

export interface SessionView {
  state: SessionSnapshot['value'];
  protocolPhase: SessionSnapshot['context']['protocolPhase'];
  screen: SessionScreen;
  statusText: string;
  authMode?: SessionSnapshot['context']['authMode'];
  phone?: string;
  codeLength?: number;
  passwordHint?: string;
  qrLoginUrl?: string;
  qrExpiresAt?: number;
  user?: Record<string, unknown>;
  error?: string;
  canSubmitCode: boolean;
  canSubmitPassword: boolean;
  canRefreshQr: boolean;
}

const STATUS_TEXT: Record<SessionSnapshot['context']['protocolPhase'], string> = {
  INIT: 'Starting session...',
  PQ_SENT: 'Requesting PQ...',
  DH_SENT: 'Diffie-Hellman exchange...',
  DH_GEN_SENT: 'Verifying auth key...',
  AUTH_KEY_READY: 'Auth key established',
  CODE_SENT: 'Requesting verification code...',
  AWAITING_CODE: 'Waiting for code',
  SIGN_IN_SENT: 'Verifying code...',
  PASSWORD_INFO_SENT: 'Requesting password details...',
  AWAITING_PASSWORD: 'Waiting for password',
  CHECK_PASSWORD_SENT: 'Verifying password...',
  QR_TOKEN_SENT: 'Generating QR token...',
  AWAITING_QR_SCAN: 'Waiting for QR scan',
  QR_IMPORT_SENT: 'Finalizing QR login...',
  READY: 'Authenticated',
  ERROR: 'Error',
};

function deriveScreen(snapshot: SessionSnapshot): SessionScreen {
  switch (snapshot.value) {
    case 'awaiting_code':
      return 'code';
    case 'awaiting_password':
      return 'password';
    case 'awaiting_qr_scan':
      return 'qr';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'handshake':
    case 'authorizing':
      return 'waiting';
    default: {
      const _exhaustive: never = snapshot.value;
      return _exhaustive;
    }
  }
}

export function selectSessionView(snapshot: SessionSnapshot): SessionView {
  const { context } = snapshot;
  return {
    state: snapshot.value,
    protocolPhase: context.protocolPhase,
    screen: deriveScreen(snapshot),
    statusText: STATUS_TEXT[context.protocolPhase],
    authMode: context.authMode,
    phone: context.phone,
    codeLength: context.phoneCodeLength,
    passwordHint: context.passwordHint,
    qrLoginUrl: context.qrLoginUrl,
    qrExpiresAt: context.qrExpiresAt,
    user: context.user,
    error: context.error?.message,
    canSubmitCode: snapshot.value === 'awaiting_code',
    canSubmitPassword: snapshot.value === 'awaiting_password',
    canRefreshQr: snapshot.value === 'awaiting_qr_scan'
      || context.protocolPhase === 'QR_TOKEN_SENT'
      || context.protocolPhase === 'QR_IMPORT_SENT',
  };
}
