export type AuthStep =
  | "configure"
  | "qr_generating"
  | "qr_ready"
  | "qr_scanned"
  | "socket_connecting"
  | "listening"
  | "error";

export type RecoverySocketStatus =
  | "healthy"
  | "unknown"
  | "stale"
  | "closed"
  | "error"
  | undefined;

export interface ZaloStatusLike {
  phase: string;
  view?: {
    hasQrCode?: boolean;
    errorMessage?: string;
  } | null;
}

export function isRemoteLogoutMessage(message?: string): boolean {
  return (
    typeof message === "string" &&
    (
      message.includes("Zalo session ended remotely") ||
      message.includes("WebSocket closed: error (1000)")
    )
  );
}

export function deriveAuthStep(statusData: ZaloStatusLike | null): AuthStep {
  if (!statusData) return "configure";

  switch (statusData.phase) {
    case "error":
      return "error";
    case "listening":
      return "listening";
    case "logged_in":
    case "ws_connecting":
    case "reconnecting":
      return "socket_connecting";
    case "qr_scanned":
      return "qr_scanned";
    case "qr_awaiting_scan":
      return statusData.view?.hasQrCode ? "qr_ready" : "qr_generating";
    case "qr_connecting":
      return "qr_generating";
    case "idle":
      return "configure";
    default:
      return "qr_generating";
  }
}

export function describeRuntimeStage(
  restoring: boolean,
  step: AuthStep,
  errorMessage?: string,
): { label: string; detail: string } {
  if (restoring) {
    return {
      label: "Restoring session",
      detail: "Checking for a saved session and bridge socket before showing login.",
    };
  }

  switch (step) {
    case "socket_connecting":
      return {
        label: "Connecting realtime socket",
        detail: "Authenticated successfully. Waiting for the bridge callback path to finish the WebSocket handshake.",
      };
    case "listening":
      return {
        label: "Listening",
        detail: "Bridge callbacks are flowing and the session is ready to receive realtime messages.",
      };
    case "qr_scanned":
      return {
        label: "Waiting for confirmation",
        detail: "The QR was scanned. Zalo is finalizing the HTTP login before the bridge reconnect starts.",
      };
    case "error":
      if (isRemoteLogoutMessage(errorMessage)) {
        return {
          label: "Signed out remotely",
          detail: "This Zalo session was ended from another device. Start a fresh QR login to continue.",
        };
      }
      return {
        label: "Session error",
        detail: "The current session can no longer continue. Start a new QR login to recover.",
      };
    default:
      return {
        label: "Session status",
        detail: "Ready to start a new QR login.",
      };
  }
}

export function isHealthySocket(status: RecoverySocketStatus): boolean {
  return status === "healthy" || status === "unknown" || status === undefined;
}

export function shouldShowRecoveryBanner(
  status: RecoverySocketStatus,
  errorMessage?: string,
): boolean {
  if (isRemoteLogoutMessage(errorMessage)) {
    return false;
  }
  return status === "stale" || status === "closed" || status === "error";
}

export function getOutboundPanelState(step: AuthStep): "hidden" | "disabled" {
  return step === "listening" ? "disabled" : "hidden";
}
