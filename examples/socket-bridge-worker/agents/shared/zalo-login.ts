/**
 * HTTP-based QR login using zca-js directly (NOT through the bridge).
 *
 * The QR login is a multi-step HTTP flow managed by zca-js:
 *   1. Generate QR code via Zalo API
 *   2. Wait for user to scan + confirm
 *   3. Exchange confirmed session for credentials
 *
 * zca-js loginQR signature:
 *   loginQR(options?: { userAgent, language, qrPath }, callback?: LoginQRCallback): Promise<API>
 *
 * The callback fires events: QRCodeGenerated, QRCodeScanned, QRCodeExpired,
 * QRCodeDeclined, GotLoginInfo. loginQR internally calls loginCookie after
 * GotLoginInfo, resolving with an authenticated API instance.
 */
import { Zalo, LoginQRCallbackEventType } from "zca-js";
import type { LoginQRCallbackEvent } from "zca-js";
import type {
  SerializedCookie,
  ZaloCredentials,
  ZaloUserProfile,
} from "zca-js-statemachine";
import { mergeUserProfile } from "./user-profile";

interface CookieJarLike {
  getCookieStringSync(url: string): string;
  serializeSync(): { cookies: SerializedCookie[] };
}

interface ZaloContextLike {
  uid?: unknown;
  API_TYPE?: number;
  API_VERSION?: number;
  loginInfo?: {
    display_name?: unknown;
    name?: unknown;
    avatar?: unknown;
    send2me_id?: unknown;
    zpw_ws?: unknown;
  };
  settings?: {
    features?: {
      socket?: {
        ping_interval?: unknown;
      };
    };
  };
}

interface ZaloApiLike {
  getContext(): ZaloContextLike;
  getCookie(): CookieJarLike;
  sendMessage(
    message: string,
    threadId: string,
    type?: number,
  ): Promise<{
    message: { msgId: number } | null;
    attachment: Array<{ msgId: number }>;
  }>;
}

export interface QRLoginResult {
  credentials: ZaloCredentials;
  userProfile: ZaloUserProfile;
  wsUrl: string;
  pingIntervalMs: number;
}

export type PersistedSessionValidationResult =
  | {
      ok: true;
      credentials: ZaloCredentials;
      userProfile: ZaloUserProfile;
      wsUrl: string;
      pingIntervalMs: number;
    }
  | {
      ok: false;
      error: string;
    };

function serializeCookies(cookieJar: CookieJarLike): SerializedCookie[] {
  return cookieJar.serializeSync().cookies.map((cookie) => ({
    key: cookie.key,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  }));
}

function extractRealtimeInfo(api: ZaloApiLike): {
  wsUrl: string;
  pingIntervalMs: number;
} {
  const ctx = api.getContext();
  const wsCandidates = Array.isArray(ctx.loginInfo?.zpw_ws)
    ? ctx.loginInfo.zpw_ws.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  const wsUrl = finalizeWsUrl(
    wsCandidates[0] ?? buildZaloWsUrl(),
    ctx.API_VERSION ?? 671,
    ctx.API_TYPE ?? 30,
  );
  const pingIntervalRaw = ctx.settings?.features?.socket?.ping_interval;
  const pingIntervalMs =
    typeof pingIntervalRaw === "number" && Number.isFinite(pingIntervalRaw)
      ? pingIntervalRaw
      : 20000;

  return { wsUrl, pingIntervalMs };
}

function finalizeWsUrl(
  rawUrl: string,
  apiVersion: number,
  apiType: number,
): string {
  const url = new URL(rawUrl);
  if (!url.searchParams.has("t")) {
    url.searchParams.set("t", Date.now().toString());
  }
  if (!url.searchParams.has("zpw_ver")) {
    url.searchParams.set("zpw_ver", apiVersion.toString());
  }
  if (!url.searchParams.has("zpw_type")) {
    url.searchParams.set("zpw_type", apiType.toString());
  }
  return url.toString();
}

/**
 * Perform QR-code login via zca-js.
 *
 * @param userAgent - User-Agent string for the HTTP requests
 * @param language  - Language code (e.g. "vi")
 * @param onQrReady - Called with the base64 QR image when available
 * @param onScanned - Called when the QR is scanned (avatar + display name)
 * @returns Credentials, user profile, and realtime WS info
 */
export async function performQRLogin(
  userAgent: string,
  language: string,
  onQrReady: (qrImage: string) => Promise<void>,
  onScanned?: (info: { avatar?: string; displayName?: string }) => Promise<void>,
): Promise<QRLoginResult> {
  const zalo = new Zalo({ checkUpdate: false });

  const loginState = {
    imei: "",
    userAgent,
    cookies: [] as SerializedCookie[],
    scanInfo: {} as { avatar?: string; displayName?: string },
  };
  const handleEvent = (event: LoginQRCallbackEvent) => {
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        onQrReady(event.data.image).catch((err) =>
          console.warn("[zalo-login] onQrReady error:", err),
        );
        break;

      case LoginQRCallbackEventType.QRCodeScanned:
        loginState.scanInfo = {
          avatar: event.data.avatar,
          displayName: event.data.display_name,
        };
        if (onScanned) {
          onScanned({
            avatar: event.data.avatar,
            displayName: event.data.display_name,
          }).catch((err) =>
            console.warn("[zalo-login] onScanned error:", err),
          );
        }
        break;

      case LoginQRCallbackEventType.GotLoginInfo:
        loginState.imei = event.data.imei;
        loginState.userAgent = event.data.userAgent;
        loginState.cookies = (event.data.cookie as SerializedCookie[]).map((cookie) => ({
          key: cookie.key,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
        }));
        break;

      default:
        break;
    }
  };

  try {
    const api = (await zalo.loginQR(
      { userAgent, language },
      handleEvent,
    )) as unknown as ZaloApiLike;

    if (!loginState.imei) {
      throw new Error("zca-js login succeeded without an imei");
    }

    return buildLoginResultFromApi(
      api,
      {
        imei: loginState.imei,
        userAgent: loginState.userAgent,
        language,
      },
      loginState.scanInfo,
    );
  } catch (error) {
    if (!loginState.imei || loginState.cookies.length === 0) {
      throw error;
    }

    console.warn(
      "[zalo-login] loginQR produced credentials but final login failed; retrying with captured credentials",
      error,
    );

    const api = await loginWithRetries({
      imei: loginState.imei,
      cookie: loginState.cookies,
      userAgent: loginState.userAgent,
      language,
    });

    return buildLoginResultFromApi(
      api,
      {
        imei: loginState.imei,
        userAgent: loginState.userAgent,
        language,
      },
      loginState.scanInfo,
    );
  }
}

/**
 * Build a Zalo WebSocket URL from a host.
 */
export function buildZaloWsUrl(host: string = "chat.zalo.me"): string {
  return `wss://${host}/ws?zpw_ver=671&zpw_type=30`;
}

/**
 * Get server info (WS URL + ping interval) by reusing zca-js login.
 */
export async function getServerInfo(
  credentials: ZaloCredentials,
): Promise<{ wsUrl: string; pingIntervalMs: number }> {
  const api = await loginWithRetries(credentials);
  return extractRealtimeInfo(api);
}

export async function loginWithCredentials(
  credentials: ZaloCredentials,
): Promise<ZaloApiLike> {
  return loginWithRetries(credentials);
}

export async function validatePersistedSession(input: {
  credentials: ZaloCredentials;
  userProfile?: ZaloUserProfile | null;
}): Promise<PersistedSessionValidationResult> {
  try {
    const api = await loginWithRetries(input.credentials);
    const ctx = api.getContext();
    const uid = String(ctx.uid ?? "").trim();

    if (!uid) {
      return {
        ok: false,
        error: "Persisted Zalo session no longer exposes an authenticated user.",
      };
    }

    const { wsUrl, pingIntervalMs } = extractRealtimeInfo(api);
    return {
      ok: true,
      credentials: {
        imei: input.credentials.imei,
        cookie: serializeCookies(api.getCookie()),
        userAgent: input.credentials.userAgent,
        language: input.credentials.language,
      },
      userProfile: mergeUserProfile(
        {
          uid,
          displayName: String(
            ctx.loginInfo?.display_name ?? ctx.loginInfo?.name ?? "",
          ),
          avatar: String(ctx.loginInfo?.avatar ?? ""),
        },
        input.userProfile ?? undefined,
      ),
      wsUrl,
      pingIntervalMs,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveSelfThreadId(api: ZaloApiLike): string | null {
  const value = api.getContext().loginInfo?.send2me_id;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildLoginResultFromApi(
  api: ZaloApiLike,
  base: {
    imei: string;
    userAgent: string;
    language: string;
  },
  scanInfo?: { avatar?: string; displayName?: string },
): QRLoginResult {
  const ctx = api.getContext();
  const cookieJar = api.getCookie();
  const credentials: ZaloCredentials = {
    imei: base.imei,
    cookie: serializeCookies(cookieJar),
    userAgent: base.userAgent,
    language: base.language,
  };
  const { wsUrl, pingIntervalMs } = extractRealtimeInfo(api);
  const userProfile: ZaloUserProfile = mergeUserProfile(
    {
      uid: String(ctx.uid ?? ""),
      displayName: String(ctx.loginInfo?.display_name ?? ctx.loginInfo?.name ?? ""),
      avatar: String(ctx.loginInfo?.avatar ?? ""),
    },
    scanInfo,
  );
  return { credentials, userProfile, wsUrl, pingIntervalMs };
}

async function loginWithRetries(
  credentials: ZaloCredentials,
  attempts = 3,
): Promise<ZaloApiLike> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const zalo = new Zalo({ checkUpdate: false });
      const api = (await zalo.login({
        imei: credentials.imei,
        cookie: credentials.cookie as unknown as Parameters<Zalo["login"]>[0]["cookie"],
        userAgent: credentials.userAgent,
        language: credentials.language,
      })) as unknown as ZaloApiLike;
      return api;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`[zalo-login] retrying login ${attempt}/${attempts}`, error);
      }
    }
  }
  throw lastError;
}
