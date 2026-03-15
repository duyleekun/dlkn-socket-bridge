"use client";

import { useEffect, useRef } from "react";
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

interface SocketActivityLogProps {
  entries: SocketActivity[];
}

export function SocketActivityLog({ entries }: SocketActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(entries.length);

  useEffect(() => {
    if (entries.length > prevLengthRef.current && scrollRef.current) {
      const el = scrollRef.current;
      const isNearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (isNearBottom) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Socket Activity
        </h3>
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
          {entries.length} events
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border p-4 text-center text-xs text-muted">
          No socket activity yet. Waiting for frames...
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="activity-log activity-scroll max-h-72 space-y-0.5 overflow-y-auto rounded-lg"
        >
          {entries.map((entry) => {
            const cfg = KIND_CONFIG[entry.kind] ?? {
              icon: "?",
              color: "text-muted",
            };
            return (
              <div
                key={entry.id}
                className="activity-row flex items-start gap-2 rounded px-3 py-1.5 text-xs"
              >
                <span className={`${cfg.color} w-4 text-center font-bold`}>
                  {cfg.icon}
                </span>
                <span className="text-muted shrink-0 w-20">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
                <span className="flex-1 truncate text-foreground">
                  {entry.label}
                </span>
                {entry.byteLen != null && (
                  <span className="shrink-0 text-muted">
                    {entry.byteLen}B
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
