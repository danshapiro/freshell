//! Name-reliability Task 6: what a failed Gemini request means for AI naming.
//!
//! Every failure falls in one class, and the class decides what the naming
//! worker does next:
//!
//! - [`GeminiFailureClass::Capability`]: the credential, the permission or the
//!   route is refused (a OneCLI gateway refusal, 401/403/407, Google's
//!   `API_KEY_INVALID`, an untrusted certificate, an unreachable proxy or
//!   host). Naming pauses; the attempt is refunded.
//! - [`GeminiFailureClass::Throttled`]: a quota answer (429). Naming pauses
//!   with a growing re-probe; the attempt is refunded.
//! - [`GeminiFailureClass::Transient`] / [`GeminiFailureClass::Invalid`]: the
//!   request failed in a way a retry may fix, or the provider answered
//!   something unusable. The attempt is consumed, as before.
//!
//! The classification reads only status codes, structured JSON error fields
//! and error TYPES (a `rustls` certificate error found by downcasting); it
//! never matches message text, and nothing here keeps request URLs, proxy
//! URLs, keys or response bodies: the provider code is a short sanitized
//! token, so a failure is always safe to log.

/// The class of one failed Gemini request (see the module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeminiFailureClass {
    Capability,
    Throttled,
    Transient,
    Invalid,
}

/// One classified Gemini failure: the class, the HTTP status when the
/// request got an answer, and a sanitized provider or transport code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeminiFailure {
    pub class: GeminiFailureClass,
    pub status: Option<u16>,
    pub provider_code: Option<String>,
}

impl GeminiFailure {
    fn new(class: GeminiFailureClass, status: Option<u16>, provider_code: Option<String>) -> Self {
        Self {
            class,
            status,
            provider_code,
        }
    }

    /// No credential route is available (no key and no OneCLI proxy).
    pub fn no_credential() -> Self {
        Self::new(
            GeminiFailureClass::Capability,
            None,
            Some("no_credential".to_string()),
        )
    }

    /// The request body could not be encoded (never expected in practice).
    pub fn request_encoding() -> Self {
        Self::new(
            GeminiFailureClass::Invalid,
            None,
            Some("request_encoding".to_string()),
        )
    }

    /// The naming worker's own 20-second request bound elapsed.
    pub fn request_timed_out() -> Self {
        Self::new(
            GeminiFailureClass::Transient,
            None,
            Some("timeout".to_string()),
        )
    }

    /// A 2xx answer whose body could not be read.
    pub fn response_read_failed(status: u16) -> Self {
        Self::new(
            GeminiFailureClass::Transient,
            Some(status),
            Some("response_read_failed".to_string()),
        )
    }

    /// A 2xx answer whose body is not the expected JSON.
    pub fn malformed_response(status: u16) -> Self {
        Self::new(
            GeminiFailureClass::Invalid,
            Some(status),
            Some("malformed_response".to_string()),
        )
    }

    /// Whether this failure pauses naming (and refunds the attempt).
    pub fn pauses_naming(&self) -> bool {
        matches!(
            self.class,
            GeminiFailureClass::Capability | GeminiFailureClass::Throttled
        )
    }

    /// The code logs carry: `throttled` for a quota answer, else the
    /// provider or transport code, else `http_<status>`.
    pub fn code(&self) -> String {
        if self.class == GeminiFailureClass::Throttled {
            return "throttled".to_string();
        }
        if let Some(code) = &self.provider_code {
            return code.clone();
        }
        match self.status {
            Some(status) => format!("http_{status}"),
            None => "request_failed".to_string(),
        }
    }
}

impl std::fmt::Display for GeminiFailure {
    /// The text the naming worker has always logged (`gemini http <status>`
    /// for an answer, `gemini request failed` otherwise), plus the code in
    /// parentheses when one is known. Never a URL, key or body.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => match reqwest::StatusCode::from_u16(status) {
                Ok(code) => write!(f, "gemini http {code}")?,
                Err(_) => write!(f, "gemini http {status}")?,
            },
            None => write!(f, "gemini request failed")?,
        }
        if self.provider_code.is_some() || self.class == GeminiFailureClass::Throttled {
            write!(f, " ({})", self.code())?;
        }
        Ok(())
    }
}

/// Classify a non-2xx Gemini answer from its status and body, in this order:
/// 429 is [`GeminiFailureClass::Throttled`] (a quota answer rewritten by the
/// OneCLI gateway must not pause for 15 minutes); any body whose top-level
/// `error` is a string (the OneCLI gateway's shape: `access_restricted`,
/// `credential_not_found`, `app_not_connected`, …) is
/// [`GeminiFailureClass::Capability`] with that code, checked before the
/// status rules because the gateway reports a bad key as 400; then Google's
/// `API_KEY_INVALID` and any 401/403/407 are Capability; 5xx and 408 are
/// [`GeminiFailureClass::Transient`]; anything else is
/// [`GeminiFailureClass::Invalid`].
pub fn classify_gemini_failure(status: u16, body: &[u8]) -> GeminiFailure {
    let value: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let error = value.as_ref().and_then(|value| value.get("error"));
    let onecli_code = error.and_then(serde_json::Value::as_str).map(sanitize_code);
    let google_status = error
        .and_then(|error| error.get("status"))
        .and_then(serde_json::Value::as_str)
        .map(sanitize_code);
    let api_key_invalid = error
        .and_then(|error| error.get("details"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|details| {
            details.iter().any(|detail| {
                detail.get("reason").and_then(serde_json::Value::as_str) == Some("API_KEY_INVALID")
            })
        });
    let status_code = Some(status);
    if status == 429 {
        return GeminiFailure::new(
            GeminiFailureClass::Throttled,
            status_code,
            onecli_code.or(google_status),
        );
    }
    if let Some(code) = onecli_code {
        return GeminiFailure::new(GeminiFailureClass::Capability, status_code, Some(code));
    }
    if api_key_invalid {
        return GeminiFailure::new(
            GeminiFailureClass::Capability,
            status_code,
            Some("API_KEY_INVALID".to_string()),
        );
    }
    let class = match status {
        401 | 403 | 407 => GeminiFailureClass::Capability,
        408 | 500..=599 => GeminiFailureClass::Transient,
        _ => GeminiFailureClass::Invalid,
    };
    GeminiFailure::new(class, status_code, google_status)
}

/// Classify a request that got no answer, from its error source chain: a
/// `rustls` certificate error anywhere in the chain (found by downcasting,
/// also inside `std::io::Error`, never by message text) is Capability
/// `proxy_tls` through a proxy and `tls_untrusted` otherwise; any other
/// connect failure is Capability `proxy_unreachable` through a proxy (a
/// refused CONNECT, a proxy that is down) and `direct_unreachable`
/// otherwise; a timeout and anything else are Transient.
pub fn classify_transport_error(
    chain: &(dyn std::error::Error + 'static),
    is_connect: bool,
    is_timeout: bool,
    via_proxy: bool,
) -> GeminiFailure {
    let (class, code) = if holds_invalid_certificate(chain) {
        (
            GeminiFailureClass::Capability,
            if via_proxy {
                "proxy_tls"
            } else {
                "tls_untrusted"
            },
        )
    } else if is_connect {
        (
            GeminiFailureClass::Capability,
            if via_proxy {
                "proxy_unreachable"
            } else {
                "direct_unreachable"
            },
        )
    } else if is_timeout {
        (GeminiFailureClass::Transient, "timeout")
    } else {
        (GeminiFailureClass::Transient, "request_failed")
    };
    GeminiFailure::new(class, None, Some(code.to_string()))
}

/// The deepest source chain the classifier walks (a cycle guard).
const MAX_CHAIN_DEPTH: usize = 32;

fn holds_invalid_certificate(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    for _ in 0..MAX_CHAIN_DEPTH {
        let Some(error) = current else {
            return false;
        };
        if matches!(
            error.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return true;
        }
        // `std::io::Error::source()` skips the error it wraps, so look
        // inside it explicitly.
        if let Some(inner) = error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            if holds_invalid_certificate(inner) {
                return true;
            }
        }
        current = error.source();
    }
    false
}

/// The longest provider code kept.
const MAX_CODE_LEN: usize = 64;

/// Keep a provider code only as a short token of `[A-Za-z0-9_.-]`; anything
/// else (free text, URLs) becomes `unrecognized`, so a code is always safe
/// to log.
fn sanitize_code(code: &str) -> String {
    let token = !code.is_empty()
        && code.len() <= MAX_CODE_LEN
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if token {
        code.to_string()
    } else {
        "unrecognized".to_string()
    }
}

/// [`classify_transport_error`] for a `reqwest` error.
pub fn classify_reqwest_error(error: &reqwest::Error, via_proxy: bool) -> GeminiFailure {
    classify_transport_error(error, error.is_connect(), error.is_timeout(), via_proxy)
}

#[cfg(test)]
#[path = "gemini_failure_tests.rs"]
mod tests;
