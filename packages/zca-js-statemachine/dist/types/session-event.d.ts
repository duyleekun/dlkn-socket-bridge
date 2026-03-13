import type { ZaloCredentials, ZaloUserProfile } from './state.js';
export interface ZaloIncomingMessage {
    id: string;
    threadId: string;
    threadType: number;
    fromId: string;
    content: string;
    attachments?: unknown[];
    timestamp: number;
    msgType?: string;
}
export type ZaloSessionEvent = {
    type: 'qr_ready';
    qrImage: string;
    qrToken: string;
    expiresAt: number;
} | {
    type: 'qr_scanned';
    scanInfo: {
        avatar?: string;
        displayName?: string;
    };
} | {
    type: 'login_success';
    credentials: ZaloCredentials;
    userProfile: ZaloUserProfile;
} | {
    type: 'message';
    message: ZaloIncomingMessage;
} | {
    type: 'group_event';
    data: unknown;
} | {
    type: 'reaction';
    data: unknown;
} | {
    type: 'update';
    data: unknown;
};
//# sourceMappingURL=session-event.d.ts.map