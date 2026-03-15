"use client";

import { useState } from "react";
import type { ParsedPacketEntry } from "../../agents/shared/types";

interface PacketLogViewerProps {
  /** Recent packets from Agent state (live broadcast, last 50) */
  packets: ParsedPacketEntry[];
  /** Called when user clicks "Load All" — should call agent.call("getFullPacketLog", []) */
  onLoadAll?: () => void;
  fullLoaded?: boolean;
}

const KIND_COLOR: Record<string, string> = {
  rpc_result: "text-blue-400",
  update: "text-emerald-400",
  service: "text-violet-400",
  unknown: "text-zinc-400",
};

export function PacketLogViewer({
  packets,
  onLoadAll,
  fullLoaded = false,
}: PacketLogViewerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Decrypted Frames
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Worker-parsed MTProto packets
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-surface border border-card-border px-2.5 py-0.5 text-xs font-medium text-muted">
            {packets.length}{fullLoaded ? "" : "+"}
          </span>
          {!fullLoaded && onLoadAll && (
            <button
              onClick={onLoadAll}
              className="rounded-full bg-surface border border-card-border px-2.5 py-0.5 text-xs font-medium text-muted hover:text-foreground transition-colors"
            >
              Load All
            </button>
          )}
        </div>
      </div>

      {/* Empty */}
      {packets.length === 0 && (
        <div className="rounded-xl border border-dashed border-card-border p-6 text-center">
          <p className="text-sm text-muted">No decrypted frames yet.</p>
        </div>
      )}

      {/* Packet list */}
      <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
        {[...packets].reverse().map((entry) => {
          const isOpen = expanded.has(entry.id);
          return (
            <article
              key={entry.id}
              className="rounded-xl border border-card-border bg-surface overflow-hidden"
            >
              {/* Row header */}
              <button
                type="button"
                onClick={() => toggle(entry.id)}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/50 transition-colors"
              >
                {/* Kind pill */}
                <span
                  className={`mt-0.5 shrink-0 text-[10px] font-bold uppercase tracking-widest ${KIND_COLOR[entry.kind] ?? "text-zinc-400"}`}
                >
                  {entry.kind.replace("_", " ")}
                </span>

                {/* Summary */}
                <span className="flex-1 min-w-0 text-sm text-foreground truncate">
                  {entry.summary}
                </span>

                {/* Error badge */}
                {entry.error && (
                  <span className="shrink-0 rounded-full bg-error/20 px-2 py-0.5 text-[10px] font-medium text-error">
                    err
                  </span>
                )}

                {/* Chevron */}
                <svg
                  className={`shrink-0 h-3.5 w-3.5 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div className="border-t border-card-border px-3 pb-3 pt-2 space-y-2">
                  {/* Metadata grid */}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
                    <div>
                      <dt className="inline font-medium text-zinc-400">msgId</dt>{" "}
                      <dd className="inline font-mono">{entry.msgId}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-zinc-400">seqNo</dt>{" "}
                      <dd className="inline font-mono">{entry.seqNo}</dd>
                    </div>
                    {entry.topLevelClassName && (
                      <div className="col-span-2">
                        <dt className="inline font-medium text-zinc-400">className</dt>{" "}
                        <dd className="inline font-mono text-violet-300">{entry.topLevelClassName}</dd>
                      </div>
                    )}
                    {entry.requestName && (
                      <div className="col-span-2">
                        <dt className="inline font-medium text-zinc-400">method</dt>{" "}
                        <dd className="inline font-mono text-blue-300">{entry.requestName}</dd>
                      </div>
                    )}
                    {entry.resultClassName && (
                      <div className="col-span-2">
                        <dt className="inline font-medium text-zinc-400">result</dt>{" "}
                        <dd className="inline font-mono text-emerald-300">{entry.resultClassName}</dd>
                      </div>
                    )}
                    {entry.error && (
                      <div className="col-span-2">
                        <dt className="inline font-medium text-error">error</dt>{" "}
                        <dd className="inline text-error/80">{entry.error}</dd>
                      </div>
                    )}
                    <div className="col-span-2 text-zinc-500">
                      {new Date(entry.receivedAt).toLocaleTimeString()}
                    </div>
                  </dl>

                  {/* Payload */}
                  <pre className="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-[11px] font-mono text-zinc-200 overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
                    {JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
