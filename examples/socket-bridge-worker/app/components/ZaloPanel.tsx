"use client";

import { useAgent } from "agents/react";
import { useEffect, useRef, useState } from "react";
import { ThreadType } from "zca-js";
import type { ZaloState, SocketActivity } from "../../agents/shared/types";
import { DEFAULT_ZALO_STATE } from "../../agents/shared/types";
import {
  clearSessionCookie,
  persistSessionCookie,
  restoreSessionFromCookie,
} from "../actions/zalo";
import { StatusBadge } from "./StatusBadge";
import { SocketActivityLog } from "./SocketActivityLog";
import { QRDisplay } from "./QRDisplay";
import {
  AuthStepper,
  ZALO_STEPS,
  getZaloStepperState,
} from "./AuthStepper";

interface ZaloPanelProps {
  instanceId: string;
}

type BridgeStatusResult = {
  ok: true;
  status: {
    protocol: string;
    uptime_secs: number;
    bytes_rx: number;
    bytes_tx: number;
  };
} | {
  ok: false;
  error: string;
};

interface RecoverySnapshot {
  lastEventSeq: number;
  lastEventAt: number | null;
  reconnectCount: number;
  phase: string;
  socketStatus: string;
  hasPersistedCredentials: boolean;
  hasActiveBridge: boolean;
  lastUserMessageId: string | null;
  lastUserMessageTs: number | null;
  lastGroupMessageId: string | null;
  lastGroupMessageTs: number | null;
}

interface StoredMessage {
  msgId: string;
  threadId: string;
  senderUid: string;
  content: string;
  ts: number;
  outgoing: boolean;
}

function mergeActivityEntries(
  historical: SocketActivity[] | null,
  live: SocketActivity[],
): SocketActivity[] {
  if (!historical) {
    return live;
  }

  const merged = new Map<string, SocketActivity>();
  for (const entry of historical) {
    merged.set(entry.id, entry);
  }
  for (const entry of live) {
    merged.set(entry.id, entry);
  }

  return Array.from(merged.values()).sort((a, b) => a.ts - b.ts);
}

export default function ZaloPanel({ instanceId }: ZaloPanelProps) {
  const [resolvedInstanceId, setResolvedInstanceId] = useState(instanceId);
  const [state, setState] = useState<ZaloState>(DEFAULT_ZALO_STATE);
  const [ready, setReady] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatusResult | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] = useState<RecoverySnapshot | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<StoredMessage[] | null>(null);
  const [fullActivity, setFullActivity] = useState<SocketActivity[] | null>(null);
  const [threadId, setThreadId] = useState("");
  const [threadType, setThreadType] = useState<number>(ThreadType.User);
  const [messageText, setMessageText] = useState("");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const shouldRecoverRef = useRef(false);

  useEffect(() => {
    let active = true;
    void restoreSessionFromCookie()
      .then((result) => {
        if (!active) return;
        if (result.restored && result.instanceId) {
          setResolvedInstanceId(result.instanceId);
          shouldRecoverRef.current = true;
          return;
        }
        setResolvedInstanceId(instanceId);
        shouldRecoverRef.current = true;
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const agent = useAgent<ZaloState>({
    agent: "zalo-agent",
    name: resolvedInstanceId,
    onStateUpdate: (newState) => setState(newState),
  });

  useEffect(() => {
    if (!ready || !shouldRecoverRef.current) return;
    shouldRecoverRef.current = false;
    void (agent.call("recoverSession", [{ requestOrigin: window.location.origin }]) as Promise<unknown>).catch(() => {
      // Ignore stale-cookie recovery failures; the panel remains usable.
    });
  }, [agent, ready, resolvedInstanceId]);

  const { phase, socketStatus, qrCode, qrExpiresAt, userProfile, error } =
    state;
  const stepper = getZaloStepperState(phase);

  useEffect(() => {
    if (phase !== "authenticated") return;
    void persistSessionCookie(resolvedInstanceId);
  }, [phase, resolvedInstanceId]);

  async function ensureCookie() {
    await persistSessionCookie(resolvedInstanceId);
  }

  async function handleStartQR() {
    setActionFeedback(null);
    await ensureCookie();
    await agent.call("initiateQRLogin", [{ requestOrigin: window.location.origin }]);
  }

  async function handleRetry() {
    await handleStartQR();
  }

  async function handleRecover() {
    setActionFeedback(null);
    await ensureCookie();
    const result = await agent.call("recoverSession", [{ requestOrigin: window.location.origin }]) as
      | { ok: true; lastEventSeq: number; lastEventAt: number | null; reconnectCount: number }
      | { ok: false; error: string };
    if (!result.ok) {
      setActionFeedback(result.error);
      return;
    }
    setActionFeedback("Recovery requested.");
    const snapshot = await agent.call("getRecoveryState", []) as RecoverySnapshot;
    setRecoverySnapshot(snapshot);
  }

  async function handleCheckSocket() {
    setBridgeStatus(await agent.call("getBridgeStatus", []) as BridgeStatusResult);
  }

  async function handleLoadRecovery() {
    const snapshot = await agent.call("getRecoveryState", []) as RecoverySnapshot;
    setRecoverySnapshot(snapshot);
  }

  async function handleLoadMessages() {
    const messages = await agent.call("getMessages", [{ limit: 200 }]) as StoredMessage[];
    setLoadedMessages(messages);
  }

  async function handleLoadActivity() {
    const entries = await agent.call("getFullSocketActivity", [500]) as SocketActivity[];
    setFullActivity(entries);
  }

  async function handleFetchMissing() {
    const result = await agent.call("fetchMissingEvents", []) as {
      ok: boolean;
      error?: string;
      requestedDm: boolean;
      requestedGroup: boolean;
    };
    if (!result.ok) {
      setActionFeedback(result.error ?? "Backlog recovery failed.");
      return;
    }
    setActionFeedback(
      `Requested backlog recovery dm=${result.requestedDm} group=${result.requestedGroup}.`,
    );
  }

  async function handleSendMessage() {
    setActionFeedback(null);
    const result = await agent.call("sendMessage", [{
      threadId,
      threadType,
      text: messageText,
    }]) as { ok: boolean; messageId?: string; error?: string };
    if (!result.ok) {
      setActionFeedback(result.error ?? "Failed to send message.");
      return;
    }
    setMessageText("");
    setActionFeedback(`Sent message ${result.messageId ?? ""}`.trim());
  }

  async function handleLogout() {
    await agent.call("logout", []);
    await clearSessionCookie();
    setBridgeStatus(null);
    setRecoverySnapshot(null);
    setLoadedMessages(null);
    setFullActivity(null);
    setActionFeedback(null);
    setResolvedInstanceId(crypto.randomUUID());
  }

  const activityEntries = mergeActivityEntries(fullActivity, state.socketActivity);
  const displayedMessages = loadedMessages ?? [];

  return (
    <div className="card p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-zalo" />
            <p className="text-xs font-semibold uppercase tracking-widest text-muted">
              Zalo
            </p>
          </div>
          <StatusBadge phase={phase} socketStatus={socketStatus} />
          <p className="text-[11px] text-muted">Instance: {resolvedInstanceId}</p>
        </div>
      </div>

      {!ready && (
        <div className="rounded-lg border border-card-border bg-surface p-4 text-sm text-muted">
          Restoring session context...
        </div>
      )}

      {phase !== "idle" && phase !== "error" && (
        <AuthStepper
          steps={ZALO_STEPS}
          currentKey={stepper.currentKey}
          completedKeys={stepper.completedKeys}
        />
      )}

      {phase === "idle" && ready && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Zalo uses QR-based authentication. Click below to generate a QR code.
          </p>
          <button
            onClick={() => void handleStartQR()}
            className="w-full rounded-lg bg-zalo px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          >
            Scan QR Code
          </button>
        </div>
      )}

      {phase === "qr_pending" && (
        <div className="flex flex-col items-center">
          <QRDisplay
            qrCode={qrCode}
            expiresAt={qrExpiresAt}
            onRefresh={() => void handleStartQR()}
            label="Scan with Zalo mobile app"
          />
        </div>
      )}

      {phase === "qr_scanned" && (
        <div className="rounded-lg border border-success/30 bg-success/10 p-4 text-center space-y-3">
          <div className="animate-spin h-8 w-8 border-3 border-success border-t-transparent rounded-full mx-auto" />
          <p className="text-sm font-medium text-success">
            QR Scanned! Waiting for confirmation...
          </p>
          <p className="text-xs text-muted">
            Confirm the login on your Zalo mobile app.
          </p>
        </div>
      )}

      {phase === "authenticating" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="animate-spin h-8 w-8 border-3 border-zalo border-t-transparent rounded-full" />
          <p className="text-sm text-muted">Connecting to Zalo...</p>
        </div>
      )}

      {phase === "recovering" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-center">
            <div className="animate-spin h-8 w-8 border-3 border-warning border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-sm font-medium text-warning">Reconnecting...</p>
            <p className="text-xs text-muted mt-1">
              Re-establishing connection to Zalo servers.
            </p>
          </div>
        </div>
      )}

      {phase === "authenticated" && userProfile && (
        <div className="space-y-4">
          <div className="rounded-lg border border-success/30 bg-success/10 p-4">
            <div className="flex items-center gap-3">
              {userProfile.avatar ? (
                <img
                  src={userProfile.avatar}
                  alt="Avatar"
                  className="h-10 w-10 rounded-full border border-success/30 object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/20 text-success">
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">
                  {userProfile.displayName || "Zalo User"}
                </p>
                <p className="text-xs text-muted truncate">UID: {userProfile.uid}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-card-border bg-surface p-3 text-xs text-muted">
              <p className="font-semibold text-foreground">Recovery</p>
              <p>Seq: {recoverySnapshot?.lastEventSeq ?? state.lastEventSeq ?? 0}</p>
              <p>Reconnects: {recoverySnapshot?.reconnectCount ?? state.reconnectCount}</p>
              <p>Credentials: {recoverySnapshot?.hasPersistedCredentials ? "yes" : "unknown"}</p>
              <p>Bridge: {recoverySnapshot?.hasActiveBridge ? "active" : "idle"}</p>
              <p>
                Last Event:{" "}
                {new Date(recoverySnapshot?.lastEventAt ?? state.lastEventAt ?? 0).getTime() > 0
                  ? new Date(recoverySnapshot?.lastEventAt ?? state.lastEventAt ?? 0).toLocaleTimeString()
                  : "n/a"}
              </p>
              <p className="truncate">
                DM Cursor: {recoverySnapshot?.lastUserMessageId ?? "n/a"}
              </p>
              <p className="truncate">
                Group Cursor: {recoverySnapshot?.lastGroupMessageId ?? "n/a"}
              </p>
            </div>
            <div className="rounded-lg border border-card-border bg-surface p-3 text-xs text-muted">
              <p className="font-semibold text-foreground">Bridge</p>
              {bridgeStatus?.ok ? (
                <>
                  <p>Protocol: {bridgeStatus.status.protocol}</p>
                  <p>Uptime: {bridgeStatus.status.uptime_secs}s</p>
                  <p>RX/TX: {bridgeStatus.status.bytes_rx}/{bridgeStatus.status.bytes_tx}</p>
                </>
              ) : (
                <p>{bridgeStatus?.error ?? "Not checked yet."}</p>
              )}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => void handleRecover()}
              className="rounded-lg border border-card-border bg-surface px-3 py-2 text-sm text-foreground hover:bg-zinc-800"
            >
              Recover Session
            </button>
            <button
              onClick={() => void handleCheckSocket()}
              className="rounded-lg border border-card-border bg-surface px-3 py-2 text-sm text-foreground hover:bg-zinc-800"
            >
              Check Socket
            </button>
            <button
              onClick={() => void handleLoadRecovery()}
              className="rounded-lg border border-card-border bg-surface px-3 py-2 text-sm text-foreground hover:bg-zinc-800"
            >
              Refresh Recovery
            </button>
            <button
              onClick={() => void handleFetchMissing()}
              className="rounded-lg border border-card-border bg-surface px-3 py-2 text-sm text-foreground hover:bg-zinc-800"
            >
              Fetch Missing Events
            </button>
            <button
              onClick={() => void handleLoadMessages()}
              className="rounded-lg border border-card-border bg-surface px-3 py-2 text-sm text-foreground hover:bg-zinc-800"
            >
              Load Messages
            </button>
            <button
              onClick={() => void handleLoadActivity()}
              className="rounded-lg border border-card-border bg-surface px-3 py-2 text-sm text-foreground hover:bg-zinc-800"
            >
              Load Full Activity
            </button>
          </div>

          <div className="space-y-3 rounded-lg border border-card-border bg-surface p-4">
            <p className="text-sm font-semibold text-foreground">Send Message</p>
            <input
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              placeholder="Thread ID"
              className="w-full rounded-lg border border-card-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-zalo focus:ring-2"
            />
            <select
              value={threadType}
              onChange={(event) => setThreadType(Number(event.target.value))}
              className="w-full rounded-lg border border-card-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-zalo focus:ring-2"
            >
              <option value={ThreadType.User}>Direct Message</option>
              <option value={ThreadType.Group}>Group</option>
            </select>
            <textarea
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              placeholder="Message text"
              rows={3}
              className="w-full rounded-lg border border-card-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-zalo focus:ring-2"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void handleSendMessage()}
                className="flex-1 rounded-lg bg-zalo px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
              >
                Send
              </button>
              <button
                onClick={() => void handleLogout()}
                className="rounded-lg border border-card-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-zinc-800"
              >
                Logout
              </button>
            </div>
          </div>

          {displayedMessages.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Stored Messages
                </h3>
                <span className="text-xs text-muted">{displayedMessages.length}</span>
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {displayedMessages.map((msg) => (
                  <div
                    key={msg.msgId}
                    className="rounded-lg bg-surface px-3 py-2 text-xs text-foreground"
                  >
                    <p className="font-medium text-muted">{msg.senderUid || msg.threadId}</p>
                    <p className="truncate">{msg.content}</p>
                    <p className="text-muted mt-0.5">
                      {new Date(msg.ts).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-error/30 bg-error/10 p-4">
            <p className="text-sm font-medium text-error">Error</p>
            <p className="text-xs text-error/80 mt-1">
              {error || "Unknown error"}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => void handleRetry()}
              className="w-full rounded-lg bg-surface border border-card-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-zinc-800 transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={() => void handleRecover()}
              className="w-full rounded-lg bg-surface border border-card-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-zinc-800 transition-colors"
            >
              Recover Session
            </button>
          </div>
        </div>
      )}

      {actionFeedback && (
        <div className="rounded-lg border border-card-border bg-surface p-3 text-xs text-muted">
          {actionFeedback}
        </div>
      )}

      {phase !== "idle" && <SocketActivityLog entries={activityEntries} />}
    </div>
  );
}
