export interface SerializedCookie {
    key: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
}
export interface ZaloCredentials {
    imei: string;
    cookie: SerializedCookie[];
    userAgent: string;
    language?: string;
}
export interface ZaloUserProfile {
    uid: string;
    displayName: string;
    avatar: string;
}
export type ZaloPhase = 'idle' | 'qr_connecting' | 'qr_awaiting_scan' | 'qr_scanned' | 'qr_expired' | 'cred_logging_in' | 'logged_in' | 'ws_connecting' | 'listening' | 'reconnecting' | 'error';
export interface ZaloSerializedState {
    version: 1;
    phase: ZaloPhase;
    credentials: ZaloCredentials | null;
    userProfile: ZaloUserProfile | null;
    qrData: {
        image: string;
        token: string;
        expiresAt: number;
    } | null;
    cipherKey: string | null;
    wsUrl: string | null;
    pingIntervalMs: number;
    errorMessage: string | null;
    reconnectCount: number;
    lastConnectedAt: number | null;
    userAgent: string;
    language: string;
}
export declare function createInitialState(opts: {
    userAgent?: string;
    language?: string;
    credentials?: ZaloCredentials;
}): ZaloSerializedState;
//# sourceMappingURL=state.d.ts.map