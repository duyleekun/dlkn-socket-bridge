"use client";

import { useEffect, useState } from "react";

interface QRDisplayProps {
  qrCode: string | null;
  expiresAt: number | null;
  onRefresh?: () => void;
  label?: string;
}

export function QRDisplay({
  qrCode,
  expiresAt,
  onRefresh,
  label = "Scan with your app",
}: QRDisplayProps) {
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setCountdown(null);
      return;
    }
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((expiresAt - Date.now()) / 1000),
      );
      setCountdown(remaining);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const isExpired = countdown !== null && countdown <= 0;
  const progress =
    expiresAt && countdown !== null
      ? Math.max(0, countdown / ((expiresAt - Date.now() + countdown * 1000) / 1000 || 1))
      : 1;

  // Simpler progress calculation: assume QR lives ~60s
  const pct =
    countdown !== null && expiresAt
      ? Math.min(100, Math.max(0, (countdown / 60) * 100))
      : 100;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div className="relative inline-block rounded-xl bg-white p-4">
        {qrCode ? (
          <>
            <img
              src={
                qrCode.startsWith("data:")
                  ? qrCode
                  : `data:image/png;base64,${qrCode}`
              }
              alt="Login QR code"
              className={`h-56 w-56 rounded-lg transition-all ${
                isExpired ? "blur-sm" : ""
              }`}
            />
            {isExpired && (
              <div className="qr-expired-overlay absolute inset-0 flex flex-col items-center justify-center rounded-xl">
                <span className="text-lg font-bold text-white">QR Expired</span>
                {onRefresh && (
                  <button
                    onClick={onRefresh}
                    className="mt-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
                  >
                    Refresh
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex h-56 w-56 items-center justify-center text-sm text-zinc-400">
            <div className="animate-spin h-8 w-8 border-3 border-primary border-t-transparent rounded-full" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        {countdown !== null && !isExpired && (
          <div className="flex items-center gap-2 text-xs text-muted">
            {/* Circular progress indicator */}
            <svg className="h-5 w-5 -rotate-90" viewBox="0 0 20 20">
              <circle
                cx="10"
                cy="10"
                r="8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                opacity="0.2"
              />
              <circle
                cx="10"
                cy="10"
                r="8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={`${(pct / 100) * 50.27} 50.27`}
                className="text-primary"
              />
            </svg>
            <span>{countdown}s</span>
          </div>
        )}
        {onRefresh && !isExpired && (
          <button
            onClick={onRefresh}
            className="text-xs text-primary hover:underline"
          >
            Refresh QR
          </button>
        )}
      </div>
    </div>
  );
}
