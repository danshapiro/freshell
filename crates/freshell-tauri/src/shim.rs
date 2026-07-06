//! The 2-property frontend shim — the Rust analog of `electron/preload.ts`, but
//! reduced to exactly what the retained SPA touches.
//!
//! **Confirmed by grep across `src/` (electron-tauri.md §7):** the SPA reads
//! `window.freshellDesktop` in only TWO places, both read-only:
//!   1. `src/hooks/useElectronExternalLinks.ts:17-18` — reads `.isElectron`.
//!   2. `src/lib/open-url.ts:6,34-38` — calls `.openExternal(url)` (and `.catch`es
//!      the returned promise).
//!
//! So the whole Electron `contextBridge` surface (`preload.ts:52-71`) collapses to:
//! ```js
//! window.freshellDesktop = { isElectron: true, openExternal: (url) => invoke('open_external_url', { url }) }
//! ```
//! injected as a Tauri **initialization script** (runs before page scripts on every
//! load — the preload equivalent). The SPA stays byte-for-byte unchanged
//! (`architecture-spec.md:320-330`). The window loads the same `?token=` URL form
//! so the SPA's existing `URLSearchParams` auth path is unchanged (`startup.ts:155`).

/// The initialization script injected into the main webview. It defines
/// `window.freshellDesktop` with the two properties the SPA uses:
///   * `isElectron: true` — the desktop-shell flag (`useElectronExternalLinks`
///     gates ctrl/shift-click interception on it; we ARE a desktop shell → true).
///   * `openExternal(url)` — routes to the app-local `open_external_url` command via
///     Tauri IPC, returning a Promise (so `open-url.ts`'s `.catch(...)` is valid).
///
/// `openExternal` resolves the invoke lazily at CALL time (not definition time), so
/// it is robust to init-script ordering relative to Tauri's own IPC bootstrap. It
/// prefers the public global (`__TAURI__.core.invoke`, enabled via
/// `withGlobalTauri`) and falls back to `__TAURI_INTERNALS__.invoke`.
pub const DESKTOP_SHIM_SCRIPT: &str = r#"(function () {
  function invokeOpenExternal(url) {
    try {
      var invoke =
        (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
        (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
      if (typeof invoke === 'function') {
        return Promise.resolve(invoke('open_external_url', { url: url }));
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.reject(new Error('freshellDesktop.openExternal: Tauri IPC unavailable'));
  }
  window.freshellDesktop = {
    isElectron: true,
    openExternal: function (url) {
      return invokeOpenExternal(url);
    }
  };
})();"#;

/// The init script (indirection kept so callers read intent, not a const).
pub fn desktop_shim_script() -> &'static str {
    DESKTOP_SHIM_SCRIPT
}

/// The IPC command name the shim's `openExternal` invokes (single source of truth
/// shared with the `#[tauri::command]` registration + capability docs).
pub const OPEN_EXTERNAL_COMMAND: &str = "open_external_url";

/// Build the webview load URL for app-bound mode: `http://<host>:<port>/?token=<enc>`.
/// The token is percent-encoded exactly like the reference's
/// `encodeURIComponent(authToken)` (`startup.ts:152-155`) so a token containing
/// `+ & # /` or whitespace round-trips through the SPA's `URLSearchParams`.
pub fn build_load_url(host: &str, port: u16, token: &str) -> String {
    format!(
        "http://{host}:{port}/?token={}",
        encode_uri_component(token)
    )
}

/// Percent-encode a string with the exact character set of JavaScript's
/// `encodeURIComponent`: every byte is escaped EXCEPT the unreserved set
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. Operates on UTF-8 bytes (matching JS, which
/// encodes the UTF-8 encoding of each code point).
pub fn encode_uri_component(input: &str) -> String {
    const UNRESERVED: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        if UNRESERVED.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(hex_upper(byte >> 4));
            out.push(hex_upper(byte & 0x0f));
        }
    }
    out
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_exposes_exactly_the_two_touchpoints() {
        let script = desktop_shim_script();
        // Touchpoint 1: useElectronExternalLinks reads `.isElectron` (must be true).
        assert!(script.contains("isElectron"));
        assert!(script.contains("isElectron: true"));
        // Touchpoint 2: open-url.ts calls `.openExternal(url)`.
        assert!(script.contains("openExternal"));
        // It routes through the app command.
        assert!(script.contains("open_external_url"));
        assert!(script.contains(OPEN_EXTERNAL_COMMAND));
        // Assigns onto the exact global the SPA reads.
        assert!(script.contains("window.freshellDesktop"));
        // Uses Tauri IPC (public + internal fallback).
        assert!(script.contains("__TAURI__"));
        assert!(script.contains("__TAURI_INTERNALS__"));
    }

    #[test]
    fn shim_openexternal_returns_a_promise() {
        // open-url.ts does `desktop.openExternal(absoluteUrl).catch(...)`, so the
        // returned value must be a thenable in every branch.
        let script = desktop_shim_script();
        assert!(script.contains("Promise.resolve"));
        assert!(script.contains("Promise.reject"));
    }

    #[test]
    fn load_url_has_token_query_and_loopback_host() {
        let url = build_load_url("127.0.0.1", 51873, "plainhextoken0123");
        assert_eq!(url, "http://127.0.0.1:51873/?token=plainhextoken0123");
    }

    #[test]
    fn load_url_percent_encodes_special_token() {
        // A token with reserved chars must be encoded so URLSearchParams round-trips
        // it (the exact failure `startup.ts:152-154` warns about).
        let url = build_load_url("127.0.0.1", 3001, "a b+c&d#e/f");
        assert_eq!(url, "http://127.0.0.1:3001/?token=a%20b%2Bc%26d%23e%2Ff");
    }

    #[test]
    fn encode_uri_component_matches_js_semantics() {
        assert_eq!(encode_uri_component("abcXYZ019"), "abcXYZ019");
        // Unreserved marks pass through unescaped.
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        // Reserved / delimiters get escaped, uppercase hex.
        assert_eq!(encode_uri_component(" "), "%20");
        assert_eq!(encode_uri_component("+"), "%2B");
        assert_eq!(encode_uri_component("&"), "%26");
        assert_eq!(encode_uri_component("#"), "%23");
        assert_eq!(encode_uri_component("/"), "%2F");
        assert_eq!(encode_uri_component("="), "%3D");
        assert_eq!(encode_uri_component("?"), "%3F");
    }

    #[test]
    fn encode_uri_component_encodes_utf8_bytes() {
        // é = U+00E9 = UTF-8 0xC3 0xA9 (matches encodeURIComponent('é') === '%C3%A9').
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }
}
