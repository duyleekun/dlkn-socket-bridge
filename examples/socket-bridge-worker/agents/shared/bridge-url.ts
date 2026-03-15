export const DEFAULT_BRIDGE_URL = "http://localhost:3000";

export function normalizeUrl(url: string): string {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    throw new Error("URL is required");
  }

  return normalizedUrl.replace(/\/+$/, "");
}

export function resolveBridgeUrl(bridgeUrl?: string | null): string {
  const normalizedBridgeUrl = bridgeUrl?.trim();
  if (normalizedBridgeUrl) {
    return normalizeUrl(normalizedBridgeUrl);
  }

  return DEFAULT_BRIDGE_URL;
}
