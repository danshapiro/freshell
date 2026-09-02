//! Pane-content pure helpers for [`super`] (`layout_store`), split out to keep
//! `layout_store.rs` under the 1,000-line ceiling (branch precedent:
//! `freshell-ws/src/tabs_store_migrate.rs`):
//!
//! - derived pane titles (`derivePaneTitle`, `layout-store.ts:93-167`)
//! - resize percent math (`router.ts:608-619`)
//! - the legacy fresh-agent content migration (`shared/fresh-agent.ts:140-360`
//!   + `shared/session-contract.ts:34-62`) that `normalizeLayouts` /
//!     `normalizePaneContentSnapshot` (`layout-store.ts:29-38`) run.

use serde_json::{json, Map, Value};

// ── derived titles (`derivePaneTitle`, `layout-store.ts:93-167`) ─────────────

/// Derive a pane title from its content. Empty string == Node's `undefined`
/// (no derivable title — the pane keeps whatever title it has).
pub fn derive_pane_title(content: &Value) -> String {
    let Some(obj) = content.as_object() else {
        return String::new();
    };
    match obj.get("kind").and_then(Value::as_str).unwrap_or("") {
        "editor" => {
            let Some(path) = obj
                .get("filePath")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
            else {
                return "Editor".to_string();
            };
            let normalized = path.replace('\\', "/");
            normalized
                .rsplit('/')
                .next()
                .filter(|part| !part.is_empty())
                .unwrap_or("Editor")
                .to_string()
        }
        "browser" => {
            let Some(url) = obj
                .get("url")
                .and_then(Value::as_str)
                .filter(|u| !u.is_empty())
            else {
                return "Browser".to_string();
            };
            browser_hostname(url).unwrap_or_else(|| "Browser".to_string())
        }
        "fresh-agent" => match obj.get("sessionType").and_then(Value::as_str) {
            Some("freshclaude") => "Freshclaude".to_string(),
            Some("freshcodex") => "Freshcodex".to_string(),
            Some("freshopencode") => "OpenCode".to_string(),
            Some("kilroy") => "Kilroy".to_string(),
            _ => "Fresh Agent".to_string(),
        },
        "extension" => obj
            .get("extensionName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or("Extension")
            .to_string(),
        "host-stats" => "Host Stats".to_string(),
        "terminal" => match obj.get("mode").and_then(Value::as_str) {
            Some("claude") => "Claude CLI".to_string(),
            Some("codex") => "Codex CLI".to_string(),
            Some("gemini") => "Gemini".to_string(),
            Some("opencode") => "OpenCode".to_string(),
            Some("kimi") => "Kimi".to_string(),
            _ => match obj.get("shell").and_then(Value::as_str) {
                Some("powershell") => "PowerShell".to_string(),
                Some("cmd") => "Command Prompt".to_string(),
                Some("wsl") => "WSL".to_string(),
                _ => "Shell".to_string(),
            },
        },
        _ => String::new(),
    }
}

/// WHATWG-lite hostname extraction standing in for Node's `new URL(url).hostname`
/// (`layout-store.ts:104-109`): requires `scheme://`, strips userinfo/port/path,
/// lowercases. Anything unparsable -> `None` (-> "Browser").
fn browser_hostname(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let hostname = if host_port.starts_with('[') {
        host_port.split_inclusive(']').next().unwrap_or(host_port)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if hostname.is_empty() {
        return None;
    }
    Some(hostname.to_ascii_lowercase())
}

// ── resize helpers (`router.ts:608-619`) ─────────────────────────────────────

/// `normalizePairToHundred` (`router.ts:611-619`): clamp both to 1..=99, then
/// scale so the pair sums to exactly 100.
pub fn normalize_pair_to_hundred(a: f64, b: f64) -> [f64; 2] {
    let left = a.clamp(1.0, 99.0);
    let right = b.clamp(1.0, 99.0);
    let total = left + right;
    let normalized_left = (left / total * 100.0).round().clamp(1.0, 99.0);
    [normalized_left, 100.0 - normalized_left]
}

/// `isValidPercent` (`router.ts:608`): finite and within 1..=99.
pub fn is_valid_percent(n: f64) -> bool {
    n.is_finite() && (1.0..=99.0).contains(&n)
}

// ── legacy fresh-agent migration (`shared/fresh-agent.ts:199-360`) ───────────

const FRESH_AGENT_SESSION_TYPES: [&str; 4] =
    ["freshclaude", "freshcodex", "kilroy", "freshopencode"];

const RESTORE_ERROR_REASONS: [&str; 5] = [
    "missing_canonical_identity",
    "invalid_legacy_restore_target",
    "dead_live_handle",
    "provider_runtime_failed",
    "durable_artifact_missing",
];

/// Keys the migration re-derives (`shared/fresh-agent.ts:254-263`).
const LEGACY_STRIP_KEYS: [&str; 7] = [
    "kind",
    "provider",
    "sessionRef",
    "resumeSessionId",
    "timelineSessionId",
    "cliSessionId",
    "restoreError",
];

/// `FRESH_AGENT_DESCRIPTORS` runtime-provider mapping (`shared/fresh-agent.ts:77-120`).
fn runtime_provider_for(session_type: &str) -> Option<&'static str> {
    match session_type {
        "freshclaude" | "kilroy" => Some("claude"),
        "freshcodex" => Some("codex"),
        "freshopencode" => Some("opencode"),
        _ => None,
    }
}

fn normalize_session_type(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| FRESH_AGENT_SESSION_TYPES.contains(s))
}

/// `CLAUDE_SESSION_ID_RE` (`shared/session-contract.ts:34`), hand-rolled.
fn is_canonical_claude_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => *b == b'-',
        14 => (b'1'..=b'5').contains(b),
        19 => matches!(b.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
        _ => b.is_ascii_hexdigit(),
    })
}

/// `sanitizeSessionRef` (`shared/session-contract.ts:55-62`).
fn sanitize_session_ref(value: Option<&Value>) -> Option<(String, String)> {
    let obj = value?.as_object()?;
    let provider = obj.get("provider")?.as_str().filter(|s| !s.is_empty())?;
    let session_id = obj.get("sessionId")?.as_str().filter(|s| !s.is_empty())?;
    Some((provider.to_string(), session_id.to_string()))
}

fn restore_error_value(reason: &str) -> Value {
    json!({ "code": "RESTORE_UNAVAILABLE", "reason": reason })
}

/// `readRestoreError` (`shared/fresh-agent.ts:190-197`).
fn read_restore_error(value: Option<&Value>) -> Option<Value> {
    let obj = value?.as_object()?;
    if obj.get("code")?.as_str()? != "RESTORE_UNAVAILABLE" {
        return None;
    }
    let reason = obj.get("reason")?.as_str()?;
    RESTORE_ERROR_REASONS
        .contains(&reason)
        .then(|| restore_error_value(reason))
}

struct DurableState {
    session_ref: Option<Value>,
    restore_error: Option<Value>,
}

/// `migrateLegacyFreshAgentDurableState` (`shared/fresh-agent.ts:140-188`).
fn migrate_durable_state(
    provider: Option<&str>,
    session_ref: Option<&Value>,
    resume_session_id: Option<&str>,
    reject_non_canonical_claude: bool,
) -> DurableState {
    if let Some((ref_provider, ref_session_id)) = sanitize_session_ref(session_ref) {
        if reject_non_canonical_claude
            && ref_provider == "claude"
            && !is_canonical_claude_session_id(&ref_session_id)
        {
            return DurableState {
                session_ref: None,
                restore_error: Some(restore_error_value("invalid_legacy_restore_target")),
            };
        }
        return DurableState {
            session_ref: Some(json!({ "provider": ref_provider, "sessionId": ref_session_id })),
            restore_error: None,
        };
    }
    let (Some(provider), Some(resume)) = (provider, resume_session_id) else {
        return DurableState {
            session_ref: None,
            restore_error: None,
        };
    };
    if provider == "claude" && !is_canonical_claude_session_id(resume) {
        return DurableState {
            session_ref: None,
            restore_error: Some(restore_error_value("invalid_legacy_restore_target")),
        };
    }
    DurableState {
        session_ref: Some(json!({ "provider": provider, "sessionId": resume })),
        restore_error: None,
    }
}

fn strip_legacy_keys(obj: &Map<String, Value>) -> Map<String, Value> {
    obj.iter()
        .filter(|(key, _)| !LEGACY_STRIP_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn resume_chain(obj: &Map<String, Value>) -> Option<&str> {
    obj.get("resumeSessionId")
        .and_then(Value::as_str)
        .or_else(|| obj.get("timelineSessionId").and_then(Value::as_str))
        .or_else(|| obj.get("cliSessionId").and_then(Value::as_str))
}

/// `migrateLegacyFreshAgentContent` (`shared/fresh-agent.ts:199-334`).
pub(crate) fn migrate_legacy_fresh_agent_content(input: &Value) -> Value {
    let Some(obj) = input.as_object() else {
        return input.clone();
    };
    match obj.get("kind").and_then(Value::as_str) {
        Some("fresh-agent") => migrate_fresh_agent_kind(obj).unwrap_or_else(|| input.clone()),
        Some("agent-chat") => migrate_agent_chat_kind(obj),
        _ => input.clone(),
    }
}

/// The `kind === 'fresh-agent'` arm (`shared/fresh-agent.ts:206-277`);
/// `None` == "cannot resolve sessionType/provider, return the input untouched".
fn migrate_fresh_agent_kind(obj: &Map<String, Value>) -> Option<Value> {
    let session_type = normalize_session_type(obj.get("sessionType"))
        .or_else(|| normalize_session_type(obj.get("provider")))?;
    let provider = match obj.get("provider").and_then(Value::as_str) {
        Some(p @ ("claude" | "codex" | "opencode")) => Some(p),
        _ => runtime_provider_for(session_type),
    }?;
    let mut rest = strip_legacy_keys(obj);
    rest.insert("kind".to_string(), json!("fresh-agent"));
    rest.insert("provider".to_string(), json!(provider));
    rest.insert("sessionType".to_string(), json!(session_type));

    if let Some(existing) = read_restore_error(obj.get("restoreError")) {
        if existing["reason"] != json!("invalid_legacy_restore_target") {
            if let Some(resume) = obj.get("resumeSessionId").and_then(Value::as_str) {
                rest.insert("resumeSessionId".to_string(), json!(resume));
            }
        }
        rest.insert("restoreError".to_string(), existing);
        return Some(Value::Object(rest));
    }

    let durable = migrate_durable_state(
        Some(provider),
        obj.get("sessionRef"),
        resume_chain(obj),
        true,
    );
    if let Some(error) = durable.restore_error {
        rest.insert("restoreError".to_string(), error);
    } else {
        if let Some(resume) = obj.get("resumeSessionId").and_then(Value::as_str) {
            rest.insert("resumeSessionId".to_string(), json!(resume));
        }
        if let Some(session_ref) = durable.session_ref {
            rest.insert("sessionRef".to_string(), session_ref);
        }
    }
    Some(Value::Object(rest))
}

/// The `kind === 'agent-chat'` arm (`shared/fresh-agent.ts:279-334`).
fn migrate_agent_chat_kind(obj: &Map<String, Value>) -> Value {
    let provider_raw = obj.get("provider").and_then(Value::as_str);
    let session_type =
        normalize_session_type(obj.get("provider")).or(if provider_raw == Some("claude") {
            Some("freshclaude")
        } else {
            None
        });
    let provider =
        session_type
            .and_then(runtime_provider_for)
            .or(if provider_raw == Some("claude") {
                Some("claude")
            } else {
                None
            });
    let durable = migrate_durable_state(provider, obj.get("sessionRef"), resume_chain(obj), true);
    let has_usable_identity = durable.session_ref.is_some()
        || obj
            .get("sessionId")
            .and_then(Value::as_str)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
    let restore_error = read_restore_error(obj.get("restoreError"))
        .or(durable.restore_error)
        .or_else(|| {
            (session_type.is_none() || provider.is_none() || !has_usable_identity)
                .then(|| restore_error_value("invalid_legacy_restore_target"))
        });

    let mut rest = strip_legacy_keys(obj);
    rest.insert("kind".to_string(), json!("fresh-agent"));
    rest.insert(
        "sessionType".to_string(),
        json!(session_type.unwrap_or("freshclaude")),
    );
    rest.insert("provider".to_string(), json!(provider.unwrap_or("claude")));
    if let Some(error) = restore_error {
        if error["reason"] != json!("invalid_legacy_restore_target") {
            if let Some(resume) = obj.get("resumeSessionId").and_then(Value::as_str) {
                rest.insert("resumeSessionId".to_string(), json!(resume));
            }
        }
        rest.insert("restoreError".to_string(), error);
    } else {
        if let Some(resume) = obj.get("resumeSessionId").and_then(Value::as_str) {
            rest.insert("resumeSessionId".to_string(), json!(resume));
        }
        if let Some(session_ref) = durable.session_ref {
            rest.insert("sessionRef".to_string(), session_ref);
        }
    }
    Value::Object(rest)
}

/// `migrateLegacyFreshAgentNode` (`shared/fresh-agent.ts:340-360`).
pub(crate) fn migrate_legacy_fresh_agent_node(node: &Value) -> Value {
    let Some(obj) = node.as_object() else {
        return node.clone();
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("leaf") => {
            let Some(content) = obj.get("content").filter(|c| c.is_object()) else {
                return node.clone();
            };
            let mut out = obj.clone();
            out.insert(
                "content".to_string(),
                migrate_legacy_fresh_agent_content(content),
            );
            Value::Object(out)
        }
        Some("split") => {
            let Some(children) = obj.get("children").and_then(Value::as_array) else {
                return node.clone();
            };
            let mut out = obj.clone();
            out.insert(
                "children".to_string(),
                Value::Array(
                    children
                        .iter()
                        .map(migrate_legacy_fresh_agent_node)
                        .collect(),
                ),
            );
            Value::Object(out)
        }
        _ => node.clone(),
    }
}
