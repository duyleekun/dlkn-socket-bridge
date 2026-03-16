"use client";

import { useAgent } from "agents/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ParsedPacketEntry,
  TelegramState,
} from "../../agents/shared/types";
import { DEFAULT_TELEGRAM_STATE } from "../../agents/shared/types";
import {
  clearSessionCookie,
  persistSessionCookie,
  restoreSessionFromCookie,
} from "../actions/telegram";
import { SocketActivityLog } from "./SocketActivityLog";
import { QRDisplay } from "./QRDisplay";
import { PacketLogViewer } from "./PacketLogViewer";
import {
  AuthStepper,
  TELEGRAM_STEPS,
  getTelegramStepperState,
} from "./AuthStepper";
import {
  ActionGrid,
  AgentPanelShell,
  PanelButton,
  PanelMessage,
  PanelSection,
} from "./AgentPanel";

interface TelegramPanelProps {
  instanceId: string;
}

interface TelegramUpdatesState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
  updatedAt: number;
  source?: string;
}

export default function TelegramPanel({ instanceId }: TelegramPanelProps) {
  const [resolvedInstanceId, setResolvedInstanceId] = useState(instanceId);
  const [state, setState] = useState<TelegramState>(DEFAULT_TELEGRAM_STATE);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"qr" | "phone">("qr");
  const [fullPackets, setFullPackets] = useState<ParsedPacketEntry[] | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<{ connected: boolean } | null>(null);
  const [updatesState, setUpdatesState] = useState<TelegramUpdatesState | null>(null);
  const [rpcMethod, setRpcMethod] = useState("help.GetConfig");
  const [rpcParams, setRpcParams] = useState("{}");
  const [toolMessage, setToolMessage] = useState<string | null>(null);
  const shouldRecoverRef = useRef(false);

  function resetToDefaultInstance(message?: string) {
    setResolvedInstanceId(instanceId);
    setState(DEFAULT_TELEGRAM_STATE);
    setFullPackets(null);
    setBridgeStatus(null);
    setUpdatesState(null);
    setToolMessage(message ?? null);
    shouldRecoverRef.current = false;
  }

  const agent = useAgent<TelegramState>({
    agent: "telegram-agent",
    name: resolvedInstanceId,
    onStateUpdate: (newState) => setState(newState),
  });

  useEffect(() => {
    let cancelled = false;

    if (instanceId === "default") {
      setResolvedInstanceId(instanceId);
      shouldRecoverRef.current = true;
      return () => {
        cancelled = true;
      };
    }

    void restoreSessionFromCookie().then((result) => {
      if (cancelled) return;
      if (result.restored && result.instanceId) {
        setResolvedInstanceId(result.instanceId);
        shouldRecoverRef.current = true;
        return;
      }
      setResolvedInstanceId(instanceId);
      shouldRecoverRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!shouldRecoverRef.current) return;
    shouldRecoverRef.current = false;
    void (agent.call("recoverSession", [{ requestOrigin: window.location.origin }]) as Promise<
      { ok: true } | { ok: false; error: string }
    >).then(async (result) => {
      if (result.ok) {
        return;
      }

      if (
        result.error === "Missing persisted Telegram session" &&
        resolvedInstanceId !== instanceId
      ) {
        await clearSessionCookie();
        resetToDefaultInstance();
        shouldRecoverRef.current = true;
      }
    }).catch(() => {
      // Ignore stale-cookie recovery failures; the panel stays interactive.
    });
  }, [agent, resolvedInstanceId]);

  const { phase, socketStatus, qrCode, qrExpiresAt, userProfile, error } =
    state;
  const stepper = getTelegramStepperState(phase);
  const displayedPackets = useMemo(
    () => fullPackets ?? state.parsedPackets,
    [fullPackets, state.parsedPackets],
  );

  useEffect(() => {
    if (phase !== "authenticated") return;
    void persistSessionCookie(resolvedInstanceId);
  }, [phase, resolvedInstanceId]);

  async function rememberInstanceId() {
    await persistSessionCookie(resolvedInstanceId);
  }

  async function handleStartAuth() {
    if (authMode === "phone" && !phone.trim()) return;
    await rememberInstanceId();
    setToolMessage(null);
    await agent.call("startAuth", [
      {
        mode: authMode,
        ...(authMode === "phone" ? { phoneNumber: phone.trim() } : {}),
        requestOrigin: window.location.origin,
      },
    ]);
  }

  async function handleSubmitCode() {
    if (!code.trim()) return;
    setToolMessage(null);
    await agent.call("submitCode", [{ code: code.trim() }]);
    setCode("");
  }

  async function handleSubmitPassword() {
    if (!password.trim()) return;
    setToolMessage(null);
    await agent.call("submitPassword", [{ password: password.trim() }]);
    setPassword("");
  }

  function handleRefreshQr() {
    setToolMessage(null);
    void agent.call("refreshQrToken", []);
  }

  function handleRetry() {
    void handleStartAuth();
  }

  async function handleLogout() {
    await agent.call("logout", []);
    await clearSessionCookie();
    resetToDefaultInstance("Telegram session cleared.");
  }

  async function handleClearLocalSession() {
    await clearSessionCookie();
    resetToDefaultInstance("Local Telegram session cleared.");
  }

  async function handleRecover() {
    const result = await (agent.call("recoverSession", [{ requestOrigin: window.location.origin }]) as Promise<
      { ok: boolean; error?: string }
    >);
    if (
      !result.ok &&
      result.error === "Missing persisted Telegram session" &&
      resolvedInstanceId !== instanceId
    ) {
      await clearSessionCookie();
      resetToDefaultInstance("Retrying recovery on default instance.");
      shouldRecoverRef.current = true;
      return;
    }

    await rememberInstanceId();
    setToolMessage(result.ok ? "Recovery requested." : result.error ?? "Recovery failed.");
  }

  async function handleCheckSocket() {
    const result = await (agent.call("getBridgeSocketHealth", []) as Promise<
      { ok: true; status: { connected: boolean } }
      | { ok: false; error: string }
    >);
    if (result.ok) {
      setBridgeStatus(result.status);
      setToolMessage("Bridge socket status refreshed.");
      return;
    }
    setToolMessage(result.error);
  }

  async function handleLoadUpdatesState() {
    const next = await (agent.call("getTelegramUpdatesState", []) as Promise<TelegramUpdatesState | null>);
    setUpdatesState(next);
    setToolMessage(next ? "Loaded cached Telegram updates state." : "No cached updates state yet.");
  }

  async function handleInvokeState() {
    const result = await (agent.call("telegramGetState", []) as Promise<
      { ok: true; msgId: string } | { ok: false; error: string }
    >);
    setToolMessage(result.ok ? `updates.GetState queued (${result.msgId}).` : result.error);
  }

  async function handleInvokeDifference() {
    const result = await (agent.call("telegramGetDifference", []) as Promise<
      { ok: true; msgId: string } | { ok: false; error: string }
    >);
    setToolMessage(result.ok ? `updates.GetDifference queued (${result.msgId}).` : result.error);
  }

  async function handleManualMethod() {
    let parsedParams: Record<string, unknown> | undefined;
    if (rpcParams.trim()) {
      try {
        parsedParams = JSON.parse(rpcParams) as Record<string, unknown>;
      } catch {
        setToolMessage("RPC params must be valid JSON.");
        return;
      }
    }

    const result = await (agent.call("sendTelegramMethod", [{
      method: rpcMethod,
      params: parsedParams,
    }]) as Promise<{ ok: true; msgId: string } | { ok: false; error: string }>);
    setToolMessage(result.ok ? `${rpcMethod} queued (${result.msgId}).` : result.error);
  }

  async function handleCloseSocket() {
    const result = await (agent.call("closeCurrentSocket", []) as Promise<
      { ok: true } | { ok: false; error: string }
    >);
    setBridgeStatus(null);
    setToolMessage(
      result.ok
        ? "Socket closed. Use Recover session to attach a fresh bridge without clearing Telegram auth."
        : result.error,
    );
  }

  async function handleLoadAllPackets() {
    const all = await (agent.call("getFullPacketLog", []) as Promise<ParsedPacketEntry[]>);
    setFullPackets(all);
  }

  return (
    <AgentPanelShell
      accentClassName="bg-telegram"
      instanceId={resolvedInstanceId}
      phase={phase}
      socketStatus={socketStatus}
      title="Telegram"
    >

      {phase !== "idle" && phase !== "error" && (
        <AuthStepper
          steps={TELEGRAM_STEPS}
          currentKey={stepper.currentKey}
          completedKeys={stepper.completedKeys}
        />
      )}

      {phase === "idle" && (
        <PanelSection
          title="Start session"
          description="Choose how to authenticate this Telegram agent instance."
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">
              Sign-in mode
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {(["qr", "phone"] as const).map((mode) => (
                <PanelButton
                  key={mode}
                  type="button"
                  onClick={() => setAuthMode(mode)}
                  className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-all ${
                    authMode === mode
                      ? "border-telegram bg-telegram/10 text-telegram"
                      : "border-card-border text-muted hover:text-foreground"
                  }`}
                >
                  {mode === "qr" ? "QR sign-in" : "Phone code"}
                </PanelButton>
              ))}
            </div>
          </fieldset>

          {authMode === "phone" && (
            <div className="space-y-1">
              <label htmlFor="tg-phone" className="text-sm font-medium text-foreground">
                Phone Number
              </label>
              <input
                id="tg-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleStartAuth()}
                placeholder="+1234567890"
                className="w-full rounded-lg border border-card-border bg-surface px-4 py-2.5 text-foreground outline-none ring-telegram focus:ring-2"
              />
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <PanelButton
              onClick={() => void handleStartAuth()}
              className="bg-telegram text-white hover:opacity-90"
            >
              Start session
            </PanelButton>
            <PanelButton
              onClick={() => void handleRecover()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800/50"
            >
              Recover session
            </PanelButton>
          </div>
        </PanelSection>
      )}

      {phase === "connecting" && (
        <div className="space-y-3">
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="animate-spin h-8 w-8 border-3 border-telegram border-t-transparent rounded-full" />
            <p className="text-sm text-muted">Connecting to Telegram...</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <PanelButton
              onClick={() => void handleLogout()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Logout
            </PanelButton>
            <PanelButton
              onClick={() => void handleClearLocalSession()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Clear local session
            </PanelButton>
          </div>
        </div>
      )}

      {phase === "waiting_qr_scan" && (
        <div className="space-y-3">
          <div className="flex flex-col items-center">
            <QRDisplay
              qrCode={qrCode}
              expiresAt={qrExpiresAt}
              onRefresh={handleRefreshQr}
              label="Scan with Telegram"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <PanelButton
              onClick={() => void handleLogout()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Logout
            </PanelButton>
            <PanelButton
              onClick={() => void handleClearLocalSession()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Clear local session
            </PanelButton>
          </div>
        </div>
      )}

      {phase === "qr_expired" && (
        <div className="space-y-3 text-center">
          <p className="text-sm text-warning">QR code has expired.</p>
          <PanelButton
            onClick={handleRefreshQr}
            className="bg-telegram py-2 text-white hover:opacity-90"
          >
            Refresh QR
          </PanelButton>
        </div>
      )}

      {phase === "waiting_code" && (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Verification Code</p>
            <p className="text-xs text-muted">
              Enter the code sent to {state.phoneNumber ? state.phoneNumber : "your phone"}
            </p>
          </div>
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSubmitCode()}
            placeholder="12345"
            className="w-full rounded-lg border border-card-border bg-surface px-4 py-2.5 text-center text-lg tracking-widest text-foreground outline-none ring-telegram focus:ring-2"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <PanelButton
              onClick={() => void handleSubmitCode()}
              className="bg-telegram text-white hover:opacity-90 sm:col-span-3"
            >
              Submit code
            </PanelButton>
            <PanelButton
              onClick={() => void handleLogout()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Logout
            </PanelButton>
            <PanelButton
              onClick={() => void handleClearLocalSession()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800 sm:col-span-2"
            >
              Clear local session
            </PanelButton>
          </div>
        </div>
      )}

      {phase === "waiting_password" && (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Two-Factor Password</p>
            <p className="text-xs text-muted">
              Your account has 2FA enabled. Enter your password.
            </p>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSubmitPassword()}
            placeholder="Password"
            className="w-full rounded-lg border border-card-border bg-surface px-4 py-2.5 text-foreground outline-none ring-telegram focus:ring-2"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <PanelButton
              onClick={() => void handleSubmitPassword()}
              className="bg-telegram text-white hover:opacity-90 sm:col-span-3"
            >
              Submit password
            </PanelButton>
            <PanelButton
              onClick={() => void handleLogout()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Logout
            </PanelButton>
            <PanelButton
              onClick={() => void handleClearLocalSession()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800 sm:col-span-2"
            >
              Clear local session
            </PanelButton>
          </div>
        </div>
      )}

      {phase === "authenticated" && userProfile && (
        <div className="space-y-4">
          <div className="rounded-lg border border-success/30 bg-success/10 p-4">
            <div className="flex items-center gap-3">
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
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">
                  {userProfile.firstName}
                  {userProfile.lastName ? ` ${userProfile.lastName}` : ""}
                </p>
                {userProfile.username && (
                  <p className="text-xs text-muted truncate">@{userProfile.username}</p>
                )}
              </div>
            </div>
          </div>

          <ActionGrid>
            <PanelButton
              onClick={() => void handleCheckSocket()}
              className="border border-card-border bg-surface px-3 py-2 text-foreground hover:bg-zinc-800/50"
            >
              Refresh bridge
            </PanelButton>
            <PanelButton
              onClick={() => void handleLoadUpdatesState()}
              className="border border-card-border bg-surface px-3 py-2 text-foreground hover:bg-zinc-800/50"
            >
              Read updates state
            </PanelButton>
            <PanelButton
              onClick={() => void handleInvokeState()}
              className="border border-card-border bg-surface px-3 py-2 text-foreground hover:bg-zinc-800/50"
            >
              updates.GetState
            </PanelButton>
            <PanelButton
              onClick={() => void handleInvokeDifference()}
              className="border border-card-border bg-surface px-3 py-2 text-foreground hover:bg-zinc-800/50"
            >
              updates.GetDifference
            </PanelButton>
            <PanelButton
              onClick={() => void handleRecover()}
              className="border border-card-border bg-surface px-3 py-2 text-foreground hover:bg-zinc-800/50"
            >
              Recover session
            </PanelButton>
            <PanelButton
              onClick={() => void handleCloseSocket()}
              className="border border-error/30 bg-error/10 px-3 py-2 text-error hover:bg-error/15"
            >
              Disconnect socket
            </PanelButton>
          </ActionGrid>

          <PanelSection
            title="Manual RPC"
            description="Queue any Telegram API method against the active session."
          >
            <div className="flex items-center justify-between gap-3">
              <div />
              <PanelButton
                onClick={() => void handleManualMethod()}
                className="bg-telegram px-3 py-2 text-white hover:opacity-90"
              >
                Send
              </PanelButton>
            </div>
            <input
              type="text"
              value={rpcMethod}
              onChange={(e) => setRpcMethod(e.target.value)}
              placeholder="help.GetConfig"
              className="w-full rounded-lg border border-card-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-telegram focus:ring-2"
            />
            <textarea
              value={rpcParams}
              onChange={(e) => setRpcParams(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-card-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-telegram focus:ring-2"
            />
          </PanelSection>

          {bridgeStatus && (
            <pre className="rounded-xl border border-card-border bg-surface p-3 text-xs text-zinc-200 overflow-x-auto">
              {JSON.stringify(bridgeStatus, null, 2)}
            </pre>
          )}

          {updatesState && (
            <pre className="rounded-xl border border-card-border bg-surface p-3 text-xs text-zinc-200 overflow-x-auto">
              {JSON.stringify(updatesState, null, 2)}
            </pre>
          )}

          {state.recentMessages.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                Recent Messages
              </h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {state.recentMessages.slice(-5).map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-lg px-3 py-2 text-xs ${
                      msg.outgoing
                        ? "bg-telegram/10 text-telegram ml-4"
                        : "bg-surface text-foreground mr-4"
                    }`}
                  >
                    <p className="truncate">{msg.text}</p>
                    <p className="text-muted mt-0.5">
                      {new Date(msg.ts).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <PanelButton
              onClick={() => void handleLoadAllPackets()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800/50"
            >
              Load packet history
            </PanelButton>
            <PanelButton
              onClick={() => void handleLogout()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800/50"
            >
              Logout
            </PanelButton>
            <PanelButton
              onClick={() => void handleClearLocalSession()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800/50 sm:col-span-2"
            >
              Clear local session
            </PanelButton>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-3">
          <PanelMessage tone="error">
            <p className="font-medium">Error</p>
            <p className="mt-1 text-xs">{error || "Unknown error"}</p>
          </PanelMessage>
          <div className="grid gap-2 sm:grid-cols-3">
            <PanelButton
              onClick={() => void handleRetry()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Retry
            </PanelButton>
            <PanelButton
              onClick={() => void handleRecover()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Recover session
            </PanelButton>
            <PanelButton
              onClick={() => void handleClearLocalSession()}
              className="border border-card-border bg-surface text-foreground hover:bg-zinc-800"
            >
              Clear local session
            </PanelButton>
          </div>
        </div>
      )}

      {toolMessage && (
        <PanelMessage>{toolMessage}</PanelMessage>
      )}

      {phase !== "idle" && <SocketActivityLog entries={state.socketActivity} />}

      {phase !== "idle" && displayedPackets.length > 0 && (
        <PacketLogViewer
          packets={displayedPackets}
          onLoadAll={fullPackets ? undefined : () => void handleLoadAllPackets()}
          fullLoaded={fullPackets !== null}
        />
      )}
    </AgentPanelShell>
  );
}
