# dlkn-socket-bridge

This repo is configured as a `pnpm` workspace so the example apps can consume the local packages directly from source during development. You do not need to build package `dist/` outputs before starting the examples.

## Workspace structure

- `packages/gramjs-statemachine` - Telegram session/state-machine package used by the Telegram example.
- `packages/zca-js-statemachine` - Zalo session/state-machine package used by the Zalo example.
- `packages/dlkn-socket-bridge-rs` - Rust package for the socket bridge work.
- `examples/socket-bridge-worker` - Socket bridge worker example for both Telegram and Zalo.

## Local development

Install all workspace dependencies from the repo root:

```bash
pnpm install
```

Run only the Rust socket bridge:

```bash
pnpm dev:bridge-rs
```

This runs the Rust bridge through its workspace package wrapper, always in watch mode, and installs `cargo-watch` automatically if needed.
If `cargo run` fails, the watch session exits immediately instead of waiting for another file change.

Start the Socket bridge worker together with the Rust bridge:

```bash
pnpm dev:bridge-worker
```

This also uses `concurrently --kill-others-on-fail`. The bridge still binds to `127.0.0.1:3000`, while the Socket bridge worker uses Vite's normal dev-server port selection.

Before starting `pnpm dev:bridge-worker`, make sure [examples/socket-bridge-worker/.dev.vars](/Users/duyle/Downloads/workspaces/dlkn-socket-bridge/examples/socket-bridge-worker/.dev.vars) exists with:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`

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
