import type { SessionSnapshot } from './session-snapshot.js';
export interface ZaloSessionView {
    phase: string;
    isConnected: boolean;
    isLoggedIn: boolean;
    hasQrCode: boolean;
    qrImage?: string;
    qrToken?: string;
    userProfile?: {
        uid: string;
        displayName: string;
        avatar: string;
    };
    errorMessage?: string;
    wsUrl?: string;
}
export declare function selectSessionView(snapshot: SessionSnapshot): ZaloSessionView;
//# sourceMappingURL=session-view.d.ts.map