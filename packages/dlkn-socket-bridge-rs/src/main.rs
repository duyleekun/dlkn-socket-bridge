use std::{
    net::SocketAddr,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use axum::{
    body::{to_bytes, Body, Bytes as AxumBytes},
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Client as HttpClient};
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;
use tower::util::ServiceExt;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024; // 16 MB

#[derive(Clone)]
struct AppState {
    registry: Registry,
    http: HttpClient,
}

type Registry = Arc<DashMap<String, SessionMeta>>;

type SharedCounter = Arc<AtomicU64>;

#[derive(Clone)]
struct SessionMeta {
    protocol: Protocol,
    cmd_tx: mpsc::UnboundedSender<BridgeCommand>,
    created_at: Instant,
    bytes_rx: SharedCounter,
    bytes_tx: SharedCounter,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Protocol {
    Tcp,
    Tls,
    Ws,
    LocoFrame,
    MtprotoFrame,
}

enum BridgeCommand {
    Send(Bytes),
    Close,
}

#[derive(Deserialize)]
struct CreateSocketRequest {
    target_url: String,
    callback_url: String,
    flush_interval_ms: Option<u64>,
    flush_bytes: Option<usize>,
}

#[derive(Serialize)]
struct CreateSocketResponse {
    socket_id: String,
    send_url: String,
    delete_url: String,
}

#[derive(Serialize)]
struct SocketStatusResponse {
    protocol: Protocol,
    uptime_secs: u64,
    bytes_rx: u64,
    bytes_tx: u64,
}

#[derive(Serialize)]
struct SocketHealthResponse {
    socket_id: String,
    protocol: Protocol,
    uptime_secs: u64,
    bytes_rx: u64,
    bytes_tx: u64,
}

#[derive(Serialize)]
struct ClosedEvent<'a> {
    event: &'static str,
    reason: &'a str,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

struct FlushConfig {
    interval_ms: Option<u64>,
    bytes: Option<usize>,
}

impl FlushConfig {
    fn is_immediate(&self) -> bool {
        self.interval_ms.is_none() && self.bytes.is_none()
    }
}

fn should_flush(buf: &[u8], last_flush: Instant, flush: &FlushConfig) -> bool {
    if flush.is_immediate() {
        return true;
    }
    if flush.bytes.map_or(false, |n| buf.len() >= n) {
        return true;
    }
    if flush.interval_ms.map_or(false, |ms| {
        last_flush.elapsed() >= Duration::from_millis(ms)
    }) {
        return true;
    }
    false
}

fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/sockets", post(create_socket).get(list_sockets))
        .route("/sockets/", get(list_sockets))
        .route(
            "/sockets/:id",
            get(get_socket_status)
                .post(send_socket)
                .delete(delete_socket),
        )
        .with_state(state)
}

fn socket_status_from_meta(socket_id: String, entry: &SessionMeta) -> SocketHealthResponse {
    SocketHealthResponse {
        socket_id,
        protocol: entry.protocol,
        uptime_secs: entry.created_at.elapsed().as_secs(),
        bytes_rx: entry.bytes_rx.load(Ordering::Relaxed),
        bytes_tx: entry.bytes_tx.load(Ordering::Relaxed),
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "dlkn_socket_bridge=info,axum=info".to_string()),
        )
        .init();

    let state = AppState {
        registry: Arc::new(DashMap::new()),
        http: HttpClient::new(),
    };

    let app = build_app(state);

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let addr = SocketAddr::from_str(&bind_addr).expect("invalid BIND_ADDR");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind listener");

    info!(%addr, "socket bridge listening");
    axum::serve(listener, app).await.expect("server error");
}

async fn create_socket(
    State(state): State<AppState>,
    Json(req): Json<CreateSocketRequest>,
) -> Result<Json<CreateSocketResponse>, ApiError> {
    let target = reqwest::Url::parse(&req.target_url)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("invalid target_url: {e}")))?;
    let callback = reqwest::Url::parse(&req.callback_url).map_err(|e| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid callback_url: {e}"),
        )
    })?;

    let protocol = match target.scheme() {
        "tcp" => Protocol::Tcp,
        "tls" | "tcps" => Protocol::Tls,
        "ws" | "wss" => Protocol::Ws,
        "loco-frame" => Protocol::LocoFrame,
        "mtproto-frame" => Protocol::MtprotoFrame,
        other => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("unsupported scheme: {other} (expected tcp://, tls://, tcps://, ws://, wss://, loco-frame://, or mtproto-frame://)"),
            ))
        }
    };

    let flush = FlushConfig {
        interval_ms: req.flush_interval_ms,
        bytes: req.flush_bytes,
    };

    debug!(
        target_url = %target,
        callback_url = %callback,
        flush_interval_ms = ?flush.interval_ms,
        flush_bytes = ?flush.bytes,
        "creating socket session"
    );

    let socket_id = Uuid::new_v4().to_string();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let bytes_rx = Arc::new(AtomicU64::new(0));
    let bytes_tx = Arc::new(AtomicU64::new(0));

    state.registry.insert(
        socket_id.clone(),
        SessionMeta {
            protocol,
            cmd_tx,
            created_at: Instant::now(),
            bytes_rx: bytes_rx.clone(),
            bytes_tx: bytes_tx.clone(),
        },
    );

    let engine_state = state.clone();
    let engine_socket_id = socket_id.clone();

    tokio::spawn(async move {
        let close_reason = match protocol {
            Protocol::Ws => match run_ws_engine(
                engine_state.clone(),
                target,
                callback.clone(),
                cmd_rx,
                bytes_rx,
                bytes_tx,
                &engine_socket_id,
            )
            .await
            {
                Ok(reason) => reason,
                Err(err) => {
                    error!(socket_id = %engine_socket_id, error = %err, "websocket engine error");
                    "error"
                }
            },
            Protocol::Tcp => match run_tcp_engine(
                engine_state.clone(),
                target,
                callback.clone(),
                cmd_rx,
                bytes_rx,
                bytes_tx,
                &engine_socket_id,
                flush,
                false,
            )
            .await
            {
                Ok(reason) => reason,
                Err(err) => {
                    error!(socket_id = %engine_socket_id, error = %err, "tcp engine error");
                    "error"
                }
            },
            Protocol::Tls => match run_tcp_engine(
                engine_state.clone(),
                target,
                callback.clone(),
                cmd_rx,
                bytes_rx,
                bytes_tx,
                &engine_socket_id,
                flush,
                true,
            )
            .await
            {
                Ok(reason) => reason,
                Err(err) => {
                    error!(socket_id = %engine_socket_id, error = %err, "tls engine error");
                    "error"
                }
            },
            Protocol::LocoFrame => match run_loco_frame_engine(
                engine_state.clone(),
                target,
                callback.clone(),
                cmd_rx,
                bytes_rx,
                bytes_tx,
                &engine_socket_id,
            )
            .await
            {
                Ok(reason) => reason,
                Err(err) => {
                    error!(socket_id = %engine_socket_id, error = %err, "loco-frame engine error");
                    "error"
                }
            },
            Protocol::MtprotoFrame => match run_mtproto_frame_engine(
                engine_state.clone(),
                target,
                callback.clone(),
                cmd_rx,
                bytes_rx,
                bytes_tx,
                &engine_socket_id,
            )
            .await
            {
                Ok(reason) => reason,
                Err(err) => {
                    error!(socket_id = %engine_socket_id, error = %err, "mtproto-frame engine error");
                    "error"
                }
            },
        };

        finalize_session(&engine_state, &engine_socket_id, &callback, close_reason).await;
    });

    Ok(Json(CreateSocketResponse {
        socket_id: socket_id.clone(),
        send_url: format!("/sockets/{socket_id}"),
        delete_url: format!("/sockets/{socket_id}"),
    }))
}

async fn list_sockets(State(state): State<AppState>) -> Json<Vec<SocketHealthResponse>> {
    let mut sockets = state
        .registry
        .iter()
        .map(|entry| socket_status_from_meta(entry.key().clone(), entry.value()))
        .collect::<Vec<_>>();
    sockets.sort_by(|left, right| left.socket_id.cmp(&right.socket_id));
    Json(sockets)
}

async fn send_socket(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: AxumBytes,
) -> Result<StatusCode, ApiError> {
    let Some(entry) = state.registry.get(&id) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown socket_id"));
    };

    debug!(socket_id = %id, bytes = body.len(), "received send request");
    entry
        .cmd_tx
        .send(BridgeCommand::Send(Bytes::from(body.to_vec())))
        .map_err(|_| ApiError::new(StatusCode::GONE, "session command channel closed"))?;

    Ok(StatusCode::OK)
}

async fn get_socket_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SocketStatusResponse>, ApiError> {
    let Some(entry) = state.registry.get(&id) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown socket_id"));
    };

    let status = socket_status_from_meta(id, &entry);
    Ok(Json(SocketStatusResponse {
        protocol: status.protocol,
        uptime_secs: status.uptime_secs,
        bytes_rx: status.bytes_rx,
        bytes_tx: status.bytes_tx,
    }))
}

async fn delete_socket(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let Some((_, meta)) = state.registry.remove(&id) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown socket_id"));
    };

    let _ = meta.cmd_tx.send(BridgeCommand::Close);
    Ok(StatusCode::OK)
}

async fn post_callback_binary(http: &HttpClient, callback_url: &reqwest::Url, payload: Bytes) {
    let payload_len = payload.len();
    debug!(%callback_url, bytes = payload_len, "posting binary callback");
    match http
        .post(callback_url.clone())
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(payload)
        .send()
        .await
    {
        Ok(response) => {
            debug!(
                %callback_url,
                bytes = payload_len,
                status = %response.status(),
                "binary callback completed"
            );
        }
        Err(err) => {
            warn!(%callback_url, error = %err, "failed to post binary callback");
        }
    }
}

async fn post_callback_closed(
    http: &HttpClient,
    callback_url: &reqwest::Url,
    reason: &str,
) {
    debug!(%callback_url, reason, "posting closed callback");
    if let Err(err) = http
        .post(callback_url.clone())
        .json(&ClosedEvent {
            event: "closed",
            reason,
        })
        .send()
        .await
    {
        warn!(%callback_url, error = %err, "failed to post closed callback");
    }
}

async fn finalize_session(
    state: &AppState,
    socket_id: &str,
    callback_url: &reqwest::Url,
    reason: &str,
) {
    state.registry.remove(socket_id);
    post_callback_closed(&state.http, callback_url, reason).await;
    info!(socket_id = %socket_id, reason, "session closed");
}

async fn run_tcp_engine(
    state: AppState,
    target_url: reqwest::Url,
    callback_url: reqwest::Url,
    cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    bytes_rx: SharedCounter,
    bytes_tx: SharedCounter,
    socket_id: &str,
    flush: FlushConfig,
    use_tls: bool,
) -> anyhow::Result<&'static str> {
    let host = target_url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("target missing host"))?
        .to_owned();
    let port = target_url
        .port()
        .ok_or_else(|| anyhow::anyhow!("target missing port"))?;

    let tcp = TcpStream::connect((host.as_str(), port)).await?;

    if use_tls {
        let mut root_store = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs()? {
            root_store.add(cert)?;
        }
        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));
        let server_name = ServerName::try_from(host.as_str())
            .map_err(|e| anyhow::anyhow!("invalid server name: {e}"))?
            .to_owned();
        let tls_stream = connector.connect(server_name, tcp).await?;
        info!(socket_id = %socket_id, host = %host, port, "tls connected");
        run_stream_engine(
            tls_stream,
            state,
            callback_url,
            cmd_rx,
            bytes_rx,
            bytes_tx,
            socket_id,
            flush,
        )
        .await
    } else {
        info!(socket_id = %socket_id, host = %host, port, "tcp connected");
        run_stream_engine(
            tcp,
            state,
            callback_url,
            cmd_rx,
            bytes_rx,
            bytes_tx,
            socket_id,
            flush,
        )
        .await
    }
}

async fn run_stream_engine<S>(
    stream: S,
    state: AppState,
    callback_url: reqwest::Url,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    bytes_rx: SharedCounter,
    bytes_tx: SharedCounter,
    _socket_id: &str,
    flush: FlushConfig,
) -> anyhow::Result<&'static str>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let (mut tcp_rx, mut tcp_tx) = tokio::io::split(stream);
    let mut read_buf = vec![0u8; 8192];
    let mut flush_buf: Vec<u8> = Vec::new();
    let mut last_flush = Instant::now();
    let mut tick = flush
        .interval_ms
        .map(|ms| tokio::time::interval(Duration::from_millis(ms)));

    let close_reason = loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(socket_id = %_socket_id, bytes = data.len(), "stream write");
                        bytes_tx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        tcp_tx.write_all(&data).await?;
                    }
                    Some(BridgeCommand::Close) | None => {
                        break "command";
                    }
                }
            }

            result = tcp_rx.read(&mut read_buf) => {
                let n = result?;
                if n == 0 {
                    break "remote_close";
                }
                debug!(socket_id = %_socket_id, bytes = n, "stream read");
                flush_buf.extend_from_slice(&read_buf[..n]);
                bytes_rx.fetch_add(n as u64, Ordering::Relaxed);
                if should_flush(&flush_buf, last_flush, &flush) {
                    let payload = Bytes::from(std::mem::take(&mut flush_buf));
                    post_callback_binary(&state.http, &callback_url, payload).await;
                    last_flush = Instant::now();
                }
            }

            _ = async {
                if let Some(t) = tick.as_mut() { t.tick().await; }
                else { std::future::pending::<()>().await; }
            } => {
                if !flush_buf.is_empty() {
                    let payload = Bytes::from(std::mem::take(&mut flush_buf));
                    post_callback_binary(&state.http, &callback_url, payload).await;
                    last_flush = Instant::now();
                }
            }
        }
    };

    if !flush_buf.is_empty() {
        let payload = Bytes::from(flush_buf);
        post_callback_binary(&state.http, &callback_url, payload).await;
    }

    Ok(close_reason)
}

async fn run_loco_frame_engine(
    state: AppState,
    target_url: reqwest::Url,
    callback_url: reqwest::Url,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    bytes_rx: SharedCounter,
    bytes_tx: SharedCounter,
    socket_id: &str,
) -> anyhow::Result<&'static str> {
    let host = target_url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("target missing host"))?
        .to_owned();
    let port = target_url
        .port()
        .ok_or_else(|| anyhow::anyhow!("target missing port"))?;

    let tcp = TcpStream::connect((host.as_str(), port)).await?;
    info!(socket_id = %socket_id, host = %host, port, "loco-frame connected");

    let (mut rx, mut tx) = tokio::io::split(tcp);

    let close_reason = loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(socket_id = %socket_id, bytes = data.len(), "loco-frame write");
                        bytes_tx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        tx.write_all(&data).await?;
                    }
                    Some(BridgeCommand::Close) | None => {
                        break "command";
                    }
                }
            }

            result = async {
                let mut hdr = [0u8; 4];
                rx.read_exact(&mut hdr).await?;
                let total_size = u32::from_le_bytes(hdr) as usize;
                if total_size > MAX_FRAME_SIZE {
                    anyhow::bail!("loco frame too large: {total_size} bytes (max {MAX_FRAME_SIZE})");
                }
                // total_size = encryptedLen + 12; full frame = 4 + total_size bytes
                let mut rest = vec![0u8; total_size];
                rx.read_exact(&mut rest).await?;
                let mut frame = Vec::with_capacity(4 + total_size);
                frame.extend_from_slice(&hdr);
                frame.extend_from_slice(&rest);
                Ok::<_, anyhow::Error>(frame)
            } => {
                match result {
                    Ok(frame) => {
                        debug!(socket_id = %socket_id, bytes = frame.len(), "loco-frame read");
                        bytes_rx.fetch_add(frame.len() as u64, Ordering::Relaxed);
                        post_callback_binary(&state.http, &callback_url, Bytes::from(frame)).await;
                    }
                    Err(err) => {
                        if err.downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof)
                        {
                            break "remote_close";
                        }
                        return Err(err);
                    }
                }
            }
        }
    };

    Ok(close_reason)
}

async fn run_mtproto_frame_engine(
    state: AppState,
    target_url: reqwest::Url,
    callback_url: reqwest::Url,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    bytes_rx: SharedCounter,
    bytes_tx: SharedCounter,
    socket_id: &str,
) -> anyhow::Result<&'static str> {
    let host = target_url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("target missing host"))?
        .to_owned();
    let port = target_url
        .port()
        .ok_or_else(|| anyhow::anyhow!("target missing port"))?;

    let tcp = TcpStream::connect((host.as_str(), port)).await?;
    let (mut rx, mut tx) = tokio::io::split(tcp);

    // Send MTProto Intermediate transport identifier
    tx.write_all(&0xeeeeeeeeu32.to_le_bytes()).await?;
    info!(socket_id = %socket_id, host = %host, port, "mtproto-frame connected (intermediate transport)");

    let close_reason = loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(socket_id = %socket_id, bytes = data.len(), "mtproto-frame write");
                        bytes_tx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        tx.write_all(&data).await?;
                    }
                    Some(BridgeCommand::Close) | None => {
                        break "command";
                    }
                }
            }

            result = async {
                let mut hdr = [0u8; 4];
                rx.read_exact(&mut hdr).await?;
                let length_field = u32::from_le_bytes(hdr);

                // High bit set = quick ack (4 bytes total, no payload follows)
                if length_field & 0x80000000 != 0 {
                    debug!(socket_id = %socket_id, ack = true, raw = length_field, "mtproto quick ack read");
                    return Ok(hdr.to_vec());
                }

                let payload_len = length_field as usize;
                if payload_len > MAX_FRAME_SIZE {
                    anyhow::bail!("mtproto frame too large: {payload_len} bytes (max {MAX_FRAME_SIZE})");
                }

                // Return length header + payload as a single frame
                let mut frame = Vec::with_capacity(4 + payload_len);
                frame.extend_from_slice(&hdr);
                let mut payload = vec![0u8; payload_len];
                rx.read_exact(&mut payload).await?;
                frame.extend_from_slice(&payload);
                Ok(frame)
            } => {
                match result {
                    Ok(frame) => {
                        debug!(
                            socket_id = %socket_id,
                            bytes = frame.len(),
                            "mtproto-frame read"
                        );
                        bytes_rx.fetch_add(frame.len() as u64, Ordering::Relaxed);
                        post_callback_binary(&state.http, &callback_url, Bytes::from(frame)).await;
                    }
                    Err(err) => {
                        if err.downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof)
                        {
                            break "remote_close";
                        }
                        return Err(err);
                    }
                }
            }
        }
    };

    Ok(close_reason)
}

async fn run_ws_engine(
    state: AppState,
    target_url: reqwest::Url,
    callback_url: reqwest::Url,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    bytes_rx: SharedCounter,
    bytes_tx: SharedCounter,
    socket_id: &str,
) -> anyhow::Result<&'static str> {
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(target_url.as_str()).await?;
    info!(socket_id = %socket_id, target = %target_url, "websocket connected");

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    let close_reason = loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(socket_id = %socket_id, bytes = data.len(), "websocket write");
                        bytes_tx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        ws_sink.send(Message::Binary(data.to_vec())).await?;
                    }
                    Some(BridgeCommand::Close) => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        break "command";
                    }
                    None => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        break "command_channel_closed";
                    }
                }
            }
            item = ws_stream.next() => {
                match item {
                    Some(Ok(Message::Binary(data))) => {
                        debug!(socket_id = %socket_id, bytes = data.len(), "websocket binary read");
                        bytes_rx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        post_callback_binary(&state.http, &callback_url, Bytes::from(data)).await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let data = text.to_string().into_bytes();
                        debug!(socket_id = %socket_id, bytes = data.len(), "websocket text read");
                        bytes_rx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        post_callback_binary(&state.http, &callback_url, Bytes::from(data)).await;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_sink.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(Message::Close(_))) => {
                        break "remote_close";
                    }
                    Some(Err(err)) => {
                        return Err(err.into());
                    }
                    None => {
                        break "remote_close";
                    }
                }
            }
        }
    };

    Ok(close_reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use tokio::sync::{mpsc, oneshot, Mutex};

    fn test_state() -> AppState {
        AppState {
            registry: Arc::new(DashMap::new()),
            http: HttpClient::new(),
        }
    }

    fn insert_test_socket(
        state: &AppState,
        socket_id: &str,
    ) -> mpsc::UnboundedReceiver<BridgeCommand> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let bytes_rx = Arc::new(AtomicU64::new(128));
        let bytes_tx = Arc::new(AtomicU64::new(256));
        state.registry.insert(
            socket_id.to_string(),
            SessionMeta {
                protocol: Protocol::Tcp,
                cmd_tx,
                created_at: Instant::now(),
                bytes_rx,
                bytes_tx,
            },
        );
        cmd_rx
    }

    async fn send_request(app: Router, request: Request<Body>) -> Response {
        app.oneshot(request).await.expect("request should succeed")
    }

    #[tokio::test]
    async fn create_session_returns_send_url_without_send_suffix() {
        let state = test_state();
        let app = build_app(state);

        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind target listener");
        let target_addr = target_listener.local_addr().expect("target addr");
        let accept_task = tokio::spawn(async move {
            let (_stream, _) = target_listener
                .accept()
                .await
                .expect("accept target socket");
            tokio::time::sleep(Duration::from_millis(200)).await;
        });

        let callback_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind callback listener");
        let callback_addr = callback_listener.local_addr().expect("callback addr");
        let callback_task = tokio::spawn(async move {
            let (_stream, _) = callback_listener
                .accept()
                .await
                .expect("accept callback socket");
        });

        let response = send_request(
            app,
            Request::builder()
                .method("POST")
                .uri("/sockets")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    "{{\"target_url\":\"tcp://{target_addr}\",\"callback_url\":\"http://{callback_addr}/cb\"}}"
                )))
                .expect("build request"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("parse create response");
        let socket_id = json["socket_id"].as_str().expect("socket id");
        assert_eq!(json["send_url"], format!("/sockets/{socket_id}"));
        assert_eq!(json["delete_url"], format!("/sockets/{socket_id}"));

        accept_task.abort();
        callback_task.abort();
    }

    #[tokio::test]
    async fn post_socket_id_sends_bytes_to_session() {
        let state = test_state();
        let mut cmd_rx = insert_test_socket(&state, "socket-1");
        let app = build_app(state);

        let response = send_request(
            app,
            Request::builder()
                .method("POST")
                .uri("/sockets/socket-1")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(vec![1_u8, 2, 3, 4]))
                .expect("build request"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        match cmd_rx.recv().await.expect("bridge command") {
            BridgeCommand::Send(data) => assert_eq!(data.as_ref(), &[1, 2, 3, 4]),
            BridgeCommand::Close => panic!("unexpected close command"),
        }
    }

    #[tokio::test]
    async fn get_sockets_and_trailing_slash_return_sorted_socket_health() {
        let state = test_state();
        let _first_rx = insert_test_socket(&state, "socket-b");
        let _second_rx = insert_test_socket(&state, "socket-a");
        let app = build_app(state.clone());

        for path in ["/sockets", "/sockets/"] {
            let response = send_request(
                app.clone(),
                Request::builder()
                    .method("GET")
                    .uri(path)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await;

            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("read response body");
            let json: serde_json::Value =
                serde_json::from_slice(&body).expect("parse list response");
            let sockets = json.as_array().expect("list response array");
            assert_eq!(sockets.len(), 2);
            assert_eq!(sockets[0]["socket_id"], "socket-a");
            assert_eq!(sockets[1]["socket_id"], "socket-b");
            assert_eq!(sockets[0]["protocol"], "tcp");
            assert_eq!(sockets[0]["bytes_rx"], 128);
            assert_eq!(sockets[0]["bytes_tx"], 256);
        }
    }

    #[tokio::test]
    async fn closed_callback_omits_socket_id() {
        let captured = Arc::new(Mutex::new(None::<serde_json::Value>));
        let captured_for_handler = Arc::clone(&captured);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let app = Router::new().route(
            "/cb",
            post(move |Json(payload): Json<serde_json::Value>| {
                let captured = Arc::clone(&captured_for_handler);
                async move {
                    *captured.lock().await = Some(payload);
                    StatusCode::OK
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind callback server");
        let addr = listener.local_addr().expect("callback server addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("callback server should run");
        });

        post_callback_closed(
            &HttpClient::new(),
            &reqwest::Url::parse(&format!("http://{addr}/cb")).expect("callback url"),
            "remote_close",
        )
        .await;

        for _ in 0..20 {
            if captured.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let payload = captured
            .lock()
            .await
            .clone()
            .expect("closed event should be captured");
        assert_eq!(payload["event"], "closed");
        assert_eq!(payload["reason"], "remote_close");
        assert!(payload.get("socket_id").is_none());

        let _ = shutdown_tx.send(());
        server.await.expect("callback server shutdown");
    }
}
