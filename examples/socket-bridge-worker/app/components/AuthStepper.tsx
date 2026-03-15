"use client";

interface Step {
  key: string;
  label: string;
}

interface AuthStepperProps {
  steps: Step[];
  currentKey: string;
  completedKeys: string[];
}

export function AuthStepper({
  steps,
  currentKey,
  completedKeys,
}: AuthStepperProps) {
  const currentIdx = steps.findIndex((s) => s.key === currentKey);

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, idx) => {
        const isCompleted = completedKeys.includes(step.key);
        const isCurrent = step.key === currentKey;
        const isPast = idx < currentIdx;

        return (
          <div key={step.key} className="flex items-center gap-1">
            {idx > 0 && (
              <div
                className={`h-px w-4 sm:w-6 ${
                  isPast || isCompleted
                    ? "bg-success"
                    : isCurrent
                      ? "bg-primary"
                      : "bg-zinc-700"
                }`}
              />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-all ${
                  isCompleted
                    ? "bg-success text-white"
                    : isCurrent
                      ? "border-2 border-primary text-primary pulse-ring"
                      : "border border-zinc-600 text-zinc-500"
                }`}
              >
                {isCompleted ? (
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  <span className="text-[10px]">{idx + 1}</span>
                )}
              </div>
              <span
                className={`text-[10px] leading-tight ${
                  isCurrent ? "text-foreground" : "text-muted"
                }`}
              >
                {step.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const TELEGRAM_STEPS: Step[] = [
  { key: "idle", label: "Start" },
  { key: "connecting", label: "Connect" },
  { key: "auth", label: "Verify" },
  { key: "authenticated", label: "Done" },
];

export const ZALO_STEPS: Step[] = [
  { key: "idle", label: "Start" },
  { key: "qr_pending", label: "QR" },
  { key: "qr_scanned", label: "Scanned" },
  { key: "authenticating", label: "Auth" },
  { key: "authenticated", label: "Done" },
];

export function getTelegramStepperState(phase: string) {
  const authPhases = [
    "waiting_phone",
    "waiting_code",
    "waiting_password",
    "waiting_qr_scan",
    "qr_expired",
  ];
  let currentKey = phase;
  if (authPhases.includes(phase)) currentKey = "auth";

  const completedKeys: string[] = [];
  const order = ["idle", "connecting", "auth", "authenticated"];
  const idx = order.indexOf(currentKey);
  if (idx > 0) {
    for (let i = 0; i < idx; i++) completedKeys.push(order[i]);
  }
  return { currentKey, completedKeys };
}

export function getZaloStepperState(phase: string) {
  const completedKeys: string[] = [];
  const order = [
    "idle",
    "qr_pending",
    "qr_scanned",
    "authenticating",
    "authenticated",
  ];
  const idx = order.indexOf(phase);
  if (idx > 0) {
    for (let i = 0; i < idx; i++) completedKeys.push(order[i]);
  }
  return { currentKey: phase, completedKeys };
}
