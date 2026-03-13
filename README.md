# dlkn-socket-bridge

This repo is configured as a `pnpm` workspace so the example apps can consume the local packages directly from source during development. You do not need to build package `dist/` outputs before starting the examples.

## Workspace structure

- `packages/gramjs-statemachine` - Telegram session/state-machine package used by the Telegram example.
- `packages/zca-js-statemachine` - Zalo session/state-machine package used by the Zalo example.
- `packages/dlkn-socket-bridge-rs` - Rust package for the socket bridge work.
- `examples/telegram-worker` - Cloudflare Worker + app example for Telegram.
- `examples/zalo-worker` - Cloudflare Worker + app example for Zalo.

## Local development

Install all workspace dependencies from the repo root:

```bash
pnpm install
```

Run only the Rust socket bridge:

```bash
pnpm dev:bridge
```

This runs the Rust bridge through its workspace package wrapper, always in watch mode, and installs `cargo-watch` automatically if needed.

Start the Telegram app together with the Rust bridge:

```bash
pnpm dev:telegram
```

This uses `pnpm --parallel --stream` to run both workspace packages with prefixed live logs.

This starts:

- bridge uses `BIND_ADDR=127.0.0.1:3000`
- Telegram dev server uses `--host 127.0.0.1 --port 5173 --strictPort`

Before starting `pnpm dev:telegram`, make sure [examples/telegram-worker/.dev.vars](/Users/duyle/Downloads/workspaces/dlkn-socket-bridge/examples/telegram-worker/.dev.vars) exists with:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

Start the Zalo app together with the Rust bridge:

```bash
pnpm dev:zalo
```

This also uses `pnpm --parallel --stream`. The bridge still binds to `127.0.0.1:3000`, while the Zalo app uses Vite's normal dev-server port selection.

Run builds across the workspace:

```bash
pnpm build
```

Run type-checks across the workspace:

```bash
pnpm typecheck
```

Run tests where packages define them:

```bash
pnpm test
```

Run a command for a single workspace package:

```bash
pnpm --filter telegram-worker test:mtproto
pnpm --filter gramjs-statemachine test
```
