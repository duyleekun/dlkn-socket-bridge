import type { ZaloCredentials } from '../types/state.js';

const ZALO_CHAT_ORIGIN = 'https://chat.zalo.me';

/**
 * Build the Zalo WebSocket URL.
 * Standard Zalo WS endpoint: wss://chat.zalo.me/ws
 */
export function buildZaloWsUrl(host = 'chat.zalo.me'): string {
  return `wss://${host}/ws?zpw_ver=671&zpw_type=30`;
}

export function buildZaloCookieHeader(credentials: ZaloCredentials): string {
  return credentials.cookie
    .filter((cookie) => cookie.key.length > 0)
    .map((cookie) => `${cookie.key}=${cookie.value}`)
    .join('; ');
}

export function buildZaloWsHeaders(
  credentials: ZaloCredentials,
  wsUrl: string,
): Record<string, string> {
  return {
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Cookie: buildZaloCookieHeader(credentials),
    Host: new URL(wsUrl).host,
    Origin: ZALO_CHAT_ORIGIN,
    Pragma: 'no-cache',
    'User-Agent': credentials.userAgent,
  };
}
