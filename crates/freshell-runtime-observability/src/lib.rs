//! Shared, fail-closed runtime observability primitives.
//!
//! The web server, supervisor, and session host all need the same two
//! guarantees: secrets are removed before the first byte reaches disk, and
//! long-running JSONL evidence remains size bounded. This crate deliberately
//! has no process-management or runtime-registry authority.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn token_field_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)"([a-z0-9_-]*(?:token|secret|password|credential|api[_-]?key)[a-z0-9_-]*)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid secret-field redaction regex")
    })
}

fn cookie_field_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)"(cookie|authorization)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid auth-field redaction regex")
    })
}

fn cookie_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(cookie|set-cookie|authorization)\s*:\s*[^\r\n\x22]+")
            .expect("valid auth-header redaction regex")
    })
}

fn bearer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}").expect("valid bearer redaction regex")
    })
}

fn common_secret_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,})\b",
        )
        .expect("valid common-secret redaction regex")
    })
}

fn secret_query_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)([?&](?:token|access_token|api[_-]?key|secret|password)=)[^&#\s]+")
            .expect("valid secret-query redaction regex")
    })
}

fn provider_content_field_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)"([a-z0-9_-]*(?:transcript|provider[_-]?response|response[_-]?content|raw[_-]?output)[a-z0-9_-]*)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid provider-content redaction regex")
    })
}

/// The shortest value [`LiveSecrets`] accepts: a real credential is far
/// longer, and a very short value would shred ordinary log text.
pub const MIN_LIVE_SECRET_LEN: usize = 8;

/// Secret values that are only known while the process runs (a Gemini key
/// saved in Settings, say), shared between whoever learns them and the
/// writers that must redact them. Clones share one set.
#[derive(Clone, Default)]
pub struct LiveSecrets(std::sync::Arc<std::sync::RwLock<Vec<String>>>);

impl LiveSecrets {
    /// Add a value; `false` when it is too short or already present. Values
    /// are never removed: a key replaced in Settings may still appear in a
    /// late line, and the failure direction is over-redaction.
    pub fn insert(&self, secret: &str) -> bool {
        if secret.len() < MIN_LIVE_SECRET_LEN {
            return false;
        }
        let mut values = self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if values.iter().any(|value| value == secret) {
            return false;
        }
        values.push(secret.to_string());
        // Longest first, so a secret that contains another is replaced whole.
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        true
    }

    /// Replace every live secret value in `line`.
    pub fn redact(&self, line: String) -> String {
        let values = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        values.iter().fold(line, |line, value| {
            if line.contains(value.as_str()) {
                line.replace(value.as_str(), "***REDACTED***")
            } else {
                line
            }
        })
    }
}

/// [`scrub`] plus the live secret values. The exact values are replaced
/// FIRST: a pattern that matches only part of a value (an `AQ.` key with a
/// second `.`, say) would otherwise leave the rest of it behind.
pub fn scrub_with_live_secrets(line: &str, process_secret: &str, live: &LiveSecrets) -> String {
    scrub(&live.redact(line.to_string()), process_secret)
}

/// Scrub one already-rendered record before it reaches any persistent sink.
///
/// The exact process secret is replaced everywhere, then common and future
/// credential-bearing JSON fields are redacted by name. The failure direction
/// is over-redaction; never preserve a suspicious credential value.
pub fn scrub(line: &str, process_secret: &str) -> String {
    let mut out = line.to_string();
    if !process_secret.is_empty() {
        out = out.replace(process_secret, "***REDACTED***");
    }
    out = token_field_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("\"{}\":\"***REDACTED***\"", &caps[1])
        })
        .into_owned();
    out = cookie_field_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("\"{}\":\"***REDACTED***\"", &caps[1])
        })
        .into_owned();
    out = cookie_header_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("{}: ***REDACTED***", &caps[1])
        })
        .into_owned();
    out = bearer_re()
        .replace_all(&out, "Bearer ***REDACTED***")
        .into_owned();
    out = common_secret_re()
        .replace_all(&out, "***REDACTED***")
        .into_owned();
    out = provider_content_field_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("\"{}\":\"***REDACTED***\"", &caps[1])
        })
        .into_owned();
    secret_query_re()
        .replace_all(&out, "$1***REDACTED***")
        .into_owned()
}

fn redact_live_values(value: &mut Value, live: &LiveSecrets) {
    match value {
        Value::String(text) => {
            let redacted = live.redact(std::mem::take(text));
            *text = redacted;
        }
        Value::Object(fields) => fields
            .values_mut()
            .for_each(|child| redact_live_values(child, live)),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|child| redact_live_values(child, live)),
        _ => {}
    }
}

fn redact_sensitive_json(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if sensitive_json_key(key) {
                    *child = Value::String("***REDACTED***".into());
                } else {
                    redact_sensitive_json(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_sensitive_json),
        _ => {}
    }
}

fn sensitive_json_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "token",
        "secret",
        "password",
        "credential",
        "apikey",
        "authorization",
        "cookie",
        "transcript",
        "providerresponse",
        "responsecontent",
        "rawoutput",
    ]
    .iter()
    .any(|fragment| normalized.contains(fragment))
}

fn redacted_json<T: Serialize>(
    value: &T,
    pretty: bool,
    process_secret: &str,
) -> std::io::Result<String> {
    let mut value = serde_json::to_value(value).map_err(std::io::Error::other)?;
    redact_sensitive_json(&mut value);
    let encoded = if pretty {
        serde_json::to_string_pretty(&value)
    } else {
        serde_json::to_string(&value)
    }
    .map_err(std::io::Error::other)?;
    Ok(scrub(&encoded, process_secret))
}

struct RotatingInner {
    path: PathBuf,
    max_bytes: u64,
    max_backups: u32,
    file: File,
    size: u64,
    process_secret: String,
    live_secrets: LiveSecrets,
}

impl RotatingInner {
    fn backup_path(&self, n: u32) -> PathBuf {
        let mut value = self.path.as_os_str().to_os_string();
        value.push(format!(".{n}"));
        PathBuf::from(value)
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.sync_all()?;
        if self.max_backups == 0 {
            let _ = fs::remove_file(&self.path);
        } else {
            let _ = fs::remove_file(self.backup_path(self.max_backups));
            for n in (1..self.max_backups).rev() {
                let from = self.backup_path(n);
                let to = self.backup_path(n + 1);
                if from.exists() {
                    fs::rename(from, to)?;
                }
            }
            if self.path.exists() {
                fs::rename(&self.path, self.backup_path(1))?;
            }
        }
        self.file = secure_append_file(&self.path)?;
        self.size = 0;
        Ok(())
    }
}

/// Synchronous redacting JSONL sink with bounded active/backup files.
/// Every successful write is flushed; [`sync_all`](Self::sync_all) gives
/// callers an explicit incident-before-cleanup durability barrier.
pub struct RotatingJsonlWriter {
    inner: Mutex<RotatingInner>,
}

impl RotatingJsonlWriter {
    pub fn create(
        path: impl Into<PathBuf>,
        max_bytes: u64,
        max_backups: u32,
        process_secret: impl Into<String>,
    ) -> std::io::Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            create_private_dir(parent)?;
        }
        let file = secure_append_file(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            inner: Mutex::new(RotatingInner {
                path,
                max_bytes: max_bytes.max(1),
                max_backups,
                file,
                size,
                process_secret: process_secret.into(),
                live_secrets: LiveSecrets::default(),
            }),
        })
    }

    /// [`create`](Self::create), also redacting every value in `live_secrets`
    /// (including values added after creation).
    pub fn create_with_live_secrets(
        path: impl Into<PathBuf>,
        max_bytes: u64,
        max_backups: u32,
        process_secret: impl Into<String>,
        live_secrets: LiveSecrets,
    ) -> std::io::Result<Self> {
        let writer = Self::create(path, max_bytes, max_backups, process_secret)?;
        writer
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .live_secrets = live_secrets;
        Ok(writer)
    }

    pub fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let scrubbed = scrub_with_live_secrets(line, &inner.process_secret, &inner.live_secrets);
        let mut bytes = scrubbed.into_bytes();
        bytes.push(b'\n');
        if inner.size > 0 && inner.size.saturating_add(bytes.len() as u64) > inner.max_bytes {
            inner.rotate()?;
        }
        inner.file.write_all(&bytes)?;
        inner.file.flush()?;
        inner.size = inner.size.saturating_add(bytes.len() as u64);
        Ok(())
    }

    pub fn write_json<T: Serialize>(&self, value: &T) -> std::io::Result<()> {
        let (process_secret, live_secrets) = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (inner.process_secret.clone(), inner.live_secrets.clone())
        };
        // Exact live values first (see `scrub_with_live_secrets`): JSON
        // field redaction below would otherwise run on a partly matched key.
        let mut value = serde_json::to_value(value).map_err(std::io::Error::other)?;
        redact_live_values(&mut value, &live_secrets);
        let line = redacted_json(&value, false, &process_secret)?;
        self.write_line(&line)
    }

    pub fn sync_all(&self) -> std::io::Result<()> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .file
            .sync_all()
    }
}

/// Atomically replace a private JSON document after redaction and fsync both
/// the file and containing directory. The caller supplies a stable final path;
/// temporary names never contain provider/native identity.
pub fn atomic_write_redacted_json<T: Serialize>(
    path: &Path,
    value: &T,
    process_secret: &str,
) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("document path has no parent"))?;
    create_private_dir(parent)?;
    let redacted = redacted_json(value, true, process_secret)?;
    static TEMP_NONCE: AtomicU64 = AtomicU64::new(1);
    let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&tmp)?;
    let result = (|| {
        file.write_all(redacted.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn now_rfc3339_millis() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn secure_append_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_exact_and_schema_named_secrets() {
        let secret = "never-persist-this-secret";
        let line = format!(r#"{{"token":"{secret}","futureCredential":"other","safe":"value"}}"#);
        let out = scrub(&line, secret);
        assert!(!out.contains(secret));
        assert!(!out.contains("other"));
        assert!(out.contains("\"safe\":\"value\""));
        let unstructured = scrub(
            "authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnop https://x.test/?access_token=secret-value",
            "",
        );
        assert!(!unstructured.contains("abcdefghijklmnop"));
        assert!(!unstructured.contains("secret-value"));

        let provider_content = scrub(
            r#"{"nativeTranscript":"synthetic native transcript text","providerResponse":"provider-private-content","safe":"retained"}"#,
            "",
        );
        assert!(!provider_content.contains("synthetic native transcript text"));
        assert!(!provider_content.contains("provider-private-content"));
        assert!(provider_content.contains("retained"));

        let dir = tempfile::tempdir().unwrap();
        let nested_path = dir.path().join("nested.jsonl");
        let writer = RotatingJsonlWriter::create(&nested_path, 4096, 1, "").unwrap();
        writer
            .write_json(&serde_json::json!({
                "providerResponse": { "content": "nested provider-private-content" },
                "nativeTranscript": ["synthetic native transcript text"],
                "safe": "retained",
            }))
            .unwrap();
        let nested = fs::read_to_string(nested_path).unwrap();
        assert!(!nested.contains("nested provider-private-content"));
        assert!(!nested.contains("synthetic native transcript text"));
        assert!(nested.contains("retained"));
    }

    /// Name-reliability Task 6: values added to the live set after the
    /// writer exists are redacted WHOLE on both write paths, even where a
    /// common pattern would match only part of them (a second `.` stops the
    /// `AQ.` pattern).
    #[test]
    fn live_secrets_are_redacted_whole_on_both_write_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let live = LiveSecrets::default();
        let writer =
            RotatingJsonlWriter::create_with_live_secrets(&path, 1 << 20, 1, "", live.clone())
                .unwrap();
        let key = "AQ.firstPartOfTheKey12345.tail-after-the-second-dot";
        assert!(live.insert(key));
        assert!(!live.insert(key), "a value is kept once");
        writer.write_line(&format!("line carrying {key}")).unwrap();
        writer
            .write_json(
                &serde_json::json!({ "detail": format!("json carrying {key}"), "list": [key] }),
            )
            .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(!content.contains("tail-after-the-second-dot"), "{content}");
        assert!(!content.contains("firstPartOfTheKey"), "{content}");
        assert!(
            content.contains("line carrying ***REDACTED***"),
            "{content}"
        );
        assert!(
            content.contains("json carrying ***REDACTED***"),
            "{content}"
        );
    }

    #[test]
    fn rotation_and_atomic_documents_are_private_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let writer = RotatingJsonlWriter::create(&path, 180, 2, "secret").unwrap();
        for index in 0..100 {
            writer
                .write_json(&serde_json::json!({
                    "index": index,
                    "authorization": "secret-value",
                    "padding": "padding padding padding"
                }))
                .unwrap();
        }
        writer.sync_all().unwrap();
        assert!(path.exists());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("secret-value"));
        let count = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("events.jsonl")
            })
            .count();
        assert!(count <= 3);

        let document = dir.path().join("incident.json");
        atomic_write_redacted_json(
            &document,
            &serde_json::json!({"apiKey":"secret-value","safe":1}),
            "",
        )
        .unwrap();
        let content = fs::read_to_string(&document).unwrap();
        assert!(!content.contains("secret-value"));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(document).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
