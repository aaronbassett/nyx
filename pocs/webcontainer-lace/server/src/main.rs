//! Nyx PoC server: WebContainer + Lace wallet-injection test.
//!
//! Responsibilities:
//! - Serve the built host page (../host/dist) with cross-origin-isolation
//!   headers (COOP/COEP) on EVERY response — required for SharedArrayBuffer,
//!   which WebContainers need.
//! - Expose a WebSocket endpoint (/ws). Every message from any browser
//!   context (host page, WebContainer process output relay, the DApp running
//!   inside the container) is pretty-printed to the terminal with a
//!   timestamp and origin label.
//! - Expose a CORS-open HTTP fallback (POST /report) for contexts where a
//!   cross-origin WebSocket is blocked.
//! - Open the default browser at the host page on startup (skip with
//!   NYX_POC_NO_OPEN=1).

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use axum::{
    extract::{
        connect_info::ConnectInfo,
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use tower_http::{
    cors::CorsLayer,
    services::ServeDir,
    trace::{DefaultMakeSpan, DefaultOnRequest, DefaultOnResponse, TraceLayer},
};
use tracing::{debug, info, warn, Level};
use tracing_subscriber::EnvFilter;

struct AppState {
    ws_seq: AtomicU64,
    static_dir: PathBuf,
}

/// COOP/COEP on EVERY response — required for SharedArrayBuffer/WebContainers —
/// with ONE deliberate exception: the /webcontainer/connect bridge page must
/// NOT be cross-origin isolated, or COOP severs the `window.opener` bridge the
/// preview tab uses to reach the container (stackblitz/webcontainer-core#1725).
async fn isolation_headers(req: Request, next: Next) -> Response {
    let is_connect_bridge = req.uri().path().starts_with("/webcontainer/connect");
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    if is_connect_bridge {
        headers.insert(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("unsafe-none"),
        );
        headers.insert(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("unsafe-none"),
        );
    } else {
        headers.insert(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        );
        headers.insert(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        );
    }
    res
}

fn ts() -> String {
    chrono::Local::now().format("%H:%M:%S%.3f").to_string()
}

#[tokio::main]
async fn main() {
    // VERY verbose logging by default; override with RUST_LOG.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("debug,hyper=info,hyper_util=info,h2=info,tokio=info,runtime=info,mio=info")
    });
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);

    let static_dir = std::env::var("STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../host/dist"));

    if !static_dir.join("index.html").exists() {
        warn!(
            dir = %static_dir.display(),
            "host/dist/index.html not found — run `sfw pnpm install && pnpm build` in ../host first"
        );
    } else {
        info!(dir = %static_dir.display(), "serving host page from");
    }

    let state = Arc::new(AppState {
        ws_seq: AtomicU64::new(0),
        static_dir: static_dir.clone(),
    });

    let trace = TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().level(Level::DEBUG).include_headers(false))
        .on_request(DefaultOnRequest::new().level(Level::DEBUG))
        .on_response(DefaultOnResponse::new().level(Level::DEBUG));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/report", post(report_handler))
        .route("/webcontainer/connect", get(connect_bridge_handler))
        .route("/webcontainer/connect/{*rest}", get(connect_bridge_handler))
        .fallback_service(ServeDir::new(&static_dir))
        // CORS innermost so preflights are answered; isolation headers outside
        // it so they land on EVERY response, including preflights and static
        // files (with the /webcontainer/connect exception); trace outermost so
        // everything is logged.
        .layer(CorsLayer::permissive())
        .layer(middleware::from_fn(isolation_headers))
        .layer(trace)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind port");

    let url = format!("http://localhost:{port}");
    println!();
    println!("==============================================================");
    println!("  Nyx PoC: WebContainer + Lace wallet-injection test");
    println!("  Host page : {url}");
    println!("  WebSocket : ws://localhost:{port}/ws");
    println!("  Fallback  : POST http://localhost:{port}/report");
    println!("  COOP/COEP : same-origin / require-corp (on every response)");
    println!("==============================================================");
    println!();

    if std::env::var("NYX_POC_NO_OPEN").is_err() {
        let open_url = url.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            info!(url = %open_url, "opening default browser");
            if let Err(e) = open::that(&open_url) {
                warn!(error = %e, "failed to open browser — open the URL manually");
            }
        });
    } else {
        info!("NYX_POC_NO_OPEN set — not opening a browser");
    }

    info!(%addr, "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server error");
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let id = state.ws_seq.fetch_add(1, Ordering::Relaxed);
    info!(conn = id, %peer, "WebSocket upgrade request");
    ws.on_upgrade(move |socket| handle_socket(socket, peer, id))
}

async fn handle_socket(mut socket: WebSocket, peer: SocketAddr, id: u64) {
    println!("[{}] [ws#{id}] CONNECTED (peer {peer})", ts());
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Text(txt)) => {
                debug!(conn = id, bytes = txt.len(), "WS text frame");
                print_client_message(&format!("ws#{id}"), txt.as_str());
            }
            Ok(Message::Binary(b)) => debug!(conn = id, bytes = b.len(), "WS binary frame (ignored)"),
            Ok(Message::Ping(_)) => debug!(conn = id, "WS ping"),
            Ok(Message::Pong(_)) => debug!(conn = id, "WS pong"),
            Ok(Message::Close(frame)) => {
                info!(conn = id, ?frame, "WS close frame");
                break;
            }
            Err(e) => {
                warn!(conn = id, error = %e, "WS receive error");
                break;
            }
        }
    }
    println!("[{}] [ws#{id}] DISCONNECTED (peer {peer})", ts());
}

/// Serves the setupConnect() bridge page for previews opened as top-level
/// tabs. The preview tab's bootstrap opens this URL as a popup automatically.
async fn connect_bridge_handler(State(state): State<Arc<AppState>>, req: Request) -> Response {
    info!(path = %req.uri().path(), "connect bridge page requested (preview tab is establishing its container link)");
    match tokio::fs::read_to_string(state.static_dir.join("connect.html")).await {
        Ok(html) => Html(html).into_response(),
        Err(e) => {
            warn!(error = %e, "connect.html missing — rebuild the host page");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "connect.html not built — run `pnpm build` in host/",
            )
                .into_response()
        }
    }
}

/// HTTP fallback for contexts where the cross-origin WebSocket is blocked.
async fn report_handler(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    debug!(%peer, "HTTP /report received");
    print_client_message("http-report", &body.to_string());
    Json(serde_json::json!({ "ok": true }))
}

/// Every client message is JSON:
/// `{ ts, origin, source, kind, data }` where kind is one of
/// `log` | `process-output` | `wallet-check`.
fn print_client_message(via: &str, raw: &str) {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        println!("[{}] [{via}] (non-JSON) {raw}", ts());
        return;
    };
    let origin = v["origin"].as_str().unwrap_or("<unknown-origin>");
    let source = v["source"].as_str().unwrap_or("<unknown-source>");
    let kind = v["kind"].as_str().unwrap_or("<unknown-kind>");
    let client_ts = v["ts"].as_str().unwrap_or("");
    let data = &v["data"];

    match kind {
        "wallet-check" => print_wallet_findings(via, origin, source, client_ts, data),
        "process-output" => {
            let stream = data["stream"].as_str().unwrap_or("?");
            let chunk = data["chunk"].as_str().unwrap_or("");
            for line in chunk.split('\n') {
                let line = line.trim_end_matches('\r');
                if line.trim().is_empty() {
                    continue;
                }
                println!("[{}] [{via}] [wc:{stream}] {line}", ts());
            }
        }
        "log" => {
            let text = match data["text"].as_str() {
                Some(t) => t.to_string(),
                None => data.to_string(),
            };
            let level = data["level"].as_str().unwrap_or("info");
            println!("[{}] [{via}] [{source} @ {origin}] {level}: {text}", ts());
        }
        other => {
            println!(
                "[{}] [{via}] [{source} @ {origin}] {other}: {}",
                ts(),
                serde_json::to_string_pretty(data).unwrap_or_default()
            );
        }
    }
}

fn print_wallet_findings(via: &str, origin: &str, source: &str, client_ts: &str, data: &Value) {
    let midnight = data["midnightPresent"].as_bool().unwrap_or(false);
    let cardano = data["cardanoPresent"].as_bool().unwrap_or(false);
    let transport = data["transport"].as_str().unwrap_or(via);

    let fmt_keys = |v: &Value| -> Vec<String> {
        match v.as_object() {
            None => vec![],
            Some(map) => map
                .iter()
                .map(|(k, sub)| {
                    let subkeys = sub
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!("{k}  ->  [{subkeys}]")
                })
                .collect(),
        }
    };

    let midnight_keys = fmt_keys(&data["midnightKeys"]);
    let cardano_keys = fmt_keys(&data["cardanoKeys"]);
    let others: Vec<&str> = data["otherWalletGlobals"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    println!();
    println!("################################################################");
    println!("##            WALLET INJECTION FINDINGS                       ##");
    println!("################################################################");
    println!("  origin            : {origin}");
    println!("  reported by       : {source} (via {transport}, client ts {client_ts})");
    println!(
        "  window.midnight   : {}",
        if midnight { "PRESENT  <<<<<<" } else { "absent" }
    );
    if midnight_keys.is_empty() {
        println!("  midnight keys     : (none)");
    } else {
        for (i, k) in midnight_keys.iter().enumerate() {
            if i == 0 {
                println!("  midnight keys     : {k}");
            } else {
                println!("                      {k}");
            }
        }
    }
    println!(
        "  window.cardano    : {}",
        if cardano { "PRESENT  <<<<<<" } else { "absent" }
    );
    if cardano_keys.is_empty() {
        println!("  cardano keys      : (none)");
    } else {
        for (i, k) in cardano_keys.iter().enumerate() {
            if i == 0 {
                println!("  cardano keys      : {k}");
            } else {
                println!("                      {k}");
            }
        }
    }
    if others.is_empty() {
        println!("  other wallet-ish  : (none)");
    } else {
        println!("  other wallet-ish  : {}", others.join(", "));
    }
    println!("################################################################");
    println!();
}
