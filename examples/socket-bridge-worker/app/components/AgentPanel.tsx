"use client";

import type { ReactNode } from "react";
import { StatusBadge } from "./StatusBadge";

interface AgentPanelShellProps {
  accentClassName: string;
  instanceId: string;
  phase: string;
  socketStatus: string;
  title: string;
  children: ReactNode;
}

interface PanelMessageProps {
  children: ReactNode;
  tone?: "default" | "success" | "warning" | "error";
}

interface PanelButtonProps {
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}

const TONE_CLASS_NAMES: Record<NonNullable<PanelMessageProps["tone"]>, string> = {
  default: "border-card-border bg-surface text-muted",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-error/30 bg-error/10 text-error",
};

export function AgentPanelShell({
  accentClassName,
  instanceId,
  phase,
  socketStatus,
  title,
  children,
}: AgentPanelShellProps) {
  return (
    <div className="card space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className={`h-3 w-3 rounded-full ${accentClassName}`} />
            <p className="text-xs font-semibold uppercase tracking-widest text-muted">
              {title}
            </p>
          </div>
          <StatusBadge phase={phase} socketStatus={socketStatus} />
        </div>
        <div className="text-right text-[11px] text-muted">
          <div className="font-medium text-foreground">Instance</div>
          <div className="max-w-[12rem] truncate">{instanceId}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

export function PanelSection({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-card-border bg-surface p-4">
      {(title || description) && (
        <div className="space-y-1">
          {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
          {description && <p className="text-xs text-muted">{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

export function PanelMessage({
  children,
  tone = "default",
}: PanelMessageProps) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${TONE_CLASS_NAMES[tone]}`}>
      {children}
    </div>
  );
}

export function PanelButton({
  children,
  className = "",
  fullWidth = false,
  onClick,
  type = "button",
}: PanelButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      className={`rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${fullWidth ? "w-full" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

export function ActionGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}
