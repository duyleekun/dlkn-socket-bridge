"use client";

import { useEffect, useRef, useState } from "react";
import {
  startAuth,
  getStatus,
  getQRCode,
  checkSocketHealth,
  restoreSessionFromCookie,
  recoverBridgeSession,
  logoutSession,
  getMessageLog,
  initiateQRLogin,
  sendZaloMessage,
} from "../actions/zalo";
import type { StatusData } from "../actions/zalo";
import { DEFAULT_BRIDGE_URL } from "../../worker/bridge-url";
import type { ZaloMessage } from "../../worker/types";
import type { BridgeSocketHealth } from "../../worker/socket-health";
import {
  deriveAuthStep,
  describeRuntimeStage,
  getOutboundPanelState,
  isHealthySocket,
  isRemoteLogoutMessage,
  type RecoverySocketStatus,
  shouldShowRecoveryBanner,
} from "./status";

function statusBadgeClasses(status?: RecoverySocketStatus): string {
  if (isHealthySocket(status)) {
    return "bg-green-100 text-green-700";
  }
  return "bg-red-100 text-red-700";
}

function createErrorState(message: string): StatusData {
  return {
    phase: "error",
    view: {
      phase: "error",
      isConnected: false,
      isLoggedIn: false,
      hasQrCode: false,
      errorMessage: message,
    },
    socketStatus: "unknown",
  };
}

export default function ZaloAuth() {
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE_URL);
  const [sessionKey, setSessionKey] = useState("");
  const [status, setStatus] = useState<StatusData | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState<number | null>(null);
  const [messages, setMessages] = useState<ZaloMessage[]>([]);
  const [socketHealth, setSocketHealth] = useState<BridgeSocketHealth | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [selfMessage, setSelfMessage] = useState("Self-test from Zalo Worker UI");
  const [sendInProgress, setSendInProgress] = useState(false);
  const [sendStatus, setSendStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [recoveringBridge, setRecoveringBridge] = useState(false);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const pendingAutoScrollRef = useRef(false);
  const loginTriggeredRef = useRef(false);

  const step = deriveAuthStep(status);
  const runtimeStage = describeRuntimeStage(
    restoring,
    step,
    status?.view.errorMessage,
  );
  const currentSocketStatus =
    step === "error" ? status?.socketStatus : socketHealth?.status || status?.socketStatus;
  const needsRecovery =
    Boolean(sessionKey) &&
    shouldShowRecoveryBanner(currentSocketStatus, status?.view.errorMessage);
  const outboundPanelState = getOutboundPanelState(step);
  const qrCountdown = qrExpiresAt
    ? Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1000))
    : null;
  const checkedAt = socketHealth?.lastCheckedAt || status?.socketLastCheckedAt;
  const userProfile = status?.view.userProfile;

  function shouldStickMessageListToBottom(): boolean {
    const container = messagesScrollRef.current;
    if (!container) return false;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= 48;
  }

  function replaceMessages(nextMessages: ZaloMessage[]): void {
    pendingAutoScrollRef.current =
      nextMessages.length > messages.length && shouldStickMessageListToBottom();
    setMessages(nextMessages);
  }

  async function resolveSelfSendOutcome(
    expectedText: string,
    fallbackMessage: string,
  ): Promise<boolean> {
    if (!sessionKey) return false;
    const log = await getMessageLog(sessionKey);
    pendingAutoScrollRef.current = true;
    replaceMessages(log);
    const now = Date.now();
    const matched = [...log].reverse().find(
      (message) =>
        message.content === expectedText &&
        now - message.timestamp < 30_000,
    );
    if (!matched) return false;
    setSendStatus({
      kind: "success",
      message:
        matched.id && matched.id !== "0"
          ? `${fallbackMessage} Message id: ${matched.id}`
          : fallbackMessage,
    });
    setSelfMessage("Self-test from Zalo Worker UI");
    return true;
  }

  useEffect(() => {
    if (!pendingAutoScrollRef.current) return;
    const container = messagesScrollRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
    pendingAutoScrollRef.current = false;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await restoreSessionFromCookie(
          DEFAULT_BRIDGE_URL,
          window.location.origin,
        );
        if (cancelled) return;
        setRestoring(false);
        if (restored.restored) {
          setSessionKey(restored.sessionKey);
          setStatus(restored);
          setSocketHealth(restored.health ?? null);
        }
      } catch {
        if (!cancelled) setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionKey || step === "configure" || step === "error") return;
    const interval = setInterval(async () => {
      const nextStatus = await getStatus(sessionKey);
      if (nextStatus) setStatus(nextStatus);
    }, 500);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (!sessionKey || (step !== "qr_generating" && step !== "qr_ready")) return;
    const interval = setInterval(async () => {
      const qr = await getQRCode(sessionKey);
      if (!qr) return;
      setQrExpiresAt(qr.expiresAt);
      if (qr.qrImage) {
        const img = qr.qrImage.startsWith("data:")
          ? qr.qrImage
          : `data:image/png;base64,${qr.qrImage}`;
        setQrImage(img);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (!sessionKey || loginInProgress || loginTriggeredRef.current) return;
    if (step !== "qr_generating") return;

    loginTriggeredRef.current = true;
    setLoginInProgress(true);
    void (async () => {
      const result = await initiateQRLogin(
        sessionKey,
        bridgeUrl,
        window.location.origin,
      );
      setLoginInProgress(false);
      if (!result.success && result.error) {
        setErrorMsg(result.error);
        setStatus(createErrorState(result.error));
      }
    })();
  }, [sessionKey, step, bridgeUrl, loginInProgress]);

  useEffect(() => {
    if (!sessionKey || step !== "listening") return;
    const interval = setInterval(async () => {
      const log = await getMessageLog(sessionKey);
      replaceMessages(log);
    }, 1000);
    void getMessageLog(sessionKey).then(replaceMessages);
    return () => clearInterval(interval);
  }, [sessionKey, step, messages.length]);

  useEffect(() => {
    if (!sessionKey || (step !== "socket_connecting" && step !== "listening")) return;
    const poll = async () => {
      const health = await checkSocketHealth(sessionKey);
      if (!("error" in health)) {
        setSocketHealth(health);
      }
    };
    void poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [sessionKey, step]);

  useEffect(() => {
    if (step === "error") {
      setSocketHealth(null);
    }
  }, [step]);

  async function handleStartAuth() {
    setErrorMsg("");
    loginTriggeredRef.current = false;
    try {
      const result = await startAuth({
        bridgeUrl,
        workerUrl: window.location.origin,
      });
      setSessionKey(result.sessionKey);
      setQrImage("");
      setQrExpiresAt(null);
      setMessages([]);
      setSocketHealth(null);
      setStatus({
        phase: "qr_connecting",
        view: {
          phase: "qr_connecting",
          isConnected: false,
          isLoggedIn: false,
          hasQrCode: false,
        },
        socketStatus: "unknown",
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleLogout() {
    await logoutSession(sessionKey || undefined);
    setSessionKey("");
    setStatus(null);
    setQrImage("");
    setQrExpiresAt(null);
    setMessages([]);
    setSocketHealth(null);
    setErrorMsg("");
    setSelfMessage("Self-test from Zalo Worker UI");
    setSendStatus(null);
    setSendInProgress(false);
    loginTriggeredRef.current = false;
    setLoginInProgress(false);
    setRecoveringBridge(false);
  }

  async function handleRecoverBridge() {
    if (!sessionKey || recoveringBridge) return;

    setRecoveringBridge(true);
    setErrorMsg("");
    setSendStatus(null);

    try {
      const recovered = await recoverBridgeSession(
        sessionKey,
        bridgeUrl,
        window.location.origin,
      );
      if (!recovered.restored) {
        await handleLogout();
        return;
      }

      setSessionKey(recovered.sessionKey);
      setStatus(recovered);
      setSocketHealth(recovered.health ?? null);
      const log = await getMessageLog(recovered.sessionKey);
      pendingAutoScrollRef.current = true;
      replaceMessages(log);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error));
      setStatus(
        createErrorState(
          error instanceof Error
            ? error.message
            : "Bridge recovery failed. Start a fresh QR login if the problem persists.",
        ),
      );
    } finally {
      setRecoveringBridge(false);
    }
  }

  async function handleSelfSend() {
    if (!sessionKey || !userProfile?.uid || sendInProgress) return;

    const expectedText = selfMessage.trim();
    if (!expectedText) return;

    setSendInProgress(true);
    setSendStatus(null);
    try {
      const result = await sendZaloMessage(
        sessionKey,
        userProfile.uid,
        0,
        expectedText,
      );

      if (!result.ok) {
        if (
          await resolveSelfSendOutcome(
            expectedText,
            "Sent to your own account.",
          )
        ) {
          return;
        }
        setSendStatus({
          kind: "error",
          message: result.error || "Failed to send self message.",
        });
        return;
      }

      setSendStatus({
        kind: "success",
        message: result.messageId
          ? `Sent to your own UID. Message id: ${result.messageId}`
          : "Sent to your own UID.",
      });
      setSelfMessage("Self-test from Zalo Worker UI");
      pendingAutoScrollRef.current = true;
      const log = await getMessageLog(sessionKey);
      replaceMessages(log);
    } catch (error) {
      if (
        await resolveSelfSendOutcome(
          expectedText,
          "Sent to your own account.",
        )
      ) {
        return;
      }
      setSendStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSendInProgress(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Zalo Auth</h1>
          <p className="text-sm text-gray-500">
            Realtime bridge demo via dlkn-socket-bridge
          </p>
        </div>

        {restoring && (
          <div className="rounded-lg border border-gray-200 p-3 text-sm text-gray-500">
            Restoring persisted session...
          </div>
        )}

        {needsRecovery && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-3">
            <p className="font-medium">Bridge socket is no longer healthy.</p>
            <p>
              {socketHealth?.error || `Status: ${currentSocketStatus || "unknown"}`}
            </p>
            <p className="text-xs text-amber-800">
              Restart the Rust bridge if needed, then recover this session in place without scanning a new QR code.
            </p>
            <button
              onClick={handleRecoverBridge}
              disabled={recoveringBridge}
              className="w-full rounded-lg bg-amber-600 px-3 py-2 text-white disabled:cursor-not-allowed disabled:bg-amber-300"
            >
              {recoveringBridge ? "Recovering..." : "Recover Bridge"}
            </button>
          </div>
        )}

        {(sessionKey || restoring) && (
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">{runtimeStage.label}</p>
              <p className="text-xs text-gray-500">{runtimeStage.detail}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  Phase
                </p>
                <p className="mt-1 font-mono text-sm text-gray-700">
                  {status?.phase || "idle"}
                </p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  Socket
                </p>
                <p className="mt-1">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClasses(currentSocketStatus)}`}
                  >
                    {currentSocketStatus || "unknown"}
                  </span>
                </p>
              </div>
            </div>
          </div>
        )}

        {step === "configure" && !restoring && (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="block text-sm font-medium">Auth Mode</legend>
              <div className="grid grid-cols-1 gap-2">
                <div className="rounded-lg border border-blue-500 bg-blue-50 p-3 text-sm">
                  <p className="font-medium text-blue-700">QR Login</p>
                  <p className="mt-1 text-xs text-blue-600">
                    Zalo uses a QR-first login flow in this worker.
                  </p>
                </div>
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
              className="w-full p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              Start QR Auth
            </button>
          </div>
        )}

        {step === "qr_generating" && (
          <div className="text-center space-y-4 py-8">
            <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Generating QR code...</p>
              <p className="text-xs text-gray-400 font-mono">
                {status?.phase || "qr_connecting"}
              </p>
            </div>
          </div>
        )}

        {step === "qr_ready" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-gray-200 p-4 space-y-3 text-center">
              <p className="text-sm font-medium">Scan with Zalo mobile app</p>
              {qrImage ? (
                <img
                  src={qrImage}
                  alt="Zalo login QR code"
                  className="mx-auto h-60 w-60 rounded-lg border border-gray-200 bg-white p-3"
                />
              ) : (
                <div className="mx-auto flex h-60 w-60 items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-400">
                  Waiting for QR image...
                </div>
              )}
              <div className="space-y-1">
                <p className="text-xs text-gray-500">
                  Scan this QR in Zalo, then confirm the login on your phone.
                </p>
                {qrCountdown !== null && (
                  <p className="text-xs text-gray-500">
                    QR refresh in about {qrCountdown}s
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {step === "qr_scanned" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center space-y-3">
              <div className="animate-spin h-10 w-10 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto" />
              <p className="text-sm font-medium text-emerald-800">
                QR scanned. Confirming login...
              </p>
              <p className="text-xs text-emerald-700">
                Zalo is finishing the HTTP login before the realtime bridge reconnect begins.
              </p>
            </div>
          </div>
        )}

        {step === "socket_connecting" && (
          <div className="space-y-4">
            <div className="text-center space-y-4 py-8">
              <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full mx-auto" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Connecting realtime socket...</p>
                <p className="text-xs text-gray-400 font-mono">
                  Waiting for the first bridge callback frame.
                </p>
              </div>
            </div>

            {userProfile && (
              <div className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-center gap-3">
                  {userProfile.avatar && (
                    <img
                      src={userProfile.avatar}
                      alt="Avatar"
                      className="h-12 w-12 rounded-full border border-blue-200 object-cover"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold truncate">
                      {userProfile.displayName || "Zalo User"}
                    </p>
                    <p className="text-xs text-gray-500 font-mono truncate">
                      UID: {userProfile.uid || "N/A"}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {step === "listening" && (
          <div className="space-y-6">
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-green-600 text-lg">&#10003;</span>
                <p className="font-semibold text-green-800">Authenticated</p>
              </div>
              <div className="flex items-center gap-3">
                {userProfile?.avatar && (
                  <img
                    src={userProfile.avatar}
                    alt="Avatar"
                    className="h-14 w-14 rounded-full border border-green-200 object-cover"
                  />
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-green-900 truncate">
                    {userProfile?.displayName || "Zalo User"}
                  </p>
                  <p className="text-xs text-green-700 font-mono truncate">
                    UID: {userProfile?.uid || "N/A"}
                  </p>
                </div>
              </div>
              {status?.sessionRef && (
                <p className="mt-3 text-xs text-green-700 font-mono break-all">
                  Persisted ref: {status.sessionRef}
                </p>
              )}
            </div>

            <div className="space-y-3 pt-2 border-t border-gray-200">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Message Activity</h2>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {messages.length} message{messages.length === 1 ? "" : "s"}
                </span>
              </div>
              {messages.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 p-3 text-xs text-gray-500">
                  No messages yet. Waiting for incoming messages...
                </div>
              ) : (
                <div
                  ref={messagesScrollRef}
                  className="space-y-2 max-h-72 overflow-y-auto"
                >
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className="rounded-lg border border-gray-200 bg-white p-3 text-xs text-slate-900 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold truncate">
                            {msg.fromId === "0"
                              ? userProfile?.displayName || "You"
                              : msg.fromId}
                          </p>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-500">
                            thread={msg.threadId} type={msg.threadType}
                            {msg.msgType ? ` msgType=${msg.msgType}` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-slate-500">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {msg.recovered && (
                        <p className="mt-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          Recovered while offline
                        </p>
                      )}
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">
                        {msg.content || "(empty message payload)"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {outboundPanelState === "disabled" && (
              <div className="space-y-3 pt-2 border-t border-gray-200">
                <h2 className="text-sm font-semibold">Outbound Messaging</h2>
                <div className="rounded-lg border border-gray-200 bg-slate-50 p-4 space-y-3">
                  <p className="text-sm text-slate-700">
                    Send a direct self-message using your authenticated Zalo session.
                  </p>
                  <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-500">
                    Account UID:{" "}
                    <span className="font-mono text-slate-700">
                      {userProfile?.uid || "not available"}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    The worker resolves your private self thread automatically from the live Zalo session before sending.
                  </p>
                  <textarea
                    value={selfMessage}
                    onChange={(event) => setSelfMessage(event.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 bg-white p-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Write a short message to your own Zalo UID"
                  />
                  <button
                    onClick={handleSelfSend}
                    disabled={!userProfile?.uid || sendInProgress || !selfMessage.trim()}
                    className="w-full rounded-lg bg-blue-600 px-3 py-2 text-white disabled:cursor-not-allowed disabled:bg-blue-300"
                  >
                    {sendInProgress ? "Sending..." : "Send to My UID"}
                  </button>
                  {sendStatus && (
                    <div
                      className={`rounded-lg border p-3 text-sm ${
                        sendStatus.kind === "success"
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-red-200 bg-red-50 text-red-700"
                      }`}
                    >
                      {sendStatus.message}
                    </div>
                  )}
                </div>
              </div>
            )}

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
            <div className="p-4 bg-red-50 rounded-lg border border-red-200">
              <p className="font-semibold text-red-800">
                {isRemoteLogoutMessage(status?.view.errorMessage)
                  ? "Signed Out"
                  : "Error"}
              </p>
              <p className="text-sm text-red-600 mt-1">
                {status?.view.errorMessage || errorMsg || "Unknown error"}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="w-full p-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-medium"
            >
              {isRemoteLogoutMessage(status?.view.errorMessage)
                ? "Sign In Again"
                : "Start Over"}
            </button>
          </div>
        )}

        {errorMsg && step !== "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {errorMsg}
          </div>
        )}

        {sessionKey && (
          <div className="space-y-3 pt-4 border-t border-gray-200">
            <div className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Bridge Health</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClasses(currentSocketStatus)}`}
                >
                  {currentSocketStatus || "unknown"}
                </span>
              </div>
              <p className="text-xs text-gray-500 font-mono truncate">
                Socket: {socketHealth?.socketId || "n/a"}
              </p>
              <p className="text-xs text-gray-500">
                Uptime: {socketHealth?.uptimeSecs ?? 0}s
              </p>
              <p className="text-xs text-gray-500">
                RX/TX: {socketHealth?.bytesRx ?? 0} / {socketHealth?.bytesTx ?? 0}
              </p>
              <p className="text-xs text-gray-500">
                Checked: {checkedAt ? new Date(checkedAt).toLocaleTimeString() : "n/a"}
              </p>
              {socketHealth?.error && (
                <p className="text-xs text-red-600">{socketHealth.error}</p>
              )}
            </div>
            <p className="text-xs text-gray-400 font-mono truncate">
              Bridge: {bridgeUrl}
            </p>
            <p className="text-xs text-gray-400 font-mono truncate">
              Session: {sessionKey}
            </p>
            {status?.sessionRef && (
              <p className="text-xs text-gray-400 font-mono truncate">
                Persisted: {status.sessionRef}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
