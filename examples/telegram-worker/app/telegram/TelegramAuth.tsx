"use client";

import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getConversations,
  getBridgeSocketHealth,
  getPacketLog,
  getResult,
  getStatus,
  logoutSession,
  refreshConversations,
  sendConversationMessage,
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
  ConversationOption,
  ParsedPacketEntry,
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
}

interface RequestResultData {
  className?: string;
  payload?: unknown;
  error?: string;
  pending?: boolean;
}

function hasPacketEnvelope(packet: ParsedPacketEntry): boolean {
  return packet.msgId !== "0" || packet.seqNo !== 0 || Boolean(packet.reqMsgId);
}

function deriveTestDcOtp(
  phone: string,
  dcMode: DcMode,
  phoneCodeLength?: number,
): string | null {
  if (dcMode !== "test") {
    return null;
  }
  const normalized = phone.replace(/[^\d+]/g, "");
  const match = normalized.match(/^(?:\+?99966|\+799966)(\d)\d{4}$/);
  if (!match) {
    return null;
  }
  const length = phoneCodeLength && phoneCodeLength > 0 ? phoneCodeLength : 5;
  return match[1].repeat(length);
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
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [conversationsUpdatedAt, setConversationsUpdatedAt] = useState(0);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [messageText, setMessageText] = useState("");
  const [messageResult, setMessageResult] = useState<RequestResultData | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [apiMethod, setApiMethod] = useState("");
  const [apiParams, setApiParams] = useState("{}");
  const [apiResult, setApiResult] = useState<RequestResultData | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isRefreshingConversations, setIsRefreshingConversations] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const qrRefreshRef = useRef<number | null>(null);
  const step: Step = status?.view?.screen ?? "phone";

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
        setAuthMode(restored.view?.authMode || "phone");
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
    if (!sessionKey || step !== "ready") {
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
    if (!sessionKey || step !== "ready") {
      setConversations([]);
      setConversationsUpdatedAt(0);
      setSelectedConversationId("");
      return;
    }

    const pollConversations = async () => {
      const nextCache = await getConversations(sessionKey);
      if ("error" in nextCache) {
        return;
      }
      setConversations(nextCache.items);
      setConversationsUpdatedAt(nextCache.updatedAt);
      setSelectedConversationId((current) => {
        if (current && nextCache.items.some((item) => item.id === current)) {
          return current;
        }
        return nextCache.items[0]?.id || "";
      });
    };

    void pollConversations();
    const interval = setInterval(() => {
      void pollConversations();
    }, 1500);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (!sessionKey || step !== "ready") return;
    if (conversationsUpdatedAt > 0) return;

    let cancelled = false;
    void (async () => {
      setIsRefreshingConversations(true);
      try {
        await refreshConversations(sessionKey);
      } finally {
        if (!cancelled) {
          setIsRefreshingConversations(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationsUpdatedAt, sessionKey, step]);

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
    if (!sessionKey || step !== "qr" || !status?.view?.qrExpiresAt) return;

    const msUntilRefresh = Math.max(status.view.qrExpiresAt - Date.now() - 5000, 0);
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
  }, [sessionKey, status?.view?.qrExpiresAt, step]);

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
      setPacketLog([]);
      setConversations([]);
      setConversationsUpdatedAt(0);
      setSelectedConversationId("");
      setMessageText("");
      setMessageResult(null);
      setApiResult(null);
    } catch (err) {
      setStatus(createErrorStatus(err instanceof Error ? err.message : String(err)));
    }
  }

  async function handleSubmitCode() {
    if (!code.trim()) return;
    try {
      const result = await submitCode(sessionKey, code.trim()) as StatusData | { error?: string };
      if ("error" in result && result.error) {
        setStatus(createErrorStatus(result.error));
        return;
      }
      setStatus(result as StatusData);
    } catch (err) {
      setStatus(createErrorStatus(err instanceof Error ? err.message : String(err)));
    }
  }

  async function handleSubmitPassword() {
    if (!password.trim()) return;
    try {
      const result = await submitPassword(sessionKey, password) as StatusData | { error?: string };
      setPassword("");
      if ("error" in result && result.error) {
        setStatus(createErrorStatus(result.error));
        return;
      }
      setStatus(result as StatusData);
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
        setAuthMode(restored.view?.authMode || authMode);
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
    setConversations([]);
    setConversationsUpdatedAt(0);
    setSelectedConversationId("");
    setMessageText("");
    setMessageResult(null);
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
        setApiResult({ pending: true });
        const poll = setInterval(async () => {
          const res = await getResult(sessionKey, result.requestId!) as RequestResultData;
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

  async function handleRefreshConversations() {
    try {
      setIsRefreshingConversations(true);
      const result = await refreshConversations(sessionKey) as { requestId?: string; error?: string };
      if (result.error) {
        setMessageResult({ error: result.error });
        return;
      }
    } catch (err) {
      setMessageResult({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsRefreshingConversations(false);
    }
  }

  async function handleSendConversationMessage() {
    if (!selectedConversationId || !messageText.trim()) return;
    try {
      setIsSendingMessage(true);
      setMessageResult({ pending: true });
      const result = await sendConversationMessage(
        sessionKey,
        selectedConversationId,
        messageText.trim(),
      ) as { requestId?: string; error?: string };
      if (result.error) {
        setMessageResult({ error: result.error });
        return;
      }

      if (result.requestId) {
        const poll = setInterval(async () => {
          const res = await getResult(sessionKey, result.requestId!) as RequestResultData;
          if (res && !res.pending) {
            clearInterval(poll);
            setMessageResult(res);
            setMessageText("");
            void handleRefreshConversations();
          }
        }, 500);
        setTimeout(() => clearInterval(poll), 30000);
      }
    } catch (err) {
      setMessageResult({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSendingMessage(false);
    }
  }

  const qrExpiry = status?.view?.qrExpiresAt;
  const qrCountdown = qrExpiry
    ? Math.max(0, Math.ceil((qrExpiry - Date.now()) / 1000))
    : null;
  const testOtpHint = deriveTestDcOtp(
    phone,
    dcMode,
    status?.view?.codeLength,
  );
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId,
  );

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
                  : status?.view?.statusText || "Connecting..."}
              </p>
              <p className="text-xs text-gray-400 font-mono">
                {status?.view?.protocolPhase || "..."}
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
              {testOtpHint && (
                <p className="mt-1 text-xs text-blue-600 dark:text-blue-300">
                  Test DC detected. Suggested OTP: <span className="font-mono">{testOtpHint}</span>
                </p>
              )}
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
                placeholder={testOtpHint || "12345"}
                className="w-full p-3 border border-gray-300 rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-center text-2xl tracking-widest font-mono"
                autoFocus
                maxLength={status?.view?.codeLength || 6}
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
              {status?.view?.passwordHint && (
                <p className="mt-1 text-xs text-amber-700">
                  Hint: {status.view.passwordHint}
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
                {status?.view?.statusText || "Generating QR token..."}
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
              {status?.view?.qrLoginUrl && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    Scan with Telegram mobile: Settings → Devices → Link Desktop Device
                  </p>
                  <pre className="overflow-auto rounded-lg bg-gray-50 p-3 text-left text-[11px] text-gray-600">
                    {status.view.qrLoginUrl}
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
              {status?.view?.user && (
                <pre className="text-xs mt-2 overflow-auto max-h-40 text-green-700 dark:text-green-300 font-mono">
                  {JSON.stringify(status.view.user, null, 2)}
                </pre>
              )}
              {status?.sessionRef && (
                <p className="mt-3 text-xs text-green-700 font-mono break-all">
                  Persisted ref: {status.sessionRef}
                </p>
              )}
            </div>

            <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Recent Conversations</h2>
                <button
                  onClick={handleRefreshConversations}
                  disabled={isRefreshingConversations}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                >
                  {isRefreshingConversations ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              <select
                value={selectedConversationId}
                onChange={(e) => setSelectedConversationId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-background p-2 text-sm"
              >
                <option value="" disabled>
                  {conversations.length > 0
                    ? "Select a conversation"
                    : "No conversations loaded yet"}
                </option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title}
                    {conversation.unreadCount
                      ? ` (${conversation.unreadCount} unread)`
                      : ""}
                  </option>
                ))}
              </select>
              {selectedConversation && (
                <p className="text-xs text-gray-500">
                  {selectedConversation.subtitle || selectedConversation.peerType}
                </p>
              )}
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Type a plain text message"
                className="w-full h-24 resize-y rounded-lg border border-gray-300 bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleSendConversationMessage}
                disabled={!selectedConversationId || !messageText.trim() || isSendingMessage}
                className="w-full p-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                {isSendingMessage ? "Sending..." : "Send Message"}
              </button>
              {messageResult && (
                <pre className="text-xs overflow-auto max-h-48 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg font-mono border border-gray-200 dark:border-gray-700">
                  {JSON.stringify(messageResult, null, 2)}
                </pre>
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

            <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold">Recent Parsed Packets</h2>
              {packetLog.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 p-3 text-xs text-gray-500">
                  Waiting for inbound packets...
                </div>
              ) : (
                <div className="space-y-2">
                  {packetLog.slice().reverse().map((packet) => (
                    <div
                      key={packet.id}
                      className="rounded-lg border border-gray-200 bg-white p-3 text-xs text-slate-900 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="font-semibold text-slate-900">{packet.className}</span>
                          {packet.envelopeClassName &&
                            packet.envelopeClassName !== packet.className && (
                              <span className="ml-2 text-[11px] text-slate-500">
                                via {packet.envelopeClassName}
                              </span>
                            )}
                        </div>
                        <span className="text-slate-500">
                          {new Date(packet.receivedAt).toLocaleTimeString()}
                        </span>
                      </div>
                      {hasPacketEnvelope(packet) && (
                        <p className="mt-1 break-all font-mono text-[11px] text-slate-500">
                          {packet.msgId !== "0" ? `msgId=${packet.msgId}` : ""}
                          {packet.msgId !== "0" && packet.seqNo !== 0 ? " " : ""}
                          {packet.seqNo !== 0 ? `seqNo=${packet.seqNo}` : ""}
                          {packet.reqMsgId ? ` reqMsgId=${packet.reqMsgId}` : ""}
                          {packet.requiresAck ? " acked" : ""}
                        </p>
                      )}
                      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] text-slate-100">
                        {JSON.stringify(packet.payload, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
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
                {status?.view?.error || "Unknown error"}
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
