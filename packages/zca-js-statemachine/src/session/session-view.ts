import type { SessionSnapshot } from './session-snapshot.js';

export interface ZaloSessionView {
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

export function selectSessionView(snapshot: SessionSnapshot): ZaloSessionView {
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
