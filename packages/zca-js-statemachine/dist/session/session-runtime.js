import { createInitialState } from '../types/state.js';
import { dispatchInboundFrame } from '../dispatch/inbound-dispatch.js';
import { buildZaloWsUrl } from '../ws-url/ws-url.js';
import { createSnapshotFromState, } from './session-snapshot.js';
import { runSessionMachine } from './session-machine.js';
function makeResult(value, context, commands, events) {
    return {
        snapshot: createSnapshotFromState(value, context),
        commands,
        events,
    };
}
export async function createSession(input) {
    const state = createInitialState({
        userAgent: input.userAgent,
        language: input.language,
        credentials: input.credentials,
    });
    if (input.mode === 'qr') {
        const nextState = { ...state, phase: 'qr_connecting' };
        return makeResult('qr_connecting', nextState, [{ type: 'http_login_qr' }], []);
    }
    // credentials mode
    if (!input.credentials) {
        throw new Error('credentials required for mode=credentials');
    }
    const nextState = { ...state, phase: 'cred_logging_in', credentials: input.credentials };
    return makeResult('cred_logging_in', nextState, [
        { type: 'http_login_creds', credentials: input.credentials },
    ], []);
}
async function applyHostEvent(snapshot, event) {
    const ctx = snapshot.context;
    switch (event.type) {
        case 'inbound_frame': {
            const result = await dispatchInboundFrame(ctx, event.frame);
            // If we received cipher key (state stays the same value but context updated)
            // If we were ws_connecting and received cipher key → transition to listening
            let nextValue = snapshot.value;
            if (result.nextContext.cipherKey && !ctx.cipherKey) {
                if (snapshot.value === 'ws_connecting' || snapshot.value === 'reconnecting') {
                    nextValue = 'listening';
                }
            }
            return {
                snapshot: createSnapshotFromState(nextValue, result.nextContext),
                commands: result.commands,
                events: result.events,
            };
        }
        case 'ws_connected': {
            // Transition from qr_connecting → qr_awaiting_scan (waiting for cipher key + QR)
            // or from ws_connecting/reconnecting → ws_connecting (waiting for cipher key)
            let nextValue = snapshot.value;
            if (snapshot.value === 'qr_connecting') {
                nextValue = 'qr_awaiting_scan';
            }
            else if (snapshot.value === 'ws_connecting' || snapshot.value === 'reconnecting') {
                nextValue = 'ws_connecting'; // stays, waiting for cipher key frame
            }
            const nextCtx = {
                ...ctx,
                phase: nextValue,
                lastConnectedAt: Date.now(),
                cipherKey: null, // reset cipher key on new connection
            };
            return {
                snapshot: createSnapshotFromState(nextValue, nextCtx),
                commands: [{ type: 'send_ping' }],
                events: [],
            };
        }
        case 'ws_closed': {
            const isListening = snapshot.value === 'listening';
            const nextValue = isListening ? 'reconnecting' : 'error';
            const nextCtx = {
                ...ctx,
                phase: nextValue,
                cipherKey: null,
                errorMessage: isListening ? null : `WebSocket closed: ${event.reason} (${event.code})`,
                reconnectCount: isListening ? ctx.reconnectCount + 1 : ctx.reconnectCount,
            };
            const commands = [];
            if (isListening && ctx.wsUrl) {
                commands.push({ type: 'reconnect', wsUrl: ctx.wsUrl });
            }
            return {
                snapshot: createSnapshotFromState(nextValue, nextCtx),
                commands,
                events: [],
            };
        }
        case 'http_login_qr_result': {
            const { qrData } = event;
            const nextCtx = {
                ...ctx,
                qrData,
                phase: 'qr_awaiting_scan',
            };
            return {
                snapshot: createSnapshotFromState('qr_awaiting_scan', nextCtx),
                commands: [],
                events: [{ type: 'qr_ready', qrImage: qrData.image, qrToken: qrData.token, expiresAt: qrData.expiresAt }],
            };
        }
        case 'qr_scan_event': {
            if (event.event === 'scanned') {
                const scanData = event.data;
                return {
                    snapshot: createSnapshotFromState('qr_scanned', { ...ctx, phase: 'qr_scanned' }),
                    commands: [],
                    events: [{ type: 'qr_scanned', scanInfo: { avatar: scanData?.avatar, displayName: scanData?.displayName } }],
                };
            }
            if (event.event === 'confirmed') {
                // confirmed comes via http_login_creds_result
                return { snapshot, commands: [], events: [] };
            }
            if (event.event === 'expired' || event.event === 'declined') {
                return {
                    snapshot: createSnapshotFromState('idle', { ...ctx, phase: 'idle', qrData: null }),
                    commands: [],
                    events: [],
                };
            }
            return { snapshot, commands: [], events: [] };
        }
        case 'http_login_creds_result': {
            const { credentials, userProfile } = event;
            const wsUrl = buildZaloWsUrl();
            const nextCtx = {
                ...ctx,
                phase: 'ws_connecting',
                credentials,
                userProfile,
                wsUrl,
                qrData: null,
                errorMessage: null,
            };
            return {
                snapshot: createSnapshotFromState('ws_connecting', nextCtx),
                commands: [
                    { type: 'persist_credentials', credentials, userProfile, wsUrl, pingIntervalMs: ctx.pingIntervalMs },
                    { type: 'reconnect', wsUrl },
                ],
                events: [{ type: 'login_success', credentials, userProfile }],
            };
        }
        case 'http_login_failed': {
            const nextCtx = {
                ...ctx,
                phase: 'error',
                errorMessage: event.errorMessage,
            };
            return {
                snapshot: createSnapshotFromState('error', nextCtx),
                commands: [],
                events: [],
            };
        }
        case 'logout': {
            const nextCtx = {
                ...ctx,
                phase: 'idle',
                credentials: null,
                userProfile: null,
                cipherKey: null,
                wsUrl: null,
                qrData: null,
                errorMessage: null,
            };
            return {
                snapshot: createSnapshotFromState('idle', nextCtx),
                commands: [{ type: 'clear_credentials' }],
                events: [],
            };
        }
        default: {
            const _exhaustive = event;
            void _exhaustive;
            return { snapshot, commands: [], events: [] };
        }
    }
}
export async function transitionSession(snapshot, event) {
    return runSessionMachine(snapshot, event, applyHostEvent);
}
//# sourceMappingURL=session-runtime.js.map