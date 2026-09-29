//! Freshell's opencode TUI rebind plugin: embedded source and idempotent
//! install of TWO freshell-owned files into ~/.freshell/opencode/ — the
//! plugin itself and a generated tui.json pointing at it. When the user has
//! selected a TUI config, its settings and plugins are copied into that
//! generated file before the rebind plugin is appended.

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The TUI plugin shipped with freshell (single source of truth lives in the
/// repo at extensions/opencode/freshell-rebind-plugin.ts; embedded at compile
/// time so the Rust server needs no runtime lookup).
pub const REBIND_PLUGIN_SOURCE: &str =
    include_str!("../../../extensions/opencode/freshell-rebind-plugin.ts");

pub fn rebind_plugin_path(home: &Path) -> PathBuf {
    home.join(".freshell")
        .join("opencode")
        .join("freshell-rebind-plugin.ts")
}

/// The freshell-owned TUI config injected per-pane via OPENCODE_TUI_CONFIG.
/// Lives under ~/.freshell/opencode/ — deliberately NOT an ancestor of any
/// pane cwd (opencode's project tui.json discovery walks up to `/`).
pub fn tui_config_path(home: &Path) -> PathBuf {
    home.join(".freshell").join("opencode").join("tui.json")
}

/// File-URL *path* percent-encode set: byte-parity with `pathToFileURL` as
/// implemented by Node v22 AND Bun (opencode's runtime) -- oracle-verified
/// 2026-07-29 by differential sweep on the installed Bun 1.3.14 / Node
/// v22.21.1. STRICTER than the WHATWG-minimal path set: C0 controls + DEL
/// (both in `CONTROLS`), space, `"` `#` `<` `>` `?` backtick `[` `\` `]`
/// `^` `{` `|` `}` `~`, plus `%` itself so pre-existing escapes round-trip
/// literally. `/` separators and the Windows drive `:` stay bare; non-ASCII
/// bytes are always UTF-8 percent-encoded by `utf8_percent_encode`.
const FILE_URL_PATH_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}')
    .add(b'~');

/// `file://` spec for the tui.json `plugin` array. Unix: `file:///abs`.
/// Windows drive paths get forward slashes and a third slash. The path is
/// percent-encoded to `pathToFileURL` parity (Node v22 == Bun, opencode's
/// runtime): opencode dedupes plugin origins by exact file-URL string and
/// Bun's `import()` hard-fails (silently, for the pane lifetime) on raw
/// `#`/`?`/`%`, so byte-identical output is load-bearing.
pub fn plugin_file_spec(plugin_path: &Path) -> String {
    let raw = plugin_path.display().to_string();
    if raw.starts_with('/') {
        // Posix absolute path: `\` is an ordinary filename byte here --
        // percent-encoded (%5C, pathToFileURL parity), never a separator.
        format!("file://{}", utf8_percent_encode(&raw, FILE_URL_PATH_SET))
    } else {
        // Windows drive path: separators become `/`, third slash added.
        let s = raw.replace('\\', "/");
        format!("file:///{}", utf8_percent_encode(&s, FILE_URL_PATH_SET))
    }
}

/// Exactly `{"plugin":[<spec>]}` — the plugin key and NOTHING else. TUI
/// config sources MERGE and plugin arrays UNION (dedup by file URL), so
/// this single-key file can never shadow the user's global/project
/// tui.json (validated on opencode 1.18.8/1.18.9, report V7). Load-bearing:
/// never add another key (pinned by unit test).
pub fn tui_config_content(plugin_path: &Path) -> String {
    serde_json::json!({ "plugin": [plugin_file_spec(plugin_path)] }).to_string()
}

fn write_atomic_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Idempotently materialize BOTH freshell-owned files into
/// `~/.freshell/opencode/`: the plugin source and generated tui.json.
/// Atomic (tmp + rename); rewrites only when content
/// differs, so a running opencode never observes a torn file. Returns the
/// tui.json path — the value cli_launch.rs injects as OPENCODE_TUI_CONFIG.
/// Bun caches failed imports for the process lifetime, so this MUST run
/// (and succeed) before the TUI launches.
pub fn ensure_rebind_plugin_installed(home: &Path) -> std::io::Result<PathBuf> {
    ensure_rebind_plugin_with_user_config(home, None)
}

/// Materialize a TUI selector that includes Freshell's plugin and every key
/// from the user's selected TUI config. The user file remains byte-for-byte
/// unchanged; only the file under `.freshell/opencode` is regenerated.
pub fn ensure_rebind_plugin_with_user_config(
    home: &Path,
    selected: Option<&Path>,
) -> std::io::Result<PathBuf> {
    let plugin = rebind_plugin_path(home);
    write_atomic_if_changed(&plugin, REBIND_PLUGIN_SOURCE)?;
    let tui_json = tui_config_path(home);
    let content = if let Some(selected) = selected {
        let raw = std::fs::read_to_string(selected)?;
        let mut config = crate::opencode_config::parse_jsonc_object(&raw).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "OpenCode TUI config contains malformed JSONC or is not an object",
            )
        })?;
        let plugins = config
            .as_object_mut()
            .expect("validated object")
            .entry("plugin")
            .or_insert_with(|| serde_json::json!([]));
        let Some(plugins) = plugins.as_array_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "OpenCode TUI plugin list is not an array",
            ));
        };
        let own = plugin_file_spec(&plugin);
        if !plugins
            .iter()
            .any(|entry| entry.as_str() == Some(own.as_str()))
        {
            plugins.push(serde_json::Value::String(own));
        }
        config.to_string()
    } else {
        tui_config_content(&plugin)
    };
    write_atomic_if_changed(&tui_json, &content)?;
    Ok(tui_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn plugin_source_is_embedded_and_nonempty() {
        assert!(REBIND_PLUGIN_SOURCE.contains("freshell-rebind"));
        assert!(REBIND_PLUGIN_SOURCE.contains("session-signals"));
    }

    #[test]
    fn install_writes_both_files_idempotently_and_heals_content_drift() {
        let home = tempfile::tempdir().unwrap();
        let tui_json = ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(tui_json, tui_config_path(home.path()));
        let plugin = rebind_plugin_path(home.path());
        assert_eq!(
            std::fs::read_to_string(&plugin).unwrap(),
            REBIND_PLUGIN_SOURCE
        );
        assert_eq!(
            std::fs::read_to_string(&tui_json).unwrap(),
            tui_config_content(&plugin)
        );
        // Second call: no error, same content.
        ensure_rebind_plugin_installed(home.path()).unwrap();
        // Drifted content is healed (both files).
        std::fs::write(&plugin, "tampered").unwrap();
        std::fs::write(&tui_json, "tampered").unwrap();
        ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&plugin).unwrap(),
            REBIND_PLUGIN_SOURCE
        );
        assert_eq!(
            std::fs::read_to_string(&tui_json).unwrap(),
            tui_config_content(&plugin)
        );
    }

    #[test]
    fn tui_config_content_is_exactly_the_plugin_key_and_nothing_else() {
        let content = tui_config_content(Path::new("/h/.freshell/opencode/p.ts"));
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        // ONLY the plugin key — TUI config sources MERGE (scalar keys:
        // later-order source wins) and plugin arrays UNION, so a plugin-only
        // file can never shadow the user's own tui.json (plan Scope
        // Decision 5 / validation report V7). This pin is load-bearing:
        // never add another key.
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        assert_eq!(
            v["plugin"],
            serde_json::json!(["file:///h/.freshell/opencode/p.ts"])
        );
    }

    #[test]
    fn file_spec_is_a_canonical_file_url() {
        // Expected values match `pathToFileURL(p).href` under BOTH Node v22
        // and Bun 1.3.14 (opencode's runtime; oracle-verified 2026-07-29) --
        // the form Bun imports and opencode dedupes plugin origins by.
        let cases: &[(&str, &str)] = &[
            ("/a/b/p.ts", "file:///a/b/p.ts"),
            ("/a/b c/p.ts", "file:///a/b%20c/p.ts"),
            ("/a/b#c/p.ts", "file:///a/b%23c/p.ts"),
            ("/a/b?c/p.ts", "file:///a/b%3Fc/p.ts"),
            ("/a/b%41c/p.ts", "file:///a/b%2541c/p.ts"),
            ("/a/100%/p.ts", "file:///a/100%25/p.ts"),
            (
                "/home/\u{fc}n\u{ef}/p.ts",
                "file:///home/%C3%BCn%C3%AF/p.ts",
            ),
            // pathToFileURL is stricter than the WHATWG-minimal path set:
            ("/a/x~y/p.ts", "file:///a/x%7Ey/p.ts"),
            ("/a/[b]/p.ts", "file:///a/%5Bb%5D/p.ts"),
            ("/a/b^c/p.ts", "file:///a/b%5Ec/p.ts"),
            ("/a/b|c/p.ts", "file:///a/b%7Cc/p.ts"),
            // posix backslash is an ordinary byte -- encoded, not a separator:
            (r"/a/b\c/p.ts", "file:///a/b%5Cc/p.ts"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                &plugin_file_spec(Path::new(input)),
                expected,
                "input: {input}"
            );
        }
        // Windows drive path: forward slashes, third slash, ':' NOT escaped.
        assert_eq!(
            plugin_file_spec(Path::new(r"C:\Users\dev\p.ts")),
            "file:///C:/Users/dev/p.ts"
        );
    }

    #[test]
    fn selected_user_tui_config_and_rebind_plugin_are_both_loaded() {
        let home = tempfile::tempdir().unwrap();
        let selected = home.path().join("selected-tui.jsonc");
        let raw = "{ // keep the source\n \"theme\":\"dark\",\"plugin\":[\"file:///user.ts\",], }";
        std::fs::write(&selected, raw).unwrap();
        let generated =
            ensure_rebind_plugin_with_user_config(home.path(), Some(&selected)).unwrap();
        let effective: serde_json::Value =
            serde_json::from_slice(&std::fs::read(generated).unwrap()).unwrap();
        assert_eq!(effective["theme"], "dark");
        assert_eq!(effective["plugin"].as_array().unwrap().len(), 2);
        assert_eq!(effective["plugin"][0], "file:///user.ts");
        assert_eq!(std::fs::read_to_string(selected).unwrap(), raw);
    }

    #[test]
    fn malformed_selected_tui_config_is_refused_without_editing_source() {
        let home = tempfile::tempdir().unwrap();
        let selected = home.path().join("selected-tui.jsonc");
        let raw = "{\"plugin\":[\"fixture-secret\",}";
        std::fs::write(&selected, raw).unwrap();
        let error =
            ensure_rebind_plugin_with_user_config(home.path(), Some(&selected)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(!error.to_string().contains("fixture-secret"));
        assert_eq!(std::fs::read_to_string(selected).unwrap(), raw);
        assert!(!tui_config_path(home.path()).exists());
    }
}
