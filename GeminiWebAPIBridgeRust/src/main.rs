use axum::{
    Router,
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::Utc;
use md5::{Digest, Md5};
use rand::Rng;
use regex::Regex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, COOKIE, ORIGIN, REFERER,
    USER_AGENT,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    fs::{create_dir_all, OpenOptions},
    io::Write,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

const GEMINI_ORIGIN: &str = "https://gemini.google.com";
const USER_AGENT_VAL: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const SESSION_TTL_SECS: u64 = 10 * 60; // 10 minutes

// ── Structured JSONL logger ──────────────────────────────────────────
//
// Appends one JSON object per line to `logs/bridge-YYYY-MM-DD.log`, using
// the same shape as the Node version (`{"ts":...,"stage":...,...}`).
// Failures are swallowed so logging never breaks the request path.
fn log_event(stage: &str, extra: Value) {
    let now = Utc::now();
    let mut obj = serde_json::Map::new();
    obj.insert("ts".to_string(), Value::String(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
    obj.insert("stage".to_string(), Value::String(stage.to_string()));
    if let Value::Object(map) = extra {
        for (k, v) in map {
            obj.insert(k, v);
        }
    }
    let line = match serde_json::to_string(&Value::Object(obj)) {
        Ok(s) => s,
        Err(_) => return,
    };

    // Also emit to tracing so terminal output stays intact.
    info!("{}", line);

    let date = now.format("%Y-%m-%d").to_string();
    tokio::task::spawn_blocking(move || {
        let dir = std::path::PathBuf::from("logs");
        if create_dir_all(&dir).is_ok() {
            let path = dir.join(format!("bridge-{}.log", date));
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(f, "{}", line);
            }
        }
    });
}

// ── Models & State ───────────────────────────────────────────────────

const CONVERSATION_TTL_SECS: u64 = 2 * 60 * 60; // 2 hours
const MAX_CONVERSATIONS: usize = 500;

#[derive(Debug, Clone, Default)]
struct SessionParams {
    at_token: String, // SNlM0e
    bl: String,       // Build label
    fsid: String,     // f.sid
    cfb2h: Option<String>,
    last_refresh_epoch: u64,
}

#[derive(Debug, Clone)]
struct ConversationContext {
    cid: String,
    rid: String,
    choice_id: String,
    continuation_token: Option<String>,
    last_accessed: u64,
}

fn prune_stale_conversations(map: &mut HashMap<String, ConversationContext>, now: u64) {
    map.retain(|_, ctx| now.saturating_sub(ctx.last_accessed) < CONVERSATION_TTL_SECS);

    if map.len() > MAX_CONVERSATIONS {
        let mut entries: Vec<(String, u64)> = map
            .iter()
            .map(|(k, v)| (k.clone(), v.last_accessed))
            .collect();
        entries.sort_by_key(|(_, t)| *t);
        let remove_count = map.len() - MAX_CONVERSATIONS;
        for (k, _) in entries.into_iter().take(remove_count) {
            map.remove(&k);
        }
    }
}

struct AppState {
    gemini_cookies: RwLock<String>,
    gemini_cookies_hash: RwLock<String>,
    last_cookie_sync_epoch: RwLock<Option<u64>>,
    session_params: RwLock<SessionParams>,
    conversations: RwLock<HashMap<String, ConversationContext>>,
    http_client: reqwest::Client,
    start_time: Instant,
}

// ── DTOs ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CookieSyncPayload {
    cookies: Value, // string or Vec<{ name: String, value: String }>
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletionMessage {
    #[allow(dead_code)]
    role: Option<String>,
    // Pi sends `content` as either a plain string OR a structured array
    // like `[{type:"text",text:"..."}, {type:"toolCall",...}]`. We don't
    // actually parse messages here (the full formatted prompt arrives in
    // `prompt`), but we still need to accept any shape without failing
    // deserialization.
    content: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletionRequest {
    request_id: Option<String>,
    prompt: Option<String>,
    messages: Option<Vec<CompletionMessage>>,
    conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionResponse {
    request_id: String,
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gemini_error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug)]
struct GeminiParsedResult {
    text: String,
    truncated: bool,
    gemini_error: Option<Value>,
    cid: Option<String>,
    rid: Option<String>,
    choice_id: Option<String>,
    continuation_token: Option<String>,
}

// ── Cookie & Hash Helpers ────────────────────────────────────────────

fn hash_cookies(cookie_str: &str) -> String {
    if cookie_str.trim().is_empty() {
        return String::new();
    }
    let mut parts: Vec<&str> = cookie_str
        .split(';')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    parts.sort_unstable();
    let sorted = parts.join("; ");

    let mut hasher = Md5::new();
    hasher.update(sorted.as_bytes());
    hex::encode(hasher.finalize())
}

fn extract_cookie_string(val: Value) -> Result<String, String> {
    match val {
        Value::String(s) => Ok(s),
        Value::Array(arr) => {
            let mut pairs = Vec::new();
            for item in arr {
                if let Some(obj) = item.as_object() {
                    let name = obj.get("name").and_then(|v| v.as_str());
                    let value = obj.get("value").and_then(|v| v.as_str());
                    if let (Some(n), Some(v)) = (name, value) {
                        pairs.push(format!("{}={}", n, v));
                    }
                }
            }
            Ok(pairs.join("; "))
        }
        _ => Err("Invalid cookies format, expected string or array of objects".to_string()),
    }
}

fn now_epoch_secs() -> u64 {
    Utc::now().timestamp().max(0) as u64
}

// ── Gemini Session Extraction ────────────────────────────────────────

async fn refresh_session(state: &AppState) -> Result<SessionParams, String> {
    let cookies = { state.gemini_cookies.read().await.clone() };
    if cookies.is_empty() {
        return Err("No cookies available. Please sync cookies from the extension.".to_string());
    }

    info!("🔄 [session_refresh] Starting refresh from Gemini page...");
    log_event("session_refresh", json!({ "status": "starting" }));

    let resp = state
        .http_client
        .get(format!("{}/app", GEMINI_ORIGIN))
        .header(USER_AGENT, USER_AGENT_VAL)
        .header(COOKIE, &cookies)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Failed to request Gemini page: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Failed to fetch Gemini page: {}", status));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Gemini page HTML: {}", e))?;

    // 1. SNlM0e (at token)
    let re_at1 = Regex::new(r#""SNlM0e":"([^"]+)""#).unwrap();
    let re_at2 = Regex::new(r#"WIZ_global_data\s*=\s*\{[\s\S]*?"SNlM0e"\s*:\s*"([^"]+)""#).unwrap();

    let at_token = re_at1
        .captures(&html)
        .or_else(|| re_at2.captures(&html))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| "Cannot extract SNlM0e token from Gemini page".to_string())?;

    // 2. Build Label (bl)
    let re_bl1 = Regex::new(r#""cfb2h":"(boq_assistant-bard-web-server_[^"]+)""#).unwrap();
    let re_bl2 = Regex::new(r#"bl=(boq_assistant-bard-web-server_[^&"]+)"#).unwrap();
    let re_bl3 = Regex::new(r#""boq_assistant-bard-web-server_([^"]+)""#).unwrap();
    let re_bl_fallback = Regex::new(r#"boq_assistant-bard-web[^"'\s&]+"#).unwrap();

    let bl = re_bl1
        .captures(&html)
        .or_else(|| re_bl2.captures(&html))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .or_else(|| {
            re_bl3.captures(&html).and_then(|c| c.get(1)).map(|m| {
                format!("boq_assistant-bard-web-server_{}", m.as_str())
            })
        })
        .or_else(|| {
            re_bl_fallback
                .captures(&html)
                .and_then(|c| c.get(0))
                .map(|m| m.as_str().to_string())
        })
        .unwrap_or_else(|| "boq_assistant-bard-web-server_20260907.07_p0".to_string());

    // 3. f.sid
    let re_fsid1 = Regex::new(r#""FdrFJe":"(\d+)""#).unwrap();
    let re_fsid2 = Regex::new(r#"f\.sid['"]\s*[:=]\s*['"](\d+)['"]"#).unwrap();
    let fsid = re_fsid1
        .captures(&html)
        .or_else(|| re_fsid2.captures(&html))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    // 4. cfb2h
    let re_cfb2h = Regex::new(r#""cfb2h":"([^"]{50,})""#).unwrap();
    let cfb2h = re_cfb2h
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    let new_params = SessionParams {
        at_token,
        bl,
        fsid,
        cfb2h,
        last_refresh_epoch: now_epoch_secs(),
    };

    info!(
        "✅ [session_refresh] Done. hasAtToken={}, bl={}, hasFsid={}, hasCfb2h={}",
        !new_params.at_token.is_empty(),
        new_params.bl,
        !new_params.fsid.is_empty(),
        new_params.cfb2h.is_some()
    );
    log_event("session_refresh", json!({
        "status": "done",
        "hasAtToken": !new_params.at_token.is_empty(),
        "hasBl": !new_params.bl.is_empty(),
        "hasFsid": !new_params.fsid.is_empty(),
        "hasCfb2h": new_params.cfb2h.is_some(),
        "bl": new_params.bl.clone(),
    }));

    let mut lock = state.session_params.write().await;
    *lock = new_params.clone();
    Ok(new_params)
}

// ── Build f.req Payload ──────────────────────────────────────────────

fn build_freq(
    prompt: &str,
    conv_context: Option<&ConversationContext>,
    session: &SessionParams,
) -> String {
    let mut inner = vec![Value::Null; 99];

    // [0] prompt: [text, 0, null, null, null, null, 0]
    inner[0] = json!([prompt, 0, null, null, null, null, 0]);

    // [1] language
    inner[1] = json!(["en"]);

    // [2] conversation context
    if let Some(ctx) = conv_context {
        inner[2] = json!([
            ctx.cid,
            ctx.rid,
            ctx.choice_id,
            null,
            null,
            null,
            null,
            null,
            null,
            ctx.continuation_token.as_deref().unwrap_or("")
        ]);
    } else {
        inner[2] = json!(["", "", "", null, null, null, null, null, null, ""]);
    }

    // [3] cfb2h session token
    inner[3] = session
        .cfb2h
        .as_ref()
        .map(|t| Value::String(t.clone()))
        .unwrap_or(Value::Null);

    // [4] hash
    inner[4] = Value::Null;

    // Standard flags matching real web requests
    inner[6] = json!([1]);
    inner[7] = json!(1);
    inner[10] = json!(1);
    inner[11] = json!(0);
    inner[17] = json!([[1]]);
    inner[18] = json!(0);
    inner[27] = json!(1);
    inner[30] = json!([4]);
    inner[41] = json!([1]);
    inner[53] = json!(0);
    inner[67] = json!(0);
    inner[68] = json!(2);
    inner[79] = json!(6);
    inner[80] = json!(1);
    inner[91] = json!(0);
    inner[96] = json!(0);
    inner[98] = json!(1);

    let inner_json_str = serde_json::to_string(&inner).unwrap_or_default();
    let outer = json!([null, inner_json_str]);
    let outer_json_str = serde_json::to_string(&outer).unwrap_or_default();

    format!(
        "f.req={}&at={}",
        urlencoding::encode(&outer_json_str),
        urlencoding::encode(&session.at_token)
    )
}

// ── StreamGenerate Response Parser ───────────────────────────────────

fn detect_bard_error(data: &Value) -> Option<String> {
    let arr = data.as_array()?;
    for item in arr {
        let err_block = item.get(5)?;
        let details = err_block.get(2)?.as_array()?;
        for d in details {
            if let Some(name) = d.get(0).and_then(|v| v.as_str()) {
                if name.contains("BardErrorInfo") {
                    let code = if let Some(code_arr) = d.get(1).and_then(|v| v.as_array()) {
                        code_arr
                            .first()
                            .map(|v| v.to_string())
                            .unwrap_or_default()
                    } else {
                        d.get(1).map(|v| v.to_string()).unwrap_or_default()
                    };
                    return Some(format!("BardErrorInfo code {}", code));
                }
            }
        }
    }
    None
}

fn extract_metadata(data: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let mut cid = None;
    let mut rid = None;
    let mut continuation_token = None;

    if let Some(arr) = data.as_array() {
        for item in arr {
            if let Some(payload_str) = item.get(2).and_then(|v| v.as_str()) {
                if payload_str.len() > 5 {
                    if let Ok(inner) = serde_json::from_str::<Value>(payload_str) {
                        if let Some(ids) = inner.get(1).and_then(|v| v.as_array()) {
                            if let Some(c) = ids.get(0).and_then(|v| v.as_str()) {
                                if c.starts_with("c_") {
                                    cid = Some(c.to_string());
                                }
                            }
                            if let Some(r) = ids.get(1).and_then(|v| v.as_str()) {
                                if r.starts_with("r_") {
                                    rid = Some(r.to_string());
                                }
                            }
                        }

                        if let Some(obj) = inner.get(2).and_then(|v| v.as_object()) {
                            if let Some(tok) = obj.get("26").and_then(|v| v.as_str()) {
                                continuation_token = Some(tok.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    (cid, rid, continuation_token)
}

fn extract_text_from_inner(inner: &Value) -> Option<String> {
    let paths: &[&[usize]] = &[
        &[4, 0, 1, 0],
        &[4, 0, 0, 0],
        &[0, 0],
        &[0, 0, 0],
        &[3, 0, 0],
        &[17, 0, 1, 0],
        &[4, 0, 1, 0, 0],
        &[0, 4, 0, 1, 0],
    ];

    for path in paths {
        let mut curr = inner;
        let mut ok = true;
        for &idx in *path {
            if let Some(next) = curr.get(idx) {
                curr = next;
            } else {
                ok = false;
                break;
            }
        }
        if ok {
            if let Some(s) = curr.as_str() {
                if s.len() > 5 {
                    return Some(s.to_string());
                }
            }
        }
    }

    None
}

struct InnerTextExtract {
    text: String,
    status: Option<i64>,
    cid: Option<String>,
    rid: Option<String>,
    choice_id: Option<String>,
}

fn extract_response_text_with_status(data: &Value) -> Option<InnerTextExtract> {
    let arr = data.as_array()?;
    if arr.first().and_then(|v| v.as_array()).is_none() {
        return None;
    }

    for item in arr {
        if let Some(payload_str) = item.get(2).and_then(|v| v.as_str()) {
            if payload_str.len() > 20 {
                if let Ok(inner) = serde_json::from_str::<Value>(payload_str) {
                    if let Some(text) = extract_text_from_inner(&inner) {
                        let status = inner
                            .get(4)
                            .and_then(|v| v.get(0))
                            .and_then(|v| v.get(8))
                            .and_then(|v| v.as_array())
                            .and_then(|a| a.first())
                            .and_then(|v| v.as_i64());

                        let mut cid = None;
                        let mut rid = None;
                        if let Some(ids) = inner.get(1).and_then(|v| v.as_array()) {
                            if let Some(c) = ids.get(0).and_then(|v| v.as_str()) {
                                if c.starts_with("c_") {
                                    cid = Some(c.to_string());
                                }
                            }
                            if let Some(r) = ids.get(1).and_then(|v| v.as_str()) {
                                if r.starts_with("r_") {
                                    rid = Some(r.to_string());
                                }
                            }
                        }

                        let choice_id = inner
                            .get(4)
                            .and_then(|v| v.get(0))
                            .and_then(|v| v.get(0))
                            .and_then(|v| v.as_str())
                            .filter(|s| s.starts_with("rc_"))
                            .map(|s| s.to_string());

                        return Some(InnerTextExtract {
                            text,
                            status,
                            cid,
                            rid,
                            choice_id,
                        });
                    }
                }
            }
        }
    }

    None
}

// Extract a flat text string from a Pi message `content` field, which may
// be a plain string or an array of content blocks like
// [{type:"text",text:"..."}, {type:"toolCall",...}, ...].
fn extract_content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn find_response_text_brute_force(raw: &str) -> Option<String> {
    let re = Regex::new(r#""((?:[^"\\]|\\.)*)""#).ok()?;
    let mut matches = Vec::new();

    for cap in re.captures_iter(raw) {
        if let Some(m) = cap.get(1) {
            let s = m.as_str();
            if s.len() > 20
                && s.len() < 100_000
                && !s.starts_with("http")
                && !s.starts_with('!')
                && (s.contains(' ') || s.contains('\n') || s.contains("\\n"))
            {
                matches.push(s);
            }
        }
    }

    if matches.is_empty() {
        return None;
    }

    matches.sort_by_key(|b| std::cmp::Reverse(b.len()));
    let longest = matches[0];
    if let Ok(parsed) = serde_json::from_str::<String>(&format!("\"{}\"", longest)) {
        Some(parsed)
    } else {
        Some(longest.to_string())
    }
}

fn parse_gemini_response(raw: &str) -> Result<GeminiParsedResult, String> {
    let mut cleaned = raw.trim();
    if cleaned.starts_with(")]}'\n") {
        cleaned = &cleaned[5..];
    } else if cleaned.starts_with(")]}'") {
        cleaned = &cleaned[4..];
    }

    let mut all_texts = Vec::new();
    let mut stream_complete = false;
    let mut gemini_error: Option<String> = None;
    let mut conversation_id = None;
    let mut response_id = None;
    let mut choice_id = None;
    let mut continuation_token = None;

    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            if let Some(err_info) = detect_bard_error(&parsed) {
                gemini_error = Some(err_info);
                continue;
            }

            let (meta_cid, meta_rid, meta_tok) = extract_metadata(&parsed);
            if meta_tok.is_some() {
                continuation_token = meta_tok;
            }
            if meta_cid.is_some() {
                conversation_id = meta_cid;
            }
            if meta_rid.is_some() {
                response_id = meta_rid;
            }

            if let Some(extract) = extract_response_text_with_status(&parsed) {
                all_texts.push(extract.text);
                if extract.status == Some(2) {
                    stream_complete = true;
                }
                if extract.cid.is_some() {
                    conversation_id = extract.cid;
                }
                if extract.rid.is_some() {
                    response_id = extract.rid;
                }
                if extract.choice_id.is_some() {
                    choice_id = extract.choice_id;
                }
            }
        }
    }

    if !all_texts.is_empty() {
        let last_text = all_texts.last().unwrap();
        let longest_idx = all_texts
            .iter()
            .enumerate()
            .max_by_key(|(_, t)| t.len())
            .map(|(idx, _)| idx)
            .unwrap_or(0);
        let longest_text = &all_texts[longest_idx];

        let error_pattern =
            Regex::new(r"(?i)I encountered an error doing what you asked").unwrap();
        let last_is_error_replacement =
            longest_text.len() > last_text.len() * 2 && error_pattern.is_match(last_text);

        let (result_text, server_error_detected) = if last_is_error_replacement {
            (longest_text.clone(), true)
        } else if error_pattern.is_match(last_text) && all_texts.len() == 1 {
            (last_text.clone(), true)
        } else {
            (last_text.clone(), false)
        };

        let truncated = !stream_complete || gemini_error.is_some() || server_error_detected;
        let final_error_val = if server_error_detected && gemini_error.is_none() {
            Some(json!({
                "code": "gemini_stream_aborted",
                "message": "Gemini replaced stream with error message"
            }))
        } else {
            gemini_error.map(|msg| json!({ "message": msg }))
        };

        return Ok(GeminiParsedResult {
            text: result_text,
            truncated,
            gemini_error: final_error_val,
            cid: conversation_id,
            rid: response_id,
            choice_id,
            continuation_token,
        });
    }

    // Fallback: brute force
    if let Some(fallback) = find_response_text_brute_force(cleaned) {
        return Ok(GeminiParsedResult {
            text: fallback,
            truncated: true,
            gemini_error: gemini_error.map(|msg| json!({ "message": msg })),
            cid: conversation_id,
            rid: response_id,
            choice_id,
            continuation_token,
        });
    }

    if let Some(err) = gemini_error {
        return Err(format!("Gemini error: {}", err));
    }

    Err("Could not parse response text from Gemini API".to_string())
}

// ── Call Gemini Direct API ───────────────────────────────────────────

async fn call_gemini_api(
    state: &AppState,
    prompt: &str,
    conv_context: Option<&ConversationContext>,
) -> Result<GeminiParsedResult, String> {
    let cookies = { state.gemini_cookies.read().await.clone() };
    if cookies.is_empty() {
        return Err("No cookies synced from extension.".to_string());
    }

    // Ensure session validity
    let mut session = { state.session_params.read().await.clone() };
    let now = now_epoch_secs();
    if session.at_token.is_empty()
        || (now.saturating_sub(session.last_refresh_epoch) > SESSION_TTL_SECS)
    {
        session = refresh_session(state).await?;
    }

    let req_body = build_freq(prompt, conv_context, &session);
    let reqid: u32 = rand::thread_rng().gen_range(100_000..999_999);

    let mut url = format!(
        "{}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl={}",
        GEMINI_ORIGIN,
        urlencoding::encode(&session.bl)
    );
    if !session.fsid.is_empty() {
        url.push_str(&format!("&f.sid={}", urlencoding::encode(&session.fsid)));
    }
    url.push_str(&format!("&hl=en&_reqid={}&rt=c", reqid));

    info!(
        "📡 [gemini_api_call] promptLength={}, urlPrefix={}",
        prompt.len(),
        &url[..url.len().min(100)]
    );
    log_event("gemini_api_call", json!({
        "promptLength": prompt.len(),
        "url": &url[..url.len().min(100)],
    }));

    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded;charset=UTF-8"),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VAL));
    headers.insert(ORIGIN, HeaderValue::from_static(GEMINI_ORIGIN));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://gemini.google.com/"),
    );
    headers.insert("X-Same-Domain", HeaderValue::from_static("1"));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    match HeaderValue::from_str(&cookies) {
        Ok(val) => {
            headers.insert(COOKIE, val);
        }
        Err(e) => {
            error!("❌ [gemini_api_call] Failed to serialize cookies into HeaderValue: {}", e);
            return Err(format!("Invalid cookie characters for HeaderValue: {}", e));
        }
    }

    let resp = state
        .http_client
        .post(&url)
        .headers(headers)
        .body(req_body)
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        log_event("gemini_api_error", json!({
            "status": status.as_u16(),
            "bodyPreview": body_text.chars().take(300).collect::<String>(),
        }));
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            // Auth failed: reset token to trigger refresh next time
            let mut lock = state.session_params.write().await;
            lock.at_token.clear();
            return Err(format!("Auth error ({}). Cookies may be expired.", status));
        }
        return Err(format!(
            "Gemini API error: {} - {}",
            status,
            body_text.chars().take(200).collect::<String>()
        ));
    }

    log_event("parse_response", json!({ "rawLength": body_text.len() }));
    let parsed = parse_gemini_response(&body_text);
    match &parsed {
        Ok(res) => log_event("parse_success", json!({
            "resultLength": res.text.len(),
            "truncated": res.truncated,
            "geminiError": res.gemini_error.clone(),
            "cid": res.cid.clone().unwrap_or_default(),
            "rid": res.rid.clone().unwrap_or_default(),
            "hasContinuationToken": res.continuation_token.is_some(),
            "preview": res.text.chars().take(200).collect::<String>(),
        })),
        Err(e) => log_event("parse_failed", json!({ "error": e })),
    }
    parsed
}

// ── HTTP Handlers ────────────────────────────────────────────────────

async fn health_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let has_cookies = !state.gemini_cookies.read().await.is_empty();
    let session = state.session_params.read().await;
    let last_sync = *state.last_cookie_sync_epoch.read().await;
    let uptime = state.start_time.elapsed().as_secs();

    Json(json!({
        "status": "ok",
        "hasCookies": has_cookies,
        "hasSession": !session.at_token.is_empty(),
        "lastCookieSync": last_sync.and_then(|s| chrono::DateTime::from_timestamp(s as i64, 0).map(|d| d.to_rfc3339())),
        "bl": if session.bl.is_empty() { None } else { Some(&session.bl) },
        "uptime": uptime,
    }))
}

async fn cookies_post_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CookieSyncPayload>,
) -> impl IntoResponse {
    let cookie_str = match extract_cookie_string(payload.cookies) {
        Ok(s) => s,
        Err(err) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": err }))).into_response();
        }
    };

    let new_hash = hash_cookies(&cookie_str);
    let mut cookies_lock = state.gemini_cookies.write().await;
    let mut hash_lock = state.gemini_cookies_hash.write().await;
    let mut sync_lock = state.last_cookie_sync_epoch.write().await;

    let cookies_changed = !cookie_str.is_empty() && *hash_lock != new_hash;
    let cookie_len = cookie_str.len();

    if !cookie_str.is_empty() {
        *cookies_lock = cookie_str;
        *hash_lock = new_hash;
    }
    *sync_lock = Some(now_epoch_secs());

    if cookies_changed {
        let mut session_lock = state.session_params.write().await;
        session_lock.last_refresh_epoch = 0; // mark stale for refresh
        info!(
            "🍪 [cookies_synced] Updated cookies (length={}), changed=true",
            cookie_len
        );
    } else {
        info!(
            "🍪 [cookies_synced] Updated cookies (length={}), changed=false",
            cookie_len
        );
    }
    log_event("cookies_synced", json!({
        "cookieLength": cookie_len,
        "cookiesChanged": cookies_changed,
    }));

    Json(json!({ "ok": true, "cookieLength": cookie_len })).into_response()
}

async fn cookies_status_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cookies = state.gemini_cookies.read().await;
    let session = state.session_params.read().await;
    let last_sync = *state.last_cookie_sync_epoch.read().await;
    let now = now_epoch_secs();

    let cookie_age = last_sync.map(|s| (now.saturating_sub(s)) * 1000);

    Json(json!({
        "hasCookies": !cookies.is_empty(),
        "hasAtToken": !session.at_token.is_empty(),
        "lastSync": last_sync.and_then(|s| chrono::DateTime::from_timestamp(s as i64, 0).map(|d| d.to_rfc3339())),
        "cookieAge": cookie_age,
    }))
}

async fn session_refresh_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match refresh_session(&state).await {
        Ok(params) => Json(json!({
            "ok": true,
            "hasAtToken": !params.at_token.is_empty(),
            "bl": params.bl,
            "hasFsid": !params.fsid.is_empty(),
        }))
        .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

async fn completions_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CompletionRequest>,
) -> impl IntoResponse {
    let request_id = payload
        .request_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let prompt = if let Some(p) = payload.prompt {
        p
    } else if let Some(msgs) = payload.messages {
        // Best-effort text extraction from the last message. Handles both
        // shapes: plain string, or array of content blocks (concatenates
        // any `text` fields).
        msgs.last()
            .and_then(|m| m.content.as_ref())
            .map(extract_content_text)
            .unwrap_or_default()
    } else {
        String::new()
    };

    if prompt.trim().is_empty() {
        log_event("completion_error", json!({
            "requestId": &request_id,
            "error": "No prompt provided",
        }));
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No prompt provided", "requestId": request_id })),
        )
            .into_response();
    }

    let conversation_id = payload.conversation_id;

    info!(
        "📥 [completions_request] requestId={}, promptLength={}, conversationId={:?}",
        request_id,
        prompt.len(),
        conversation_id
    );
    log_event("completion_request", json!({
        "requestId": &request_id,
        "promptLength": prompt.len(),
        "conversationId": conversation_id.clone().unwrap_or_default(),
    }));

    let has_cookies = !state.gemini_cookies.read().await.is_empty();
    if !has_cookies {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "No cookies available. Sync from extension first.",
                "requestId": request_id
            })),
        )
            .into_response();
    }

    let conv_context = if let Some(ref cid) = conversation_id {
        let mut lock = state.conversations.write().await;
        let now = now_epoch_secs();
        prune_stale_conversations(&mut lock, now);
        if let Some(ctx) = lock.get_mut(cid) {
            ctx.last_accessed = now;
            Some(ctx.clone())
        } else {
            None
        }
    } else {
        None
    };

    let mut call_result = call_gemini_api(&state, &prompt, conv_context.as_ref()).await;

    if call_result.is_err() {
        let err_msg = call_result.as_ref().err().cloned().unwrap_or_default();
        log_event("completion_first_attempt_failed", json!({
            "requestId": &request_id,
            "error": err_msg,
        }));
        let needs_refresh = { state.session_params.read().await.at_token.is_empty() };
        if needs_refresh {
            warn!("⚠️ First attempt failed with auth issue, attempting session refresh and retry...");
            if (refresh_session(&state).await).is_ok() {
                call_result = call_gemini_api(&state, &prompt, conv_context.as_ref()).await;
            }
        }
    }

    match call_result {
        Ok(res) => {
            if let Some(ref conv_key) = conversation_id {
                let mut lock = state.conversations.write().await;
                let now = now_epoch_secs();
                prune_stale_conversations(&mut lock, now);
                if res.cid.is_some() && !res.truncated && res.gemini_error.is_none() && res.continuation_token.is_some() {
                    let new_cid = res.cid.as_ref().unwrap();
                    lock.insert(
                        conv_key.clone(),
                        ConversationContext {
                            cid: new_cid.clone(),
                            rid: res.rid.clone().unwrap_or_default(),
                            choice_id: res.choice_id.clone().unwrap_or_default(),
                            continuation_token: res.continuation_token.clone(),
                            last_accessed: now,
                        },
                    );
                    info!(
                        "💬 [conversation_updated] convId={}, cid={}, rid={:?}, hasContinuationToken=true",
                        conv_key, new_cid, res.rid
                    );
                    log_event("conversation_updated", json!({
                        "conversationId": conv_key,
                        "cid": new_cid,
                        "rid": res.rid.clone().unwrap_or_default(),
                        "hasContinuationToken": true,
                    }));
                } else if res.truncated || res.gemini_error.is_some() {
                    lock.remove(conv_key);
                    let reason = res.gemini_error.as_ref().map(|e| e.to_string()).unwrap_or_else(|| "truncated".to_string());
                    warn!(
                        "⚠️ [conversation_dropped] convId={}, reason={:?}",
                        conv_key, reason
                    );
                    log_event("conversation_dropped", json!({
                        "conversationId": conv_key,
                        "reason": reason,
                    }));
                }
            }

            info!(
                "📤 [completion_success] requestId={}, responseLength={}, truncated={}",
                request_id,
                res.text.len(),
                res.truncated
            );
            log_event("completion_success", json!({
                "requestId": &request_id,
                "responseLength": res.text.len(),
                "truncated": res.truncated,
                "geminiError": res.gemini_error.clone(),
            }));

            let response = CompletionResponse {
                request_id,
                text: Some(res.text),
                conversation_id: res.cid,
                truncated: if res.truncated { Some(true) } else { None },
                gemini_error: res.gemini_error,
                error: None,
            };

            (StatusCode::OK, Json(response)).into_response()
        }
        Err(err) => {
            error!(
                "❌ [completion_error] requestId={}, error={}",
                request_id, err
            );
            log_event("completion_error", json!({
                "requestId": &request_id,
                "error": &err,
            }));
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "requestId": request_id,
                    "error": err
                })),
            )
                .into_response()
        }
    }
}

// ── Main Entrypoint ──────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3456);

    let proxy_url = env::var("https_proxy")
        .or_else(|_| env::var("HTTPS_PROXY"))
        .or_else(|_| env::var("http_proxy"))
        .or_else(|_| env::var("HTTP_PROXY"))
        .ok();

    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .pool_idle_timeout(Duration::from_secs(60));

    if let Some(ref p) = proxy_url {
        match reqwest::Proxy::all(p) {
            Ok(proxy) => {
                client_builder = client_builder.proxy(proxy);
                info!("🌐 Configured proxy: {}", p);
            }
            Err(e) => {
                warn!("⚠️ Invalid proxy configuration '{}': {}", p, e);
            }
        }
    }

    let http_client = client_builder.build().expect("Failed to create reqwest client");

    let app_state = Arc::new(AppState {
        gemini_cookies: RwLock::new(String::new()),
        gemini_cookies_hash: RwLock::new(String::new()),
        last_cookie_sync_epoch: RwLock::new(None),
        session_params: RwLock::new(SessionParams::default()),
        conversations: RwLock::new(HashMap::new()),
        http_client,
        start_time: Instant::now(),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/cookies", post(cookies_post_handler))
        .route("/api/cookies/status", get(cookies_status_handler))
        .route("/api/session/refresh", post(session_refresh_handler))
        .route("/api/bridge/completions", post(completions_handler))
        .layer(cors)
        .with_state(app_state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    println!("\n🌉 Gemini Direct API Bridge Server (Rust)");
    println!("   Listening on http://localhost:{}", port);
    println!("   Proxy: {}", proxy_url.as_deref().unwrap_or("none (direct)"));
    println!("   Endpoints:");
    println!("     POST /api/cookies           — Extension syncs cookies here");
    println!("     GET  /api/cookies/status     — Check cookie status");
    println!("     POST /api/session/refresh    — Force refresh session params");
    println!("     POST /api/bridge/completions — Pi Agent completion requests");
    println!("     GET  /health                — Health check\n");

    axum::serve(listener, app).await.unwrap();
}