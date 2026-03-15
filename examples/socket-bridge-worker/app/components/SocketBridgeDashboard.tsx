"use client";

import { useState } from "react";
import TelegramPanel from "./TelegramPanel";
import ZaloPanel from "./ZaloPanel";

type Tab = "telegram" | "zalo";

export default function SocketBridgeDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("telegram");

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Socket Bridge Dashboard
          </h1>
          <p className="text-sm text-muted">
            Realtime Telegram + Zalo bridge via Cloudflare Workers
          </p>
        </div>

        {/* Mobile tab switcher */}
        <div className="flex gap-1 p-1 rounded-xl bg-surface lg:hidden">
          {(["telegram", "zalo"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                activeTab === tab
                  ? tab === "telegram"
                    ? "tab-active-telegram text-white shadow-lg"
                    : "tab-active-zalo text-white shadow-lg"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab === "telegram" ? "Telegram" : "Zalo"}
            </button>
          ))}
        </div>

        {/* Desktop: side by side; Mobile: tab-switched */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div className={activeTab !== "telegram" ? "hidden lg:block" : ""}>
            <TelegramPanel instanceId="default" />
          </div>
          <div className={activeTab !== "zalo" ? "hidden lg:block" : ""}>
            <ZaloPanel instanceId="default" />
          </div>
        </div>
      </div>
    </div>
  );
}
