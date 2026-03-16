use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, ServerName};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    time::Duration,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024; // 16 MB

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct BridgeConfig {
    durable_socket_url: String,
}

impl BridgeConfig {
    fn from_env() -> Self {
        let url = std::env::var("DURABLE_SOCKET_URL")
            .or_else(|_| {
                std::env::args()
                    .find(|a| a.starts_with("--durable-socket-url="))
                    .map(|a| a["--durable-socket-url=".len()..].to_string())
                    .ok_or(std::env::VarError::NotPresent)
            })
            .expect("DURABLE_SOCKET_URL env var or --durable-socket-url=... CLI arg required");
        Self {
            durable_socket_url: url,
        }
    }
}

// ---------------------------------------------------------------------------
// Control protocol messages
// ---------------------------------------------------------------------------

/// Bridge → DurableSocket
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControlMsg {
    Register { bridge_id: String },
    Pong,
    SessionClosed { socket_key: String, reason: String },
}

/// DurableSocket → Bridge
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControlCmd {
    OpenSession {
        socket_key: String,
        target_url: String,
        data_ws_url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    CloseSession {
        socket_key: String,
    },
    Ping,
}

enum BridgeCommand {
    Send(Bytes),
    Close,
}

// ---------------------------------------------------------------------------
// Type aliases for the WS split halves
// ---------------------------------------------------------------------------

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    Message,
>;

type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
>;

// ---------------------------------------------------------------------------
// TLS helpers (preserved from original)
// ---------------------------------------------------------------------------

fn build_root_store_from_certs(
    certs: Vec<CertificateDer<'static>>,
    load_error_count: usize,
) -> anyhow::Result<rustls::RootCertStore> {
    let mut root_store = rustls::RootCertStore::empty();
    let mut rejected_certs = 0usize;

    for cert in certs {
        if let Err(err) = root_store.add(cert) {
            rejected_certs += 1;
            warn!(error = %err, "failed to add native TLS root");
        }
    }

    if root_store.is_empty() {
        anyhow::bail!("no usable native TLS roots found");
    }

    info!(
        roots = root_store.len(),
        load_errors = load_error_count,
        rejected_certs,
        "loaded native TLS roots"
    );

    Ok(root_store)
}

fn load_native_root_store() -> anyhow::Result<rustls::RootCertStore> {
    let cert_result = rustls_native_certs::load_native_certs();
    for err in &cert_result.errors {
        warn!(error = %err, "failed to load native TLS root");
    }
    build_root_store_from_certs(cert_result.certs, cert_result.errors.len())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "dlkn_socket_bridge=info".to_string()),
        )
        .init();

    let config = BridgeConfig::from_env();
    run_bridge(config).await;
}

async fn run_bridge(config: BridgeConfig) {
    let bridge_id = Uuid::new_v4().to_string();
    info!(%bridge_id, url = %config.durable_socket_url, "bridge starting");
    loop {
        if let Err(e) = run_control_loop(&config, &bridge_id).await {
            warn!(error = %e, "control connection lost, reconnecting in 5s");
        } else {
            warn!("control connection closed, reconnecting in 5s");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

// ---------------------------------------------------------------------------
// Control WS loop
// ---------------------------------------------------------------------------

async fn run_control_loop(
    config: &BridgeConfig,
    bridge_id: &str,
) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(&config.durable_socket_url).await?;
    info!("control WS connected");
    let (mut sink, mut stream) = ws.split();

    // Register with the durable socket
    let register_msg = serde_json::to_string(&ControlMsg::Register {
        bridge_id: bridge_id.to_string(),
    })?;
    sink.send(Message::Text(register_msg)).await?;

    let sessions: Arc<DashMap<String, mpsc::UnboundedSender<BridgeCommand>>> = Default::default();
    let control_sink = Arc::new(tokio::sync::Mutex::new(sink));

    loop {
        tokio::select! {
            biased;
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ControlCmd>(&text) {
                            Ok(ControlCmd::OpenSession { socket_key, target_url, data_ws_url, headers }) => {
                                info!(%socket_key, %target_url, "open_session received");
                                let sessions_clone = sessions.clone();
                                let control_sink_clone = control_sink.clone();
                                tokio::spawn(async move {
                                    let reason = run_data_session(
                                        &socket_key,
                                        &target_url,
                                        &data_ws_url,
                                        headers,
                                        sessions_clone,
                                    )
                                    .await;
                                    // Notify control channel that session closed
                                    let msg = serde_json::to_string(&ControlMsg::SessionClosed {
                                        socket_key: socket_key.clone(),
                                        reason: reason.clone(),
                                    });
                                    if let Ok(msg) = msg {
                                        let mut sink = control_sink_clone.lock().await;
                                        let _ = sink.send(Message::Text(msg)).await;
                                    }
                                });
                            }
                            Ok(ControlCmd::CloseSession { socket_key }) => {
                                info!(%socket_key, "close_session received");
                                if let Some((_, tx)) = sessions.remove(&socket_key) {
                                    let _ = tx.send(BridgeCommand::Close);
                                }
                            }
                            Ok(ControlCmd::Ping) => {
                                let pong = serde_json::to_string(&ControlMsg::Pong)?;
                                let mut s = control_sink.lock().await;
                                s.send(Message::Text(pong)).await?;
                            }
                            Err(e) => {
                                warn!(error = %e, msg = %text, "unknown control message");
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let mut s = control_sink.lock().await;
                        s.send(Message::Pong(p)).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        info!("control WS closed by server");
                        break;
                    }
                    Some(Err(e)) => return Err(e.into()),
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Data session
// ---------------------------------------------------------------------------

async fn run_data_session(
    socket_key: &str,
    target_url: &str,
    data_ws_url: &str,
    headers: HashMap<String, String>,
    sessions: Arc<DashMap<String, mpsc::UnboundedSender<BridgeCommand>>>,
) -> String {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<BridgeCommand>();
    sessions.insert(socket_key.to_string(), cmd_tx);

    // Connect data WS to Agent DO with X-Bridge: 1 header
    let data_ws_result = {
        let mut request = match data_ws_url.into_client_request() {
            Ok(r) => r,
            Err(e) => {
                error!(%socket_key, error = %e, "failed to build data WS request");
                sessions.remove(socket_key);
                return format!("error: {e}");
            }
        };
        request.headers_mut().insert(
            "x-bridge",
            tokio_tungstenite::tungstenite::http::HeaderValue::from_static("1"),
        );
        tokio_tungstenite::connect_async(request).await
    };

    let (data_ws, _) = match data_ws_result {
        Ok(r) => r,
        Err(e) => {
            error!(%socket_key, error = %e, "data WS connect failed");
            sessions.remove(socket_key);
            return format!("error: {e}");
        }
    };
    info!(%socket_key, "data WS connected to agent DO");

    let (mut data_sink, mut data_stream) = data_ws.split();

    let close_reason = run_engine_with_ws_relay(
        target_url,
        socket_key,
        &headers,
        &mut data_sink,
        &mut data_stream,
        cmd_rx,
    )
    .await
    .unwrap_or_else(|e| {
        error!(%socket_key, error = %e, "engine error");
        "error".to_string()
    });

    sessions.remove(socket_key);
    info!(%socket_key, reason = %close_reason, "data session ended");
    let _ = data_sink.send(Message::Close(None)).await;
    close_reason
}

// ---------------------------------------------------------------------------
// Engine dispatcher
// ---------------------------------------------------------------------------

async fn run_engine_with_ws_relay(
    target_url: &str,
    socket_key: &str,
    headers: &HashMap<String, String>,
    data_sink: &mut WsSink,
    data_stream: &mut WsStream,
    cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
) -> anyhow::Result<String> {
    let parsed =
        url::Url::parse(target_url).map_err(|e| anyhow::anyhow!("invalid target_url: {e}"))?;

    match parsed.scheme() {
        "tcp" => run_tcp_engine_ws(parsed, socket_key, data_sink, data_stream, cmd_rx, false).await,
        "tls" | "tcps" => {
            run_tcp_engine_ws(parsed, socket_key, data_sink, data_stream, cmd_rx, true).await
        }
        "ws" | "wss" => run_ws_engine_ws(parsed, socket_key, headers, data_sink, data_stream, cmd_rx).await,
        "loco-frame" => {
            run_loco_frame_engine_ws(parsed, socket_key, data_sink, data_stream, cmd_rx).await
        }
        "mtproto-frame" => {
            run_mtproto_frame_engine_ws(parsed, socket_key, data_sink, data_stream, cmd_rx).await
        }
        other => anyhow::bail!("unsupported scheme: {other}"),
    }
}

// ---------------------------------------------------------------------------
// TCP / TLS engine
// ---------------------------------------------------------------------------

async fn run_tcp_engine_ws(
    target_url: url::Url,
    socket_key: &str,
    data_sink: &mut WsSink,
    data_stream: &mut WsStream,
    cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
    use_tls: bool,
) -> anyhow::Result<String> {
    let host = target_url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("target missing host"))?
        .to_owned();
    let port = target_url
        .port()
        .ok_or_else(|| anyhow::anyhow!("target missing port"))?;

    let tcp = TcpStream::connect((host.as_str(), port)).await?;

    if use_tls {
        let root_store = load_native_root_store()?;
        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));
        let server_name = ServerName::try_from(host.as_str())
            .map_err(|e| anyhow::anyhow!("invalid server name: {e}"))?
            .to_owned();
        let tls_stream = connector.connect(server_name, tcp).await?;
        info!(%socket_key, host = %host, port, "tls connected");
        run_stream_engine_ws(tls_stream, socket_key, data_sink, data_stream, cmd_rx).await
    } else {
        info!(%socket_key, host = %host, port, "tcp connected");
        run_stream_engine_ws(tcp, socket_key, data_sink, data_stream, cmd_rx).await
    }
}

async fn run_stream_engine_ws<S>(
    stream: S,
    socket_key: &str,
    data_sink: &mut WsSink,
    data_stream: &mut WsStream,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
) -> anyhow::Result<String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let (mut tcp_rx, mut tcp_tx) = tokio::io::split(stream);
    let mut read_buf = vec![0u8; 8192];

    let close_reason: String = loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(%socket_key, bytes = data.len(), "stream write");
                        tcp_tx.write_all(&data).await?;
                    }
                    Some(BridgeCommand::Close) | None => {
                        break "command".to_string();
                    }
                }
            }

            result = tcp_rx.read(&mut read_buf) => {
                let n = result?;
                if n == 0 {
                    break "remote_close".to_string();
                }
                debug!(%socket_key, bytes = n, "stream read");
                data_sink.send(Message::Binary(read_buf[..n].to_vec())).await?;
            }

            msg = data_stream.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        debug!(%socket_key, bytes = data.len(), "data ws binary → target");
                        tcp_tx.write_all(&data).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break "agent_close".to_string();
                    }
                    Some(Ok(Message::Ping(p))) => {
                        data_sink.send(Message::Pong(p)).await?;
                    }
                    Some(Err(e)) => {
                        return Err(e.into());
                    }
                    _ => {}
                }
            }
        }
    };

    Ok(close_reason)
}

// ---------------------------------------------------------------------------
// WebSocket engine
// ---------------------------------------------------------------------------

async fn run_ws_engine_ws(
    target_url: url::Url,
    socket_key: &str,
    headers: &HashMap<String, String>,
    data_sink: &mut WsSink,
    data_stream: &mut WsStream,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
) -> anyhow::Result<String> {
    let mut request = target_url.as_str().into_client_request()
        .map_err(|e| anyhow::anyhow!("failed to build WS request: {e}"))?;

    for (key, value) in headers {
        let header_name = tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(key.as_bytes())
            .map_err(|e| anyhow::anyhow!("invalid header name '{key}': {e}"))?;
        let header_value = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(value)
            .map_err(|e| anyhow::anyhow!("invalid header value for '{key}': {e}"))?;
        request.headers_mut().insert(header_name, header_value);
    }

    let (ws_stream, _resp) = tokio_tungstenite::connect_async(request).await?;
    info!(%socket_key, target = %target_url, "websocket connected to target");

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    let close_reason: String = loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(%socket_key, bytes = data.len(), "ws engine write");
                        ws_sink.send(Message::Binary(data.to_vec())).await?;
                    }
                    Some(BridgeCommand::Close) => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        break "command".to_string();
                    }
                    None => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        break "command_channel_closed".to_string();
                    }
                }
            }

            // Read from target WS → forward to data WS (agent)
            item = ws_source.next() => {
                match item {
                    Some(Ok(Message::Binary(data))) => {
                        debug!(%socket_key, bytes = data.len(), "ws target binary read");
                        data_sink.send(Message::Binary(data)).await?;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let data = text.into_bytes();
                        debug!(%socket_key, bytes = data.len(), "ws target text read");
                        data_sink.send(Message::Binary(data)).await?;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_sink.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(Message::Close(_))) => {
                        break "remote_close".to_string();
                    }
                    Some(Err(err)) => return Err(err.into()),
                    None => {
                        break "remote_close".to_string();
                    }
                }
            }

            // Read from data WS (agent) → forward to target WS
            msg = data_stream.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        debug!(%socket_key, bytes = data.len(), "data ws binary → target ws");
                        ws_sink.send(Message::Binary(data)).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        break "agent_close".to_string();
                    }
                    Some(Ok(Message::Ping(p))) => {
                        data_sink.send(Message::Pong(p)).await?;
                    }
                    Some(Err(e)) => return Err(e.into()),
                    _ => {}
                }
            }
        }
    };

    Ok(close_reason)
}

// ---------------------------------------------------------------------------
// LOCO frame engine
// ---------------------------------------------------------------------------

async fn run_loco_frame_engine_ws(
    target_url: url::Url,
    socket_key: &str,
    data_sink: &mut WsSink,
    data_stream: &mut WsStream,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
) -> anyhow::Result<String> {
    let host = target_url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("target missing host"))?
        .to_owned();
    let port = target_url
        .port()
        .ok_or_else(|| anyhow::anyhow!("target missing port"))?;

    let tcp = TcpStream::connect((host.as_str(), port)).await?;
    info!(%socket_key, host = %host, port, "loco-frame connected");

    let (mut rx, mut tx) = tokio::io::split(tcp);

    let close_reason: String = loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(%socket_key, bytes = data.len(), "loco-frame write");
                        tx.write_all(&data).await?;
                    }
                    Some(BridgeCommand::Close) | None => {
                        break "command".to_string();
                    }
                }
            }

            // Read LOCO frames from target
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
                        debug!(%socket_key, bytes = frame.len(), "loco-frame read");
                        data_sink.send(Message::Binary(frame)).await?;
                    }
                    Err(err) => {
                        if err.downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof)
                        {
                            break "remote_close".to_string();
                        }
                        return Err(err);
                    }
                }
            }

            // Read from data WS (agent) → forward to target
            msg = data_stream.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        debug!(%socket_key, bytes = data.len(), "data ws binary → loco target");
                        tx.write_all(&data).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break "agent_close".to_string();
                    }
                    Some(Ok(Message::Ping(p))) => {
                        data_sink.send(Message::Pong(p)).await?;
                    }
                    Some(Err(e)) => return Err(e.into()),
                    _ => {}
                }
            }
        }
    };

    Ok(close_reason)
}

// ---------------------------------------------------------------------------
// MTProto frame engine
// ---------------------------------------------------------------------------

async fn run_mtproto_frame_engine_ws(
    target_url: url::Url,
    socket_key: &str,
    data_sink: &mut WsSink,
    data_stream: &mut WsStream,
    mut cmd_rx: mpsc::UnboundedReceiver<BridgeCommand>,
) -> anyhow::Result<String> {
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
    info!(%socket_key, host = %host, port, "mtproto-frame connected (intermediate transport)");

    let close_reason: String = loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(BridgeCommand::Send(data)) => {
                        debug!(%socket_key, bytes = data.len(), "mtproto-frame write");
                        tx.write_all(&data).await?;
                    }
                    Some(BridgeCommand::Close) | None => {
                        break "command".to_string();
                    }
                }
            }

            // Read MTProto frames from target
            result = async {
                let mut hdr = [0u8; 4];
                rx.read_exact(&mut hdr).await?;
                let length_field = u32::from_le_bytes(hdr);

                // High bit set = quick ack (4 bytes total, no payload follows)
                if length_field & 0x80000000 != 0 {
                    debug!(%socket_key, ack = true, raw = length_field, "mtproto quick ack read");
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
                        debug!(%socket_key, bytes = frame.len(), "mtproto-frame read");
                        data_sink.send(Message::Binary(frame)).await?;
                    }
                    Err(err) => {
                        if err.downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof)
                        {
                            break "remote_close".to_string();
                        }
                        return Err(err);
                    }
                }
            }

            // Read from data WS (agent) → forward to target
            msg = data_stream.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        debug!(%socket_key, bytes = data.len(), "data ws binary → mtproto target");
                        tx.write_all(&data).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break "agent_close".to_string();
                    }
                    Some(Ok(Message::Ping(p))) => {
                        data_sink.send(Message::Pong(p)).await?;
                    }
                    Some(Err(e)) => return Err(e.into()),
                    _ => {}
                }
            }
        }
    };

    Ok(close_reason)
}
