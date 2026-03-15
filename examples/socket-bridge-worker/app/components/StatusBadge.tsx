"use client";

import type { SocketActivity } from "../../agents/shared/types";

const KIND_CONFIG: Record<
  SocketActivity["kind"],
  { icon: string; color: string }
> = {
  frame_in: { icon: "\u2193", color: "text-cyan-400" },
  frame_out: { icon: "\u2191", color: "text-blue-400" },
  connected: { icon: "\u26A1", color: "text-success" },
  disconnected: { icon: "\u2717", color: "text-error" },
  error: { icon: "\u26A0", color: "text-warning" },
  fsm_transition: { icon: "\u2192", color: "text-purple-400" },
};

interface StatusBadgeProps {
  phase: string;
  socketStatus: string;
  accent?: "telegram" | "zalo";
}

const PHASE_COLORS: Record<string, string> = {
  idle: "bg-zinc-700 text-zinc-300",
  connecting: "bg-yellow-900/50 text-warning",
  waiting_phone: "bg-yellow-900/50 text-warning",
  waiting_code: "bg-yellow-900/50 text-warning",
  waiting_password: "bg-yellow-900/50 text-warning",
  waiting_qr_scan: "bg-yellow-900/50 text-warning",
  qr_expired: "bg-red-900/50 text-error",
  qr_pending: "bg-yellow-900/50 text-warning",
  qr_scanned: "bg-emerald-900/50 text-success",
  authenticating: "bg-yellow-900/50 text-warning",
  authenticated: "bg-emerald-900/50 text-success",
  recovering: "bg-orange-900/50 text-warning",
  error: "bg-red-900/50 text-error",
};

const SOCKET_DOT_COLORS: Record<string, string> = {
  disconnected: "bg-zinc-500",
  connecting: "bg-warning",
  connected: "bg-success",
  error: "bg-error",
};

export function StatusBadge({ phase, socketStatus }: StatusBadgeProps) {
  const phaseClass = PHASE_COLORS[phase] ?? "bg-zinc-700 text-zinc-300";
  const dotClass = SOCKET_DOT_COLORS[socketStatus] ?? "bg-zinc-500";

  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${phaseClass}`}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
        {phase}
      </span>
    </div>
  );
}
