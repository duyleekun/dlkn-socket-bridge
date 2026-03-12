use std::{
    net::SocketAddr,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use axum::{
    body::Bytes as AxumBytes,
    extract::{Path, State},
    http::StatusCode,
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
use tracing::{error, info, warn};
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
struct ClosedEvent<'a> {
    event: &'static str,
    socket_id: &'a str,
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
    if flush
        .interval_ms
        .map_or(false, |ms| last_flush.elapsed() >= Duration::from_millis(ms))
    {
        return true;
    }
    false
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

    let app = Router::new()
        .route("/sockets", post(create_socket))
        .route("/sockets/:id", get(get_socket_status).delete(delete_socket))
        .route("/sockets/:id/send", post(send_socket))
        .with_state(state);

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
        send_url: format!("/sockets/{socket_id}/send"),
        delete_url: format!("/sockets/{socket_id}"),
    }))
}

async fn send_socket(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: AxumBytes,
) -> Result<StatusCode, ApiError> {
    let Some(entry) = state.registry.get(&id) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown socket_id"));
    };

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

    Ok(Json(SocketStatusResponse {
        protocol: entry.protocol,
        uptime_secs: entry.created_at.elapsed().as_secs(),
        bytes_rx: entry.bytes_rx.load(Ordering::Relaxed),
        bytes_tx: entry.bytes_tx.load(Ordering::Relaxed),
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
    if let Err(err) = http
        .post(callback_url.clone())
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(payload)
        .send()
        .await
    {
        warn!(%callback_url, error = %err, "failed to post binary callback");
    }
}

async fn post_callback_closed(
    http: &HttpClient,
    callback_url: &reqwest::Url,
    socket_id: &str,
    reason: &str,
) {
    if let Err(err) = http
        .post(callback_url.clone())
        .json(&ClosedEvent {
            event: "closed",
            socket_id,
            reason,
        })
        .send()
        .await
    {
        warn!(%callback_url, %socket_id, error = %err, "failed to post closed callback");
    }
}

async fn finalize_session(
    state: &AppState,
    socket_id: &str,
    callback_url: &reqwest::Url,
    reason: &str,
) {
    state.registry.remove(socket_id);
    post_callback_closed(&state.http, callback_url, socket_id, reason).await;
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
        run_stream_engine(tls_stream, state, callback_url, cmd_rx, bytes_rx, bytes_tx, socket_id, flush).await
    } else {
        info!(socket_id = %socket_id, host = %host, port, "tcp connected");
        run_stream_engine(tcp, state, callback_url, cmd_rx, bytes_rx, bytes_tx, socket_id, flush).await
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
                        bytes_rx.fetch_add(data.len() as u64, Ordering::Relaxed);
                        post_callback_binary(&state.http, &callback_url, Bytes::from(data)).await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let data = text.to_string().into_bytes();
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
