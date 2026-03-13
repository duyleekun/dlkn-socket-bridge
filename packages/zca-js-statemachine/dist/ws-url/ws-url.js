/**
 * Build the Zalo WebSocket URL.
 * Standard Zalo WS endpoint: wss://chat.zalo.me/ws
 */
export function buildZaloWsUrl(host = 'chat.zalo.me') {
    return `wss://${host}/ws?zpw_ver=671&zpw_type=30`;
}
//# sourceMappingURL=ws-url.js.map