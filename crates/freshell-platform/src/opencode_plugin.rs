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

/// Native package entrypoints let a shared Main/TUI source select this
/// directory: the server loader skips it and the TUI loader selects ./tui.
pub fn rebind_plugin_package_path(home: &Path) -> PathBuf {
    home.join(".freshell/opencode")
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
        selected_tui_content(&raw, &plugin)?
    } else {
        tui_config_content(&plugin)
    };
    write_atomic_if_changed(&tui_json, &content)?;
    Ok(tui_json)
}

/// Append the owned plugin before reference spans are captured while retaining
/// the source's native text and declaring origin. Tokens remain unresolved.
pub fn selected_tui_content(raw: &str, plugin: &Path) -> std::io::Result<String> {
    selected_tui_content_bounded(raw, plugin, 16 * 1024 * 1024)
}

pub fn selected_tui_content_bounded(
    raw: &str,
    plugin: &Path,
    remaining: usize,
) -> std::io::Result<String> {
    if raw.len() > remaining.min(16 * 1024 * 1024) {
        return Err(std::io::Error::other(
            "OpenCode TUI source-view profile exceeded",
        ));
    }
    let config = crate::opencode_config::parse_jsonc_object(raw).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "OpenCode TUI config contains malformed JSONC or is not an object",
        )
    })?;
    let plugins = config.get("plugin");
    if plugins.is_some_and(|plugins| !plugins.is_array()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "OpenCode TUI plugin list is not an array",
        ));
    }
    let own = plugin_file_spec(plugin);
    if plugins
        .and_then(serde_json::Value::as_array)
        .is_some_and(|plugins| {
            plugins
                .iter()
                .any(|entry| entry.as_str() == Some(own.as_str()))
        })
    {
        return Ok(raw.into());
    }
    // Keep the native document's comments, escapes and replacement spans.
    // Only append one literal plugin entry to the effective top-level array.
    let (offset, separator) = plugin_insertion(raw, plugins.is_some())?;
    let own = serde_json::to_string(&own).map_err(std::io::Error::other)?;
    let addition = if plugins.is_some() {
        format!("{separator}{own}")
    } else {
        format!("{separator}\"plugin\":[{own}]")
    };
    if raw
        .len()
        .checked_add(addition.len())
        .is_none_or(|length| length > remaining.min(16 * 1024 * 1024))
    {
        return Err(std::io::Error::other(
            "OpenCode TUI source-view profile exceeded",
        ));
    }
    let mut content = String::with_capacity(raw.len() + addition.len());
    content.push_str(&raw[..offset]);
    content.push_str(&addition);
    content.push_str(&raw[offset..]);
    Ok(content)
}

/// Scan validated JSONC without allocating tokens or decoding values. The
/// last top-level plugin array is effective when a source repeats that key.
fn plugin_insertion(raw: &str, has_plugins: bool) -> std::io::Result<(usize, &'static str)> {
    let bytes = raw.as_bytes();
    let mut cursor = 0;
    let mut depth = 0usize;
    let mut previous = b' ';
    let mut plugin_key = false;
    let mut plugin_array = false;
    let mut insertion = None;
    while cursor < bytes.len() {
        let start = cursor;
        let token = bytes[cursor];
        cursor += 1;
        if token.is_ascii_whitespace() {
            continue;
        }
        if token == b'/' && bytes.get(cursor) == Some(&b'/') {
            while cursor < bytes.len() && !matches!(bytes[cursor], b'\n' | b'\r') {
                cursor += 1;
            }
            continue;
        }
        if token == b'/' && bytes.get(cursor) == Some(&b'*') {
            cursor += 1;
            while cursor + 1 < bytes.len() && &bytes[cursor..cursor + 2] != b"*/" {
                cursor += 1;
            }
            cursor += 2;
            continue;
        }
        if token == b'"' {
            while cursor < bytes.len() {
                let byte = bytes[cursor];
                cursor += 1;
                if byte == b'\\' {
                    cursor += 1;
                } else if byte == b'"' {
                    break;
                }
            }
            if depth == 1 && matches!(previous, b'{' | b',') {
                plugin_key = serde_json::from_str::<String>(&raw[start..cursor])
                    .is_ok_and(|key| key == "plugin");
            }
        } else {
            match token {
                b'[' | b'{' => {
                    if depth == 1 && previous == b':' {
                        plugin_array = plugin_key && token == b'[';
                    }
                    depth += 1;
                }
                b']' | b'}' => {
                    if depth == 2 && plugin_array && token == b']' {
                        insertion = Some((
                            start,
                            if matches!(previous, b'[' | b',') {
                                ""
                            } else {
                                ","
                            },
                        ));
                        plugin_array = false;
                    }
                    if depth == 1 && !has_plugins {
                        insertion = Some((
                            start,
                            if matches!(previous, b'{' | b',') {
                                ""
                            } else {
                                ","
                            },
                        ));
                    }
                    depth -= 1;
                }
                _ => {}
            }
        }
        previous = token;
    }
    insertion.ok_or_else(|| std::io::Error::other("OpenCode TUI plugin array is unavailable"))
}

/// Install only the implementation when the controller already prepared the
/// selected TUI source. Re-parsing that source here would change recipe spans.
pub fn ensure_rebind_plugin_source(home: &Path) -> std::io::Result<()> {
    write_atomic_if_changed(&rebind_plugin_path(home), REBIND_PLUGIN_SOURCE)?;
    write_atomic_if_changed(
        &rebind_plugin_package_path(home).join("package.json"),
        r#"{"exports":{"./tui":"./freshell-rebind-plugin.ts"}}"#,
    )
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
        let effective = crate::opencode_config::parse_jsonc_object(
            &std::fs::read_to_string(generated).unwrap(),
        )
        .unwrap();
        assert_eq!(effective["theme"], "dark");
        assert_eq!(effective["plugin"].as_array().unwrap().len(), 2);
        assert_eq!(effective["plugin"][0], "file:///user.ts");
        assert_eq!(std::fs::read_to_string(selected).unwrap(), raw);
    }

    #[test]
    fn shared_tui_edit_preserves_native_file_and_auth_lexemes() {
        let raw = "{\n // native comment {file:./missing}\n\"agent\":{\"probe\":{\"prompt\":\"{env:AUTH}\",\"description\":\"\\u007bfile:./literal\\u007d\"}},\"plugin\":[[\"./probe.mjs\",{\"key\":\"{file:./rule}\"}], /* tail */], }";
        let content = selected_tui_content(raw, Path::new("/owned/rebind.ts")).unwrap();
        assert!(
            content.contains("// native comment {file:./missing}"),
            "normalizing a shared source changes the native comment-prefix file exclusion"
        );
        assert!(content.contains("\\u007bfile:./literal\\u007d"),
            "native replacement happens before JSONC decoding, so raw escape spellings must survive");
        assert!(content.contains("\"prompt\":\"{env:AUTH}\""));
        let mut selected = Vec::new();
        crate::opencode_config::transform_file_tokens(
            &content,
            &|name| (name == "AUTH").then(|| "{file:./auth-rule}".into()),
            |token| {
                selected.push(token.path.to_string());
                Ok::<_, ()>(format!("{{file:{}}}", token.path))
            },
        )
        .unwrap();
        assert_eq!(
            selected,
            ["./auth-rule", "./rule"],
            "native replacement must not select comment-prefixed or escaped file-looking strings"
        );
        let config = crate::opencode_config::parse_jsonc_object(&content).unwrap();
        assert_eq!(config["plugin"].as_array().unwrap().len(), 2);
        assert_eq!(config["plugin"][0][0], "./probe.mjs");
    }

    #[test]
    fn tui_plugin_insertion_handles_native_arrays_comments_and_effective_duplicate_keys() {
        for raw in [
            "{}",
            "{\"theme\":\"dark\", /* tail */}",
            "{\"plugin\":[]}",
            "{\"plugin\":[\"file:///user.ts\", /* tail */]}",
            "{\"plugin\":[[\"file:///user.ts\",{\"nested\":[1,2],\"text\":\"]}\\\"\"}]]}",
            "{\"plugin\":[\"discarded\"],\"pl\\u0075gin\":[],\"nested\":{\"plugin\":[\"unrelated\"]}}",
        ] {
            let before = crate::opencode_config::parse_jsonc_object(raw).unwrap();
            let plugin = Path::new("/owned/rebind");
            let content = selected_tui_content(raw, plugin).unwrap();
            let after = crate::opencode_config::parse_jsonc_object(&content).unwrap();
            let before_plugins = before.get("plugin").and_then(serde_json::Value::as_array);
            let after_plugins = after["plugin"].as_array().unwrap();
            assert_eq!(after_plugins.len(), before_plugins.map_or(0, Vec::len) + 1);
            if let Some(before_plugins) = before_plugins {
                assert_eq!(&after_plugins[..before_plugins.len()], before_plugins);
            }
            assert_eq!(after_plugins.last().unwrap(), "file:///owned/rebind");
            for (key, value) in before.as_object().unwrap() {
                if key != "plugin" { assert_eq!(&after[key], value); }
            }
            assert_eq!(selected_tui_content(&content, plugin).unwrap(), content);
            assert!(selected_tui_content_bounded(raw, plugin, content.len() - 1).is_err());
            assert_eq!(selected_tui_content_bounded(raw, plugin, content.len()).unwrap(), content);
        }
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
