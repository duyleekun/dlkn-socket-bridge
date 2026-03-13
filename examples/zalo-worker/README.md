# Zalo Worker

A Vinext-powered Cloudflare Worker demo for Zalo QR login, bridge-backed WebSocket connectivity, and callback-driven session state.

## How it works

This app follows the same core setup as `/Users/duyle/Downloads/workspaces/vinext-agents-example`:

- `vinext()` provides the Next.js-on-Vite runtime
- `@cloudflare/vite-plugin` runs the Worker locally in the `rsc` environment
- `worker/index.ts` is the single Worker entry point
- bridge callbacks are handled at `POST /cb/:callbackKey`
- everything else is delegated to `vinext/server/app-router-entry`

Unlike the agent example, this project also depends on a separate local Rust socket bridge for realtime Zalo traffic.

## Local development

1. Install dependencies from the workspace root:

```bash
pnpm install
```

2. Make sure `examples/zalo-worker/.dev.vars` exists.

Required local values:

```bash
ZALO_SESSION_COOKIE_SECRET=local-dev-secret
WORKER_URL=http://127.0.0.1:8787
```

Notes:

- `ZALO_SESSION_COOKIE_SECRET` is used by the server actions to encrypt the persisted session cookie.
- `WORKER_URL` should be the public origin of the running Worker in local dev so the Rust bridge can post callbacks back into the app.

3. Start the Rust bridge from the workspace root:

```bash
pnpm dev:bridge
```

4. Start the Zalo app from the workspace root:

```bash
pnpm dev:zalo
```

This starts Vinext on [http://127.0.0.1:5173](http://127.0.0.1:5173) with a strict local port.

## Callback and restore behavior

- QR login happens through `zca-js` over HTTP.
- After login, the Worker creates a bridge session and registers a callback URL under `/cb/:callbackKey`.
- Inbound bridge frames and close events are fed directly back into the state machine from the Worker entry.
- Session restore uses the encrypted cookie plus persisted session metadata to either:
  - reuse a healthy live bridge session, or
  - rebuild a new bridge session from persisted credentials

## Secrets and deployment

For production deployment, configure the same values with Wrangler secrets and bindings:

- `ZALO_SESSION_COOKIE_SECRET`
- `WORKER_URL`
- `ZALO_KV` namespace in `wrangler.jsonc`

Deploy with:

```bash
pnpm --filter zalo-worker run deploy
```

## Optional live smoke test

If you want to validate the full QR -> bridge -> listening flow outside the UI, run:

```bash
node --import tsx scripts/zalo-live-smoke.ts
```

That script writes the QR image to `/tmp/zalo-live-smoke-qr.png` and waits for the state machine to reach `listening`.
