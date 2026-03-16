import type { ZaloUserProfile } from "zca-js-statemachine";

export interface ZaloProfileSource {
  uid?: string | null;
  displayName?: string | null;
  avatar?: string | null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return "";
}

export function mergeUserProfile(
  primary?: ZaloProfileSource | null,
  fallback?: ZaloProfileSource | null,
): ZaloUserProfile {
  return {
    uid: firstNonEmpty(primary?.uid, fallback?.uid),
    displayName: firstNonEmpty(primary?.displayName, fallback?.displayName),
    avatar: firstNonEmpty(primary?.avatar, fallback?.avatar),
  };
}
