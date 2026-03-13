import * as robot3 from 'robot3';
const robot3Api = (robot3.default ?? robot3);
function emptyResult(snapshot) {
    return { snapshot, commands: [], events: [] };
}
function createTransitionMachine(initial) {
    return robot3Api.createMachine(initial, {
        idle: robot3Api.state(robot3Api.transition('logout', 'idle')),
        qr_connecting: robot3Api.state(robot3Api.transition('ws_connected', 'qr_connecting'), robot3Api.transition('ws_closed', 'qr_connecting'), robot3Api.transition('http_login_qr_result', 'qr_connecting')),
        qr_awaiting_scan: robot3Api.state(robot3Api.transition('qr_scan_event', 'qr_awaiting_scan'), robot3Api.transition('inbound_frame', 'qr_awaiting_scan'), robot3Api.transition('ws_closed', 'qr_awaiting_scan')),
        qr_scanned: robot3Api.state(robot3Api.transition('qr_scan_event', 'qr_scanned')),
        qr_expired: robot3Api.state(),
        cred_logging_in: robot3Api.state(robot3Api.transition('http_login_creds_result', 'cred_logging_in'), robot3Api.transition('http_login_failed', 'cred_logging_in')),
        logged_in: robot3Api.state(),
        ws_connecting: robot3Api.state(robot3Api.transition('ws_connected', 'ws_connecting'), robot3Api.transition('ws_closed', 'ws_connecting'), robot3Api.transition('inbound_frame', 'ws_connecting')),
        listening: robot3Api.state(robot3Api.transition('inbound_frame', 'listening'), robot3Api.transition('ws_closed', 'listening'), robot3Api.transition('logout', 'listening')),
        reconnecting: robot3Api.state(robot3Api.transition('ws_connected', 'reconnecting'), robot3Api.transition('ws_closed', 'reconnecting')),
        error: robot3Api.state(),
    });
}
function canHandleEvent(snapshot, event) {
    const machine = createTransitionMachine(snapshot.value);
    const stateObj = machine.states[snapshot.value];
    if (!stateObj)
        return false;
    return stateObj.transitions.has(event.type);
}
export async function runSessionMachine(snapshot, event, handler) {
    if (!canHandleEvent(snapshot, event)) {
        return emptyResult(snapshot);
    }
    const payload = await handler(snapshot, event);
    return {
        snapshot: payload.snapshot,
        commands: payload.commands,
        events: payload.events,
    };
}
//# sourceMappingURL=session-machine.js.map