import type { SessionSnapshot } from './session-snapshot.js';

export interface SessionView {
  phase: string;
  isConnected: boolean;
  isLoggedIn: boolean;
  hasQrCode: boolean;
  qrImage?: string;
  qrToken?: string;
  userProfile?: { uid: string; displayName: string; avatar: string };
  errorMessage?: string;
  wsUrl?: string;
}

export type ZaloSessionView = SessionView;

export function selectSessionView(snapshot: SessionSnapshot): SessionView {
  const ctx = snapshot.context;
  return {
    phase: snapshot.value,
    isConnected: snapshot.value === 'listening',
    isLoggedIn: ctx.credentials !== null,
    hasQrCode: ctx.qrData !== null,
    qrImage: ctx.qrData?.image,
    qrToken: ctx.qrData?.token,
    userProfile: ctx.userProfile ?? undefined,
    errorMessage: ctx.errorMessage ?? undefined,
    wsUrl: ctx.wsUrl ?? undefined,
  };
}
