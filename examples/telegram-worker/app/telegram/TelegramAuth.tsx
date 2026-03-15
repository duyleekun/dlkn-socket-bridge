"use client";

import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import {
  getBridgeSocketHealth,
  getPacketLog,
  getStatus,
  getTelegramUpdatesState,
  logoutSession,
  refreshQrToken,
  restoreSessionFromCookie,
  sendTelegramMethod,
  startAuth,
  submitCode,
  submitPassword,
  telegramGetDifference,
  telegramGetState,
} from "../actions/telegram";
import { DEFAULT_BRIDGE_URL } from "../../worker/bridge-url";
import type {
  BridgeSocketHealth,
  ParsedPacketEntry,
  SocketStatus,
  TelegramAuthMode,
  TelegramUpdatesState,
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

interface SessionViewData {
  state?: string;
  protocolPhase?: string;
  screen?: Step;
  statusText?: string;
  authMode?: TelegramAuthMode;
  phone?: string;
  codeLength?: number;
  passwordHint?: string;
  qrLoginUrl?: string;
  qrExpiresAt?: number;
  user?: Record<string, unknown>;
  error?: string;
  canSubmitCode?: boolean;
  canSubmitPassword?: boolean;
  canRefreshQr?: boolean;
}

interface StatusData {
  view?: SessionViewData;
  sessionRef?: string;
  socketStatus?: SocketStatus;
  socketLastCheckedAt?: number;
  socketLastHealthyAt?: number;
  updatesState?: TelegramUpdatesState | null;
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

function isHealthy(status?: SocketStatus): boolean {
  return status === "healthy" || status === "unknown" || status === undefined;
}

function createErrorStatus(message: string): StatusData {
  return {
    view: {
      state: "error",
      protocolPhase: "ERROR",
      screen: "error",
      statusText: "Error",
      error: message,
    },
  };
}

function statusBadgeClass(status?: SocketStatus): string {
  if (isHealthy(status)) {
    return "bg-emerald-100 text-emerald-700";
  }
  return "bg-amber-100 text-amber-800";
}

function readUserLabel(user?: Record<string, unknown>): string {
  if (!user) {
    return "Telegram user";
  }
  if (typeof user.firstName === "string" && user.firstName) {
    return user.firstName;
  }
  if (typeof user.username === "string" && user.username) {
    return user.username;
  }
  return "Telegram user";
}

function formatUpdatesSource(source?: TelegramUpdatesState["source"]): string {
  switch (source) {
    case "getState":
      return "GetState";
    case "getDifference":
      return "GetDifference";
    case "inboundUpdate":
      return "Inbound update";
    default:
      return "unknown";
  }
}

function formatTelegramDate(seconds?: number): string {
  if (typeof seconds !== "number") {
    return "n/a";
  }
  return new Date(seconds * 1000).toLocaleString();
}

export default function TelegramAuth() {
  const [authMode, setAuthMode] = useState<TelegramAuthMode>("phone");
  const [phone, setPhone] = useState("");
  const [dcMode, setDcMode] = useState<DcMode>("test");
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [sessionKey, setSessionKey] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<StatusData | null>(null);
  const [health, setHealth] = useState<BridgeSocketHealth | null>(null);
  const [packetLog, setPacketLog] = useState<ParsedPacketEntry[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [apiMethod, setApiMethod] = useState("");
  const [apiParams, setApiParams] = useState("{}");
  const [apiStatus, setApiStatus] = useState<string | null>(null);
  const [updatesStatus, setUpdatesStatus] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isGettingState, setIsGettingState] = useState(false);
  const [isGettingDifference, setIsGettingDifference] = useState(false);
  const qrRefreshRef = useRef<number | null>(null);
  const step: Step = status?.view?.screen ?? "phone";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await restoreSessionFromCookie(
        DEFAULT_BRIDGE_URL,
        window.location.origin,
      );
      if (cancelled) {
        return;
      }
      setRestoring(false);
      if (restored.restored) {
        setSessionKey(restored.sessionKey);
        setStatus(restored);
        setHealth(restored.health ?? null);
        setAuthMode(restored.view?.authMode || "phone");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionKey || step === "phone" || step === "error") {
      return;
    }

    const interval = setInterval(() => {
      void (async () => {
        const nextStatus = await getStatus(sessionKey);
        if ("error" in nextStatus && nextStatus.error === "not_found") {
          setStatus(createErrorStatus("Session not found"));
          return;
        }
        if (!("error" in nextStatus)) {
          setStatus(nextStatus);
          setAuthMode(nextStatus.view?.authMode || authMode);
        }
      })();
    }, 500);

    return () => clearInterval(interval);
  }, [authMode, sessionKey, step]);

  useEffect(() => {
    if (!sessionKey || step === "phone" || step === "error") {
      return;
    }

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
      if (!("error" in nextHealth)) {
        setHealth(nextHealth);
      }
    };

    void pollHealth();
    const interval = setInterval(() => {
      void pollHealth();
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (!sessionKey || step === "phone") {
      setPacketLog([]);
      return;
    }

    const pollPackets = async () => {
      const nextLog = await getPacketLog(sessionKey);
      if (!("error" in nextLog)) {
        setPacketLog(nextLog);
      }
    };

    void pollPackets();
    const interval = setInterval(() => {
      void pollPackets();
    }, 1000);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (!status?.view?.qrLoginUrl) {
      setQrDataUrl("");
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(status.view.qrLoginUrl, {
      margin: 1,
      width: 240,
    }).then((dataUrl: string) => {
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
  }, [status?.view?.qrLoginUrl]);

  useEffect(() => {
    if (qrRefreshRef.current) {
      window.clearTimeout(qrRefreshRef.current);
      qrRefreshRef.current = null;
    }
    if (!sessionKey || step !== "qr" || !status?.view?.qrExpiresAt) {
      return;
    }

    const msUntilRefresh = Math.max(status.view.qrExpiresAt - Date.now() - 5000, 0);
    qrRefreshRef.current = window.setTimeout(() => {
      void refreshQrToken(sessionKey);
    }, msUntilRefresh);

    return () => {
      if (qrRefreshRef.current) {
        window.clearTimeout(qrRefreshRef.current);
        qrRefreshRef.current = null;
      }
    };
  }, [sessionKey, status?.view?.qrExpiresAt, step]);

  async function handleStartAuth() {
    if (authMode === "phone" && !phone.trim()) {
      return;
    }
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
      setPacketLog([]);
      setApiStatus(null);
      setUpdatesStatus(null);
    } catch (err) {
      setStatus(createErrorStatus(err instanceof Error ? err.message : String(err)));
    }
  }

  async function handleSubmitCode() {
    if (!code.trim()) {
      return;
    }
    try {
      const result = await submitCode(sessionKey, code.trim());
      if ("error" in result && result.error) {
        setStatus(createErrorStatus(result.error));
        return;
      }
      setStatus(result);
    } catch (err) {
      setStatus(createErrorStatus(err instanceof Error ? err.message : String(err)));
    }
  }

  async function handleSubmitPassword() {
    if (!password.trim()) {
      return;
    }
    try {
      const result = await submitPassword(sessionKey, password);
      setPassword("");
      if ("error" in result && result.error) {
        setStatus(createErrorStatus(result.error));
        return;
      }
      setStatus(result);
    } catch (err) {
      setStatus(createErrorStatus(err instanceof Error ? err.message : String(err)));
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
        setApiStatus("Restored a fresh runtime session from the persisted auth session.");
        setUpdatesStatus(restored.updatesState
          ? "Restored the last persisted updates state."
          : "No persisted updates state yet. Run GetState first.");
      } else {
        setStatus(createErrorStatus("No persisted session available to reconnect"));
      }
    } finally {
      setIsReconnecting(false);
    }
  }

  async function handleLogout() {
    await logoutSession(sessionKey || undefined);
    setSessionKey("");
    setCode("");
    setPassword("");
    setStatus(null);
    setHealth(null);
    setPacketLog([]);
    setQrDataUrl("");
    setApiMethod("");
    setApiParams("{}");
    setApiStatus(null);
    setUpdatesStatus(null);
  }

  async function handleSendMethod() {
    if (!apiMethod.trim()) {
      return;
    }
    try {
      const params = JSON.parse(apiParams);
      const result = await sendTelegramMethod(
        sessionKey,
        apiMethod.trim(),
        params,
      );
      if ("error" in result && result.error) {
        setApiStatus(`Error: ${result.error}`);
        return;
      }
      setApiStatus(`Request sent as msg ${result.msgId}. Watch the frame log for the response.`);
    } catch (err) {
      setApiStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleGetState() {
    try {
      setIsGettingState(true);
      const result = await telegramGetState(sessionKey);
      if ("error" in result && result.error) {
        setUpdatesStatus(`Error: ${result.error}`);
        return;
      }
      setStatus(result.status);
      setUpdatesStatus(
        result.updated
          ? `GetState updated pts=${result.updatesState?.pts} qts=${result.updatesState?.qts}.`
          : `GetState sent as msg ${result.msgId}. Waiting for the callback result.`,
      );
    } catch (err) {
      setUpdatesStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGettingState(false);
    }
  }

  async function handleGetDifference() {
    try {
      setIsGettingDifference(true);
      const currentUpdatesState = await getTelegramUpdatesState(sessionKey);
      if ("error" in currentUpdatesState) {
        setUpdatesStatus("Run GetState first to seed the updates state.");
        return;
      }

      const result = await telegramGetDifference(sessionKey);
      if ("error" in result && result.error) {
        setUpdatesStatus(
          result.error === "missing_updates_state"
            ? "Run GetState first to seed the updates state."
            : `Error: ${result.error}`,
        );
        return;
      }
      setStatus(result.status);
      setUpdatesStatus(
        result.updated
          ? `Catch-up finished at pts=${result.updatesState?.pts} seq=${result.updatesState?.seq}.`
          : `GetDifference sent as msg ${result.msgId}. Waiting for the catch-up result.`,
      );
    } catch (err) {
      setUpdatesStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGettingDifference(false);
    }
  }

  const currentSocketStatus = health?.status || status?.socketStatus;
  const needsReconnect = Boolean(sessionKey) && !isHealthy(currentSocketStatus);
  const qrExpiry = status?.view?.qrExpiresAt;
  const qrCountdown = qrExpiry
    ? Math.max(0, Math.ceil((qrExpiry - Date.now()) / 1000))
    : null;
  const updatesState = status?.updatesState;

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
              Telegram Worker
            </p>
            <h1 className="text-3xl font-semibold text-slate-900">Auth + Debug Console</h1>
            <p className="text-sm text-slate-600">
              MTProto auth state lives in the package. This example worker only
              tracks socket health, persisted auth, and decrypted frame logs.
            </p>
          </div>

          {restoring && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              Restoring persisted session...
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`rounded-full px-3 py-1 font-medium ${statusBadgeClass(currentSocketStatus)}`}>
              Socket: {currentSocketStatus || "unknown"}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
              State: {status?.view?.state || "idle"}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
              Phase: {status?.view?.protocolPhase || "INIT"}
            </span>
          </div>

          {needsReconnect && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-medium">Bridge socket is no longer healthy.</p>
              <p className="mt-1">{health?.error || `Status: ${health?.status}`}</p>
              <button
                onClick={handleReconnect}
                disabled={isReconnecting}
                className="mt-3 w-full rounded-xl bg-amber-600 px-3 py-2 text-white disabled:opacity-50"
              >
                {isReconnecting ? "Rebuilding..." : "Rebuild Runtime Session"}
              </button>
            </div>
          )}

          {step === "phone" && (
            <div className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-800">Auth Mode</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(["phone", "qr"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setAuthMode(mode)}
                      className={`rounded-2xl border px-3 py-3 text-sm font-medium ${
                        authMode === mode
                          ? "border-sky-500 bg-sky-50 text-sky-700"
                          : "border-slate-300 text-slate-700"
                      }`}
                    >
                      {mode === "phone" ? "Phone Code" : "QR Login"}
                    </button>
                  ))}
                </div>
              </fieldset>

              {authMode === "phone" && (
                <div className="space-y-1">
                  <label htmlFor="phone" className="text-sm font-medium text-slate-800">
                    Phone Number
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleStartAuth()}
                    placeholder="+1234567890"
                    className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none ring-sky-500 focus:ring-2"
                  />
                </div>
              )}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-800">Network</legend>
                <div className="grid gap-2">
                  {DC_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`rounded-2xl border p-3 ${
                        dcMode === option.value
                          ? "border-sky-500 bg-sky-50"
                          : "border-slate-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="dc-mode"
                        value={option.value}
                        checked={dcMode === option.value}
                        onChange={() => setDcMode(option.value)}
                        className="mr-2"
                      />
                      <span className="font-medium text-slate-800">{option.label}</span>
                      <span className="ml-2 text-sm text-slate-500">{option.description}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="space-y-1">
                <label htmlFor="bridge-url" className="text-sm font-medium text-slate-800">
                  Bridge URL
                </label>
                <input
                  id="bridge-url"
                  type="url"
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none ring-sky-500 focus:ring-2"
                />
              </div>

              <button
                onClick={handleStartAuth}
                className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white"
              >
                Start Session
              </button>
            </div>
          )}

          {step === "waiting" && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              {status?.view?.statusText || "Working..."}
            </div>
          )}

          {step === "code" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-800">Verification Code</p>
                <p className="text-sm text-slate-500">
                  {status?.view?.statusText || "Enter the code from Telegram."}
                </p>
              </div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmitCode()}
                placeholder={`Code (${status?.view?.codeLength || 5} digits)`}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none ring-sky-500 focus:ring-2"
              />
              <button
                onClick={handleSubmitCode}
                className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white"
              >
                Submit Code
              </button>
            </div>
          )}

          {step === "password" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-800">Two-Factor Password</p>
                <p className="text-sm text-slate-500">
                  Hint: {status?.view?.passwordHint || "No hint"}
                </p>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmitPassword()}
                placeholder="Password"
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none ring-sky-500 focus:ring-2"
              />
              <button
                onClick={handleSubmitPassword}
                className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white"
              >
                Submit Password
              </button>
            </div>
          )}

          {step === "qr" && (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-slate-800">Scan QR in Telegram</p>
                <p className="text-sm text-slate-500">
                  {status?.view?.statusText || "Waiting for QR scan"}
                </p>
              </div>
              <div className="flex justify-center rounded-3xl border border-slate-200 bg-slate-50 p-4">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Telegram login QR" className="h-60 w-60 rounded-2xl" />
                ) : (
                  <div className="flex h-60 w-60 items-center justify-center text-sm text-slate-500">
                    Rendering QR...
                  </div>
                )}
              </div>
              <div className="text-sm text-slate-500">
                Expires in: {qrCountdown ?? 0}s
              </div>
              <button
                onClick={() => void refreshQrToken(sessionKey)}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700"
              >
                Refresh QR
              </button>
            </div>
          )}

          {step === "ready" && (
              <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                Authenticated as {readUserLabel(status?.view?.user)}
              </div>
              <dl className="space-y-2 text-sm text-slate-600">
                <div className="flex justify-between gap-4">
                  <dt>Session Ref</dt>
                  <dd className="truncate text-right">{status?.sessionRef || "none"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Socket ID</dt>
                  <dd className="truncate text-right">{health?.socketId || "unknown"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Last Healthy</dt>
                  <dd>{status?.socketLastHealthyAt ? new Date(status.socketLastHealthyAt).toLocaleTimeString() : "n/a"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Socket RX</dt>
                  <dd>{typeof health?.bytesRx === "number" ? health.bytesRx.toLocaleString() : "n/a"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Socket TX</dt>
                  <dd>{typeof health?.bytesTx === "number" ? health.bytesTx.toLocaleString() : "n/a"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Uptime</dt>
                  <dd>{typeof health?.uptimeSecs === "number" ? `${health.uptimeSecs}s` : "n/a"}</dd>
                </div>
              </dl>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-900">Updates State</p>
                    <p className="text-sm text-slate-500">
                      Manual sync tools for catch-up and update-state inspection.
                    </p>
                  </div>
                </div>
                <dl className="mt-4 space-y-2 text-sm text-slate-600">
                  <div className="flex justify-between gap-4">
                    <dt>pts</dt>
                    <dd>{updatesState?.pts ?? "n/a"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>qts</dt>
                    <dd>{updatesState?.qts ?? "n/a"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>date</dt>
                    <dd>{typeof updatesState?.date === "number" ? `${updatesState.date} (${formatTelegramDate(updatesState.date)})` : "n/a"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>seq</dt>
                    <dd>{updatesState?.seq ?? "n/a"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>Source</dt>
                    <dd>{formatUpdatesSource(updatesState?.source)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>Last Updated</dt>
                    <dd>{updatesState?.updatedAt ? new Date(updatesState.updatedAt).toLocaleTimeString() : "n/a"}</dd>
                  </div>
                </dl>
                <div className="mt-4 grid gap-3">
                  <button
                    onClick={handleGetState}
                    disabled={isGettingState}
                    className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 disabled:opacity-50"
                  >
                    {isGettingState ? "Sending GetState..." : "GetState"}
                  </button>
                  <button
                    onClick={handleGetDifference}
                    disabled={isGettingDifference || !updatesState}
                    className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {isGettingDifference
                      ? "Catching Up..."
                      : "GetDifference (Catch Up Messages)"}
                  </button>
                  {updatesStatus && (
                    <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                      {updatesStatus}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === "error" && (
            <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800">
              {status?.view?.error || "Unknown error"}
            </div>
          )}

          {sessionKey && (
            <button
              onClick={handleLogout}
              className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700"
            >
              Logout
            </button>
          )}
        </section>

        <section className="space-y-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                  Manual RPC
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">Send Any Telegram Method</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Requests go through `invokeSessionMethod()`. Responses appear in the frame log below.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4">
              <input
                value={apiMethod}
                onChange={(e) => setApiMethod(e.target.value)}
                placeholder="messages.GetDialogs"
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-slate-900 outline-none ring-sky-500 focus:ring-2"
                disabled={step !== "ready"}
              />
              <textarea
                value={apiParams}
                onChange={(e) => setApiParams(e.target.value)}
                rows={8}
                className="w-full rounded-2xl border border-slate-300 px-4 py-3 font-mono text-sm text-slate-900 outline-none ring-sky-500 focus:ring-2"
                disabled={step !== "ready"}
              />
              <button
                onClick={handleSendMethod}
                disabled={step !== "ready"}
                className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                Send Method
              </button>
              {apiStatus && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  {apiStatus}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                  Frame Log
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">Decrypted Frames</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Bounded log of worker-owned frame parsing for debugging auth and RPC flows.
                </p>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                {packetLog.length} entries
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {packetLog.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
                  No decrypted frames yet.
                </div>
              )}

              {packetLog.slice().reverse().map((entry) => (
                <article key={entry.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                    <span>{entry.kind}</span>
                    {entry.topLevelClassName && <span>{entry.topLevelClassName}</span>}
                    {entry.requestName && <span>{entry.requestName}</span>}
                  </div>
                  <div className="mt-2 text-sm font-medium text-slate-900">{entry.summary}</div>
                  <dl className="mt-3 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
                    <div>msgId: {entry.msgId}</div>
                    <div>seqNo: {entry.seqNo}</div>
                    {entry.reqMsgId && <div>reqMsgId: {entry.reqMsgId}</div>}
                    {entry.resultClassName && <div>result: {entry.resultClassName}</div>}
                    {entry.error && <div className="text-rose-700">error: {entry.error}</div>}
                  </dl>
                  <pre className="mt-3 overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
                    {JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </article>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
