import type { ZaloCredentials } from './state.js';
export type ZaloSessionCommand = {
    type: 'send_frame';
    frame: Uint8Array;
} | {
    type: 'send_ping';
} | {
    type: 'http_login_qr';
} | {
    type: 'http_login_creds';
    credentials: ZaloCredentials;
} | {
    type: 'reconnect';
    wsUrl: string;
    firstFrame?: Uint8Array;
} | {
    type: 'persist_credentials';
    credentials: ZaloCredentials;
    userProfile: import('./state.js').ZaloUserProfile | null;
    wsUrl: string;
    pingIntervalMs: number;
} | {
    type: 'clear_credentials';
};
//# sourceMappingURL=session-command.d.ts.map