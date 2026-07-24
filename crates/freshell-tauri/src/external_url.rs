//! Open-external-URL command — the Rust analog of `electron/external-url.ts`
//! (`canonicalizeExternalUrl` + the `open-external-url` IPC handler,
//! `external-url.ts:6-43`), the target of the SPA's `freshellDesktop.openExternal`
//! (`src/lib/open-url.ts:34-38`).
//!
//! The canonicalization gate is preserved verbatim (`external-url.ts:6-20`):
//! reject control chars, require a parseable absolute URL, require an `http`/`https`
//! scheme, and reject embedded credentials. Only then is the URL handed to the
//! system browser — here via `tauri-plugin-opener` (`open_url`), the mapping named
//! in `electron-tauri.md §6` (`shell.openExternal` → `tauri-plugin-opener`).
//!
//! The pure [`canonicalize_external_url`] is unit-tested against the accept/reject
//! matrix headlessly; the `#[tauri::command]` wrapper is the thin IPC seam.

/// Why an external-URL request was rejected. Mirrors the two `throw`s in
/// `external-url.ts:39-41` (canonicalization) — the sender/origin gate is handled
/// separately by Tauri per-window capabilities (`architecture-spec.md:338-340`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalUrlError {
    /// Control character present (`CONTROL_CHAR_RE`, `external-url.ts:4,9`).
    ControlCharacter,
    /// `new URL(url)` would throw (unparseable / not absolute).
    Unparseable,
    /// Scheme is not `http`/`https` (`ALLOWED_PROTOCOLS`, `external-url.ts:3,16`).
    DisallowedScheme,
    /// URL smuggles credentials (`parsed.username || parsed.password`,
    /// `external-url.ts:18`).
    EmbeddedCredentials,
}

impl std::fmt::Display for ExternalUrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            ExternalUrlError::ControlCharacter => "contains control characters",
            ExternalUrlError::Unparseable => "is not a canonical absolute URL",
            ExternalUrlError::DisallowedScheme => "scheme is not http/https",
            ExternalUrlError::EmbeddedCredentials => "must not embed credentials",
        };
        write!(
            f,
            "open-external-url rejected: only canonical absolute http/https URLs are allowed ({reason})"
        )
    }
}

impl std::error::Error for ExternalUrlError {}

const ALLOWED_SCHEMES: [&str; 2] = ["http", "https"];

/// Canonicalize an external URL exactly like `external-url.ts:6-20`, returning the
/// canonical string (`parsed.toString()`) on success. Order of checks matches the
/// reference: control chars → parse → scheme → credentials.
pub fn canonicalize_external_url(url: &str) -> Result<String, ExternalUrlError> {
    // 1. Reject control characters (0x00–0x1F, 0x7F) anywhere in the input.
    if url.chars().any(is_control_char) {
        return Err(ExternalUrlError::ControlCharacter);
    }
    // 2. Must parse as an absolute URL (`new URL(url)`).
    let parsed = url::Url::parse(url).map_err(|_| ExternalUrlError::Unparseable)?;
    // 3. Scheme must be http/https.
    if !ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        return Err(ExternalUrlError::DisallowedScheme);
    }
    // 4. No embedded credentials.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ExternalUrlError::EmbeddedCredentials);
    }
    Ok(parsed.to_string())
}

/// True for the control range `external-url.ts` rejects: `/[\x00-\x1f\x7f]/`.
fn is_control_char(c: char) -> bool {
    let u = c as u32;
    u <= 0x1f || u == 0x7f
}

/// The `open_external_url` IPC command the injected shim invokes. Canonicalizes the
/// URL, then opens it in the system default browser via `tauri-plugin-opener`.
/// Returns the rejection reason as a string so the SPA's `.catch(...)`
/// (`open-url.ts:35-37`) receives a message. App-defined commands are not
/// permission-gated in Tauri v2; per-window capabilities scope WHO may call it.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let canonical = canonicalize_external_url(&url).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_url(canonical, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_http_and_https() {
        assert_eq!(
            canonicalize_external_url("https://example.com/path?q=1#frag").unwrap(),
            "https://example.com/path?q=1#frag"
        );
        // Authority-only URL canonicalizes with a trailing slash (like `new URL`).
        assert_eq!(
            canonicalize_external_url("http://example.com").unwrap(),
            "http://example.com/"
        );
    }

    #[test]
    fn rejects_non_http_schemes() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "ftp://example.com/x",
            "mailto:a@b.com",
        ] {
            assert_eq!(
                canonicalize_external_url(url),
                Err(ExternalUrlError::DisallowedScheme),
                "should reject scheme: {url}"
            );
        }
    }

    #[test]
    fn rejects_embedded_credentials() {
        assert_eq!(
            canonicalize_external_url("http://user:pass@example.com/"),
            Err(ExternalUrlError::EmbeddedCredentials)
        );
        assert_eq!(
            canonicalize_external_url("https://user@example.com/"),
            Err(ExternalUrlError::EmbeddedCredentials)
        );
    }

    #[test]
    fn rejects_control_characters() {
        // Embedded newline / tab / NUL / DEL are shell-dangerous.
        assert_eq!(
            canonicalize_external_url("https://example.com/\n"),
            Err(ExternalUrlError::ControlCharacter)
        );
        assert_eq!(
            canonicalize_external_url("https://example.com/\t"),
            Err(ExternalUrlError::ControlCharacter)
        );
        assert_eq!(
            canonicalize_external_url("https://exa\u{0000}mple.com/"),
            Err(ExternalUrlError::ControlCharacter)
        );
        assert_eq!(
            canonicalize_external_url("https://example.com/\u{007f}"),
            Err(ExternalUrlError::ControlCharacter)
        );
    }

    #[test]
    fn rejects_relative_or_garbage() {
        for url in ["/relative/path", "not a url", "example.com", ""] {
            assert_eq!(
                canonicalize_external_url(url),
                Err(ExternalUrlError::Unparseable),
                "should reject unparseable: {url:?}"
            );
        }
    }

    #[test]
    fn control_char_predicate_boundaries() {
        assert!(is_control_char('\u{0000}'));
        assert!(is_control_char('\u{001f}'));
        assert!(is_control_char('\u{007f}'));
        assert!(!is_control_char(' ')); // 0x20 is allowed
        assert!(!is_control_char('~')); // 0x7e is allowed
        assert!(!is_control_char('é')); // >0x7f is allowed (matches the JS regex)
    }
}
