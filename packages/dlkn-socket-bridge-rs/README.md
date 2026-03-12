# dlkn-socket-bridge

Rust HTTP bridge for holding persistent socket connections on behalf of a stateless backend (Python, Node.js, etc.).

The backend talks to this bridge over HTTP:
- create a socket session
- send raw bytes to that session
- receive inbound data via HTTP callbacks
- close the session

## What It Does

- Maintains long-lived outbound connections in Rust
- Exposes a simple HTTP control plane (`/sockets`, `POST /sockets/:id`, `DELETE`)
- Forwards inbound data to a callback URL
- Tracks per-session byte counters and uptime

## Supported Protocols

### `tcp://` (raw TCP)
- Plain TCP connection
- Inbound bytes are buffered and forwarded to the callback URL

### `tls://` / `tcps://` (TLS over TCP)
- TLS connection using the system's native root certificates
- Otherwise identical to raw TCP

### `ws://` / `wss://` (WebSocket)
- Standard WebSocket connection via `tokio-tungstenite`
- Inbound text/binary messages are forwarded to the callback URL as raw bytes

## Buffering / Flushing

For TCP and TLS sessions, inbound bytes can be buffered before being posted to the callback URL. Two optional parameters control this:

- `flush_interval_ms` — post buffered data at most every N milliseconds
- `flush_bytes` — post when the buffer reaches N bytes

If neither is set, each read is posted immediately. The two options can be combined (whichever triggers first flushes).

## Why This Exists

Stateless app servers are not ideal for long-lived socket ownership. This bridge separates concerns:
- backend remains stateless and HTTP-only
- Rust bridge owns persistent sockets and callback fan-out

## API

Base URL examples assume the bridge runs on `http://127.0.0.1:3000`.

### `POST /sockets`

Create a socket session.

Request body:

```json
{
  "target_url": "tls://example.com:443",
  "callback_url": "http://backend.local/socket-callback",
  "flush_interval_ms": 100,
  "flush_bytes": 4096
}
```

`flush_interval_ms` and `flush_bytes` are optional (TCP/TLS only; ignored for WebSocket).

Supported `target_url` schemes:
- `tcp://host:port`
- `tls://host:port` or `tcps://host:port`
- `ws://host[:port]/path` or `wss://host[:port]/path`

Response:

```json
{
  "socket_id": "uuid",
  "send_url": "/sockets/<id>",
  "delete_url": "/sockets/<id>"
}
```

### `GET /sockets` and `GET /sockets/`

Get health for all active sessions.

Response:

```json
[
  {
    "socket_id": "socket-a",
    "protocol": "tls",
    "uptime_secs": 12,
    "bytes_rx": 1024,
    "bytes_tx": 2048
  }
]
```

The response array is sorted by `socket_id`.

### `POST /sockets/:id`

Send raw bytes to the socket session.

- Request body is raw bytes (`application/octet-stream` recommended)
- Returns `200 OK` on success
- Returns `404` if session does not exist

For WebSocket sessions, bytes are sent as a binary frame.

### `GET /sockets/:id`

Get session status/metrics.

Response:

```json
{
  "protocol": "tls",
  "uptime_secs": 12,
  "bytes_rx": 1024,
  "bytes_tx": 2048
}
```

`protocol` is one of `tcp`, `tls`, or `ws`.

### `DELETE /sockets/:id`

Close a session.

- Removes it from the registry immediately
- Signals the engine task to close the connection
- Returns `200 OK` or `404`

## Callback Contract

The engine posts to `callback_url` in the background.

### Inbound data

- `POST {callback_url}`
- Body: raw bytes
- `Content-Type: application/octet-stream`

### Session closed event

- `POST {callback_url}`
- JSON body:

```json
{
  "event": "closed",
  "reason": "remote_close"
}
```

Possible reasons:
- `remote_close`
- `command`
- `command_channel_closed`
- `error`

## Build

### Local (debug)

```bash
cargo build
```

### Linux x86_64 (Ubuntu/Debian GNU/Linux)

Use the helper script:

```bash
./build-linux.sh
```

Behavior:
- On `Linux x86_64`: builds natively
- On other hosts (for example macOS Apple Silicon): automatically falls back to Docker (`linux/amd64`)

Output binary:
- `dist/dlkn-socket-bridge-linux-x86_64`

If build dependencies are missing on Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y pkg-config libssl-dev
```

Optional environment variables for Docker fallback:
- `DOCKER_IMAGE` (default: `rust:1-bookworm`)
- `DOCKER_PLATFORM` (default: `linux/amd64`)
- `FORCE_DOCKER=1` (use Docker even on Linux x86_64)

## Run

```bash
cargo run
```

Environment:
- `BIND_ADDR` (optional, default: `127.0.0.1:3000`)

Example:

```bash
BIND_ADDR=0.0.0.0:3000 cargo run
```

## Quick Dev Workflow

To run the Rust bridge and the Telegram worker example together in one `tmux`
session, use:

```bash
./scripts/dev-tmux.sh
```

This creates a `tmux` session named `dlkn-dev` with two panes:

- Rust bridge on `http://127.0.0.1:3000`
- Telegram app on `http://127.0.0.1:5173`

The script enforces fixed ports:

- bridge uses `BIND_ADDR=127.0.0.1:3000`
- Telegram dev server uses `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`

If either port is already in use, startup fails instead of moving to the next
port.

Requirements:

- `tmux` installed
- `examples/telegram-worker/.dev.vars` present with:
  - `TELEGRAM_API_ID`
  - `TELEGRAM_API_HASH`

Useful commands:

```bash
tmux attach -t dlkn-dev
tmux kill-session -t dlkn-dev
```

In the Telegram UI, keep the bridge URL as `http://localhost:3000` or
`http://127.0.0.1:3000`.
