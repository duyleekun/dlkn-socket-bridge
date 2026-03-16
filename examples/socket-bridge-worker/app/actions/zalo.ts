"use server";

import { cookies } from "next/headers";
import { env as cfEnv } from "cloudflare:workers";

const SESSION_COOKIE_NAME = "zalo_session";

function getEnv(): Env {
  return cfEnv as unknown as Env;
}

async function cookieStore() {
  return cookies();
}

async function importCookieKey(secret: string, usage: KeyUsage) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret.slice(0, 32).padEnd(32, "0"));
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

/**
 * Restore a Zalo session from the encrypted cookie.
 * This is one of the few server actions needed — most auth flow
 * goes through agent.call() over the WebSocket directly.
 */
export async function restoreSessionFromCookie(): Promise<{
  restored: boolean;
  instanceId?: string;
}> {
  const env = getEnv();
  const store = await cookieStore();
  const cookie = store.get(SESSION_COOKIE_NAME)?.value;

  if (!cookie || !env.ZALO_SESSION_COOKIE_SECRET) {
    return { restored: false };
  }

  try {
    const key = await importCookieKey(env.ZALO_SESSION_COOKIE_SECRET, "decrypt");

    const raw = Uint8Array.from(
      atob(decodeURIComponent(cookie)),
      (c) => c.charCodeAt(0),
    );
    const iv = raw.slice(0, 12);
    const ciphertext = raw.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );

    const instanceId = new TextDecoder().decode(decrypted);
    return { restored: true, instanceId };
  } catch {
    return { restored: false };
  }
}

export async function persistSessionCookie(instanceId: string): Promise<void> {
  const env = getEnv();
  if (!env.ZALO_SESSION_COOKIE_SECRET) {
    return;
  }
  const store = await cookieStore();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importCookieKey(env.ZALO_SESSION_COOKIE_SECRET, "encrypt");
  const plaintext = new TextEncoder().encode(instanceId);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );

  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.length);

  store.set(SESSION_COOKIE_NAME, btoa(String.fromCharCode(...payload)), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

/**
 * Clear the Zalo session cookie (logout helper).
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookieStore();
  store.delete(SESSION_COOKIE_NAME);
}
