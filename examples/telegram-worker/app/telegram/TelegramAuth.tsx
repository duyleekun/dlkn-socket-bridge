"use client";

import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getBridgeSocketHealth,
  getResult,
  getStatus,
  logoutSession,
  refreshQrToken,
  restoreSessionFromCookie,
  sendTelegramMethod,
  startAuth,
  submitCode,
  submitPassword,
} from "../actions/telegram";
import { DEFAULT_BRIDGE_URL } from "../../worker/bridge-url";
import type {
  BridgeSocketHealth,
  SocketStatus,
  TelegramAuthMode,
} from "../../worker/types";

type Step =
  | "phone"
  | "waiting"
  | "code"
  | "password"
  | "qr"
  | "ready"
  | "error";
type DcMode = "test" | "production";

interface StatusData {
  state?: string;
  authMode?: TelegramAuthMode;
  phoneCodeHash?: string;
  passwordHint?: string;
  qrLoginUrl?: string;
  qrExpiresAt?: number;
  sessionRef?: string;
  user?: Record<string, unknown>;
  error?: string;
  socketStatus?: SocketStatus;
  socketLastCheckedAt?: number;
  socketLastHealthyAt?: number;
}

const DC_OPTIONS: Array<{
  value: DcMode;
  label: string;
  description: string;
}> = [
  {
    value: "test",
    label: "Test DC",
    description: "149.154.167.40:443",
  },
  {
    value: "production",
    label: "Real DC",
    description: "149.154.167.50:443",
  },
];

const STATE_LABELS: Record<string, string> = {
  PQ_SENT: "Requesting PQ...",
  DH_SENT: "Diffie-Hellman exchange...",
  DH_GEN_SENT: "Verifying auth key...",
  AUTH_KEY_READY: "Auth key established",
  CODE_SENT: "Requesting verification code...",
  MIGRATE_CONFIG_SENT: "Switching Telegram data center...",
  AWAITING_CODE: "Waiting for code",
  SIGN_IN_SENT: "Verifying code...",
  PASSWORD_INFO_SENT: "Requesting password details...",
  AWAITING_PASSWORD: "Waiting for password",
  CHECK_PASSWORD_SENT: "Verifying password...",
  QR_TOKEN_SENT: "Generating QR token...",
  AWAITING_QR_SCAN: "Waiting for QR scan",
  QR_IMPORT_SENT: "Finalizing QR login...",
  READY: "Authenticated",
  ERROR: "Error",
};

function deriveStep(status: StatusData | null): Step {
  if (!status) return "phone";
  switch (status.state) {
    case "AWAITING_CODE":
      return "code";
    case "AWAITING_PASSWORD":
      return "password";
    case "QR_TOKEN_SENT":
    case "AWAITING_QR_SCAN":
    case "QR_IMPORT_SENT":
      return "qr";
    case "READY":
      return "ready";
    case "ERROR":
      return "error";
    case "PQ_SENT":
    case "DH_SENT":
    case "DH_GEN_SENT":
    case "AUTH_KEY_READY":
    case "CODE_SENT":
    case "MIGRATE_CONFIG_SENT":
    case "SIGN_IN_SENT":
    case "PASSWORD_INFO_SENT":
    case "CHECK_PASSWORD_SENT":
      return "waiting";
    default:
      return "phone";
  }
}

function isHealthy(status?: SocketStatus): boolean {
  return status === "healthy" || status === "unknown" || status === undefined;
}

export default function TelegramAuth() {
  const [step, setStep] = useState<Step>("phone");
  const [authMode, setAuthMode] = useState<TelegramAuthMode>("phone");
  const [phone, setPhone] = useState("");
  const [dcMode, setDcMode] = useState<DcMode>("test");
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [sessionKey, setSessionKey] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<StatusData | null>(null);
  const [health, setHealth] = useState<BridgeSocketHealth | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [apiMethod, setApiMethod] = useState("");
  const [apiParams, setApiParams] = useState("{}");
  const [apiResult, setApiResult] = useState<Record<string, unknown> | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const qrRefreshRef = useRef<number | null>(null);

  const needsReconnect = useMemo(
    () => Boolean(sessionKey) && health && !isHealthy(health.status),
    [health, sessionKey],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await restoreSessionFromCookie(
        DEFAULT_BRIDGE_URL,
        window.location.origin,
      );
      if (cancelled) return;
      setRestoring(false);
      if (restored.restored) {
        setSessionKey(restored.sessionKey);
        setStatus(restored);
        setHealth(restored.health ?? null);
        setAuthMode(restored.authMode || "phone");
        setStep(deriveStep(restored));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionKey || step === "phone" || step === "error") return;

    const interval = setInterval(() => {
      void (async () => {
        const nextStatus = await getStatus(sessionKey);
        if ("error" in nextStatus && nextStatus.error === "not_found") {
          setStatus({ error: "Session not found", state: "ERROR" });
          setStep("error");
          return;
        }
        setStatus(nextStatus);
        setAuthMode(nextStatus.authMode || authMode);
        setStep(deriveStep(nextStatus));
      })();
    }, 500);

    return () => clearInterval(interval);
  }, [authMode, sessionKey, step]);

  useEffect(() => {
    if (!sessionKey || step === "phone" || step === "error") return;

    const pollHealth = async () => {
      const nextHealth = await getBridgeSocketHealth(sessionKey);
      if ("error" in nextHealth && nextHealth.error === "not_found") {
        setHealth({
          status: "closed",
          socketId: "",
          lastCheckedAt: Date.now(),
          error: "Session not found",
        });
        return;
      }
      setHealth(nextHealth);
    };

    void pollHealth();
    const interval = setInterval(() => {
      void pollHealth();
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (!status?.qrLoginUrl) {
      setQrDataUrl("");
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(status.qrLoginUrl, {
      margin: 1,
      width: 240,
    }).then((dataUrl) => {
      if (!cancelled) {
        setQrDataUrl(dataUrl);
      }
    }).catch(() => {
      if (!cancelled) {
        setQrDataUrl("");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [status?.qrLoginUrl]);

  useEffect(() => {
    if (qrRefreshRef.current) {
      window.clearTimeout(qrRefreshRef.current);
      qrRefreshRef.current = null;
    }
    if (!sessionKey || step !== "qr" || !status?.qrExpiresAt) return;

    const msUntilRefresh = Math.max(status.qrExpiresAt - Date.now() - 5000, 0);
    qrRefreshRef.current = window.setTimeout(() => {
      void (async () => {
        await refreshQrToken(sessionKey);
      })();
    }, msUntilRefresh);

    return () => {
      if (qrRefreshRef.current) {
        window.clearTimeout(qrRefreshRef.current);
        qrRefreshRef.current = null;
      }
    };
  }, [sessionKey, status?.qrExpiresAt, step]);

  async function handleStartAuth() {
    if (authMode === "phone" && !phone.trim()) return;
    try {
      const result = await startAuth({
        authMode,
        phone: authMode === "phone" ? phone.trim() : undefined,
        dcMode,
        bridgeUrl,
        workerUrl: window.location.origin,
      });
      setSessionKey(result.sessionKey);
      setStatus(result);
      setHealth(null);
      setCode("");
      setPassword("");
      setApiResult(null);
      setStep(deriveStep(result));
    } catch (err) {
      setStatus({
        state: "ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
      setStep("error");
    }
  }

  async function handleSubmitCode() {
    if (!code.trim()) return;
    try {
      await submitCode(sessionKey, code.trim());
      setStatus((current) => ({ ...current, state: "SIGN_IN_SENT" }));
      setStep("waiting");
    } catch (err) {
      setStatus({
        state: "ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
      setStep("error");
    }
  }

  async function handleSubmitPassword() {
    if (!password.trim()) return;
    try {
      await submitPassword(sessionKey, password);
      setPassword("");
      setStatus((current) => ({ ...current, state: "CHECK_PASSWORD_SENT" }));
      setStep("waiting");
    } catch (err) {
      setStatus({
        state: "ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
      setStep("error");
    }
  }

  async function handleReconnect() {
    try {
      setIsReconnecting(true);
      const restored = await restoreSessionFromCookie(
        bridgeUrl,
        window.location.origin,
      );
      if (restored.restored) {
        setSessionKey(restored.sessionKey);
        setStatus(restored);
        setHealth(restored.health ?? null);
        setAuthMode(restored.authMode || authMode);
        setStep(deriveStep(restored));
      } else {
        setStatus({
          state: "ERROR",
          error: "No persisted session available to reconnect",
        });
        setStep("error");
      }
    } finally {
      setIsReconnecting(false);
    }
  }

  async function handleLogout() {
    await logoutSession(sessionKey || undefined);
    setStep("phone");
    setSessionKey("");
    setCode("");
    setPassword("");
    setStatus(null);
    setHealth(null);
    setQrDataUrl("");
    setApiMethod("");
    setApiParams("{}");
    setApiResult(null);
  }

  async function handleSendMethod() {
    if (!apiMethod.trim()) return;
    try {
      const params = JSON.parse(apiParams);
      const result = await sendTelegramMethod(
        sessionKey,
        apiMethod.trim(),
        params,
      ) as { requestId?: string; error?: string };
      if (result.error) {
        setApiResult({ error: result.error });
        return;
      }

      if (result.requestId) {
        const poll = setInterval(async () => {
          const res = await getResult(sessionKey, result.requestId!) as Record<string, unknown>;
          if (res && !res.pending) {
            clearInterval(poll);
            setApiResult(res);
          }
        }, 500);
        setTimeout(() => clearInterval(poll), 30000);
      }
    } catch (err) {
      setApiResult({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const qrCountdown = status?.qrExpiresAt
    ? Math.max(0, Math.ceil((status.qrExpiresAt - Date.now()) / 1000))
    : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Telegram Auth</h1>
          <p className="text-sm text-gray-500">
            MTProto via dlkn-socket-bridge
          </p>
        </div>

        {restoring && (
          <div className="rounded-lg border border-gray-200 p-3 text-sm text-gray-500">
            Restoring persisted session...
          </div>
        )}

        {needsReconnect && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-3">
            <p className="font-medium">Bridge socket is no longer healthy.</p>
            <p>{health?.error || `Status: ${health?.status}`}</p>
            <button
              onClick={handleReconnect}
              disabled={isReconnecting}
              className="w-full rounded-lg bg-amber-600 px-3 py-2 text-white disabled:opacity-50"
            >
              {isReconnecting ? "Reconnecting..." : "Reconnect"}
            </button>
          </div>
        )}

        {step === "phone" && (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="block text-sm font-medium">Auth Mode</legend>
              <div className="grid grid-cols-2 gap-2">
                {(["phone", "qr"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setAuthMode(mode)}
                    className={`rounded-lg border p-3 text-sm font-medium ${
                      authMode === mode
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-300"
                    }`}
                  >
                    {mode === "phone" ? "Phone Code" : "QR Login"}
                  </button>
                ))}
              </div>
            </fieldset>

            {authMode === "phone" && (
              <div>
                <label
                  htmlFor="phone"
                  className="block text-sm font-medium mb-1"
                >
                  Phone Number
                </label>
                <input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleStartAuth()}
                  placeholder="+1234567890"
                  className="w-full p-3 border border-gray-300 rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                />
              </div>
            )}

            <fieldset className="space-y-2">
              <legend className="block text-sm font-medium">Network</legend>
              <div className="grid gap-2">
                {DC_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                      dcMode === option.value
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                        : "border-gray-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="dc-mode"
                      value={option.value}
                      checked={dcMode === option.value}
                      onChange={() => setDcMode(option.value)}
                      className="mt-1"
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">
                        {option.label}
                      </span>
                      <span className="block text-xs text-gray-500">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label
                htmlFor="bridge-url"
                className="block text-sm font-medium mb-1"
              >
                Bridge URL
              </label>
              <input
                id="bridge-url"
                type="url"
                value={bridgeUrl}
                onChange={(e) => setBridgeUrl(e.target.value)}
                placeholder="http://localhost:3000"
                className="w-full p-3 border border-gray-300 rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-gray-500">
                Default bridge: <span className="font-mono">{DEFAULT_BRIDGE_URL}</span>
              </p>
            </div>

            <button
              onClick={handleStartAuth}
              disabled={authMode === "phone" ? !phone.trim() : false}
              className="w-full p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {authMode === "phone" ? "Start Phone Auth" : "Start QR Auth"}
            </button>
          </div>
        )}

        {step === "waiting" && (
          <div className="text-center space-y-4 py-8">
            <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {needsReconnect
                  ? "Connection lost. Reconnect to continue."
                  : status?.state
                    ? STATE_LABELS[status.state] || status.state
                    : "Connecting..."}
              </p>
              <p className="text-xs text-gray-400 font-mono">
                {status?.state || "..."}
              </p>
            </div>
          </div>
        )}

        {step === "code" && (
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
              <p className="text-sm text-blue-700 dark:text-blue-300">
                Verification code sent to <strong>{phone}</strong>
              </p>
            </div>
            <div>
              <label
                htmlFor="code"
                className="block text-sm font-medium mb-1"
              >
                Verification Code
              </label>
              <input
                id="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmitCode()}
                placeholder="12345"
                className="w-full p-3 border border-gray-300 rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-center text-2xl tracking-widest font-mono"
                autoFocus
                maxLength={6}
              />
            </div>
            <button
              onClick={handleSubmitCode}
              disabled={!code.trim()}
              className="w-full p-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              Verify Code
            </button>
          </div>
        )}

        {step === "password" && (
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
              <p className="text-sm text-amber-900">
                Telegram account password required.
              </p>
              {status?.passwordHint && (
                <p className="mt-1 text-xs text-amber-700">
                  Hint: {status.passwordHint}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium mb-1"
              >
                Account Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmitPassword()}
                className="w-full p-3 border border-gray-300 rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-amber-500"
                autoFocus
              />
            </div>
            <button
              onClick={handleSubmitPassword}
              disabled={!password.trim()}
              className="w-full p-3 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors font-medium"
            >
              Verify Password
            </button>
          </div>
        )}

        {step === "qr" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-gray-200 p-4 space-y-3 text-center">
              <p className="text-sm font-medium">
                {status?.state
                  ? STATE_LABELS[status.state] || status.state
                  : "Generating QR token..."}
              </p>
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Telegram login QR code"
                  className="mx-auto h-60 w-60 rounded-lg border border-gray-200 bg-white p-3"
                />
              ) : (
                <div className="mx-auto flex h-60 w-60 items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-400">
                  Waiting for QR token...
                </div>
              )}
              {status?.qrLoginUrl && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    Scan with Telegram mobile: Settings → Devices → Link Desktop Device
                  </p>
                  <pre className="overflow-auto rounded-lg bg-gray-50 p-3 text-left text-[11px] text-gray-600">
                    {status.qrLoginUrl}
                  </pre>
                </div>
              )}
              {qrCountdown !== null && (
                <p className="text-xs text-gray-500">
                  Token refresh in about {qrCountdown}s
                </p>
              )}
            </div>
            <button
              onClick={() => void refreshQrToken(sessionKey)}
              className="w-full rounded-lg bg-blue-600 px-3 py-2 text-white"
            >
              Refresh QR Token
            </button>
          </div>
        )}

        {step === "ready" && (
          <div className="space-y-6">
            <div className="p-4 bg-green-50 dark:bg-green-950 rounded-lg border border-green-200 dark:border-green-800">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-green-600 text-lg">&#10003;</span>
                <p className="font-semibold text-green-800 dark:text-green-200">
                  Authenticated
                </p>
              </div>
              {status?.user && (
                <pre className="text-xs mt-2 overflow-auto max-h-40 text-green-700 dark:text-green-300 font-mono">
                  {JSON.stringify(status.user, null, 2)}
                </pre>
              )}
              {status?.sessionRef && (
                <p className="mt-3 text-xs text-green-700 font-mono break-all">
                  Persisted ref: {status.sessionRef}
                </p>
              )}
            </div>

            <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold">Send API Method</h2>
              <input
                type="text"
                value={apiMethod}
                onChange={(e) => setApiMethod(e.target.value)}
                placeholder="messages.GetDialogs"
                className="w-full p-2 border border-gray-300 rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <textarea
                value={apiParams}
                onChange={(e) => setApiParams(e.target.value)}
                placeholder='{"limit": 10}'
                className="w-full p-2 border border-gray-300 rounded-lg bg-background text-foreground text-sm font-mono h-20 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleSendMethod}
                disabled={!apiMethod.trim()}
                className="w-full p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                Send
              </button>
              {apiResult && (
                <pre className="text-xs overflow-auto max-h-60 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg font-mono border border-gray-200 dark:border-gray-700">
                  {JSON.stringify(apiResult, null, 2)}
                </pre>
              )}
            </div>

            <button
              onClick={handleLogout}
              className="w-full rounded-lg bg-gray-700 px-3 py-2 text-white"
            >
              Logout
            </button>
          </div>
        )}

        {step === "error" && (
          <div className="space-y-4">
            <div className="p-4 bg-red-50 dark:bg-red-950 rounded-lg border border-red-200 dark:border-red-800">
              <p className="font-semibold text-red-800 dark:text-red-200">
                Error
              </p>
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                {status?.error || "Unknown error"}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="w-full p-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-medium"
            >
              Start Over
            </button>
          </div>
        )}

        {sessionKey && (
          <div className="space-y-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            <div className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Bridge Health</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    isHealthy(health?.status)
                      ? "bg-green-100 text-green-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {health?.status || status?.socketStatus || "unknown"}
                </span>
              </div>
              <p className="text-xs text-gray-500 font-mono truncate">
                Socket: {health?.socketId || "n/a"}
              </p>
              <p className="text-xs text-gray-500">
                Uptime: {health?.uptimeSecs ?? 0}s
              </p>
              <p className="text-xs text-gray-500">
                RX/TX: {health?.bytesRx ?? 0} / {health?.bytesTx ?? 0}
              </p>
              <p className="text-xs text-gray-500">
                Checked: {health?.lastCheckedAt ? new Date(health.lastCheckedAt).toLocaleTimeString() : "n/a"}
              </p>
              {health?.error && (
                <p className="text-xs text-red-600">{health.error}</p>
              )}
            </div>
            <p className="text-xs text-gray-400 font-mono truncate">
              Bridge: {bridgeUrl}
            </p>
            <p className="text-xs text-gray-400 font-mono truncate">
              Session: {sessionKey}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
