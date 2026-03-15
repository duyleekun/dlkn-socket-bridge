interface Env {
  TELEGRAM_AGENT: DurableObjectNamespace;
  ZALO_AGENT: DurableObjectNamespace;
  BRIDGE_KV: KVNamespace;
  ASSETS: Fetcher;
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  TELEGRAM_SESSION_COOKIE_SECRET: string;
  ZALO_SESSION_COOKIE_SECRET: string;
  BRIDGE_URL: string;
}
