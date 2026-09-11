//! Extension registry + coding-CLI availability detection (Follow-up 3.19;
//! STRICT schema port: df1 EXT-01).
//!
//! **FAITHFUL-PORT + unit-proven, NOT differential-oracle-proven.** There is no
//! captured original transcript for these boot reads; correctness is argued by a
//! faithful port with file:line citations, a response-SHAPE match to the frozen
//! client contract, and the unit tests below (+ curl smokes in the report).
//! (The manifest schema itself IS differential-oracle-proven — see below.)
//!
//! Ports, additively (no `server/` or `shared/` source touched):
//! * `server/extension-manager.ts` `scan()` (62-131) and `toClientRegistry()`
//!   (144-191) — discover `freshell.json` manifests under the extension dirs and
//!   serialize the client registry the SPA fetches at `GET /api/extensions`
//!   (`src/hooks/useEnsureExtensionsRegistry.ts`).
//! * `server/extension-manifest.ts` — the manifest schema. Since EXT-01 the
//!   FULL STRICT schema (strict unknown-key rejection, category↔block refine,
//!   defaults, JS-safe-int timeouts, per-field capability validation) lives in
//!   the `freshell-extensions` crate, pinned by a generated differential
//!   oracle against the unmodified legacy zod schema
//!   (`crates/freshell-extensions/fixtures/manifest-oracle.json`). This module
//!   consumes it; the old lenient subset is gone.
//! * `server/platform.ts` `detectAvailableClis()` (107-118),
//!   `DEFAULT_CLI_DETECTION_SPECS` (97-103), `isCommandAvailable()` (84-91) — run
//!   `which`/`where.exe` per CLI (env-var override) to populate the
//!   `availableClis: Record<name,bool>` the PanePicker filters on
//!   (`src/components/panes/PanePicker.tsx:117`).
//! * `server/index.ts` (232-264) — build the CLI detection specs from the CLI
//!   extensions; extension names map 1:1 to the default set
//!   (claude/codex/opencode/gemini/kimi).
//! * `shared/extension-types.ts` `ClientExtensionEntry` (22-45) — the exact client
//!   registry entry shape.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use freshell_extensions::{parse_manifest, Category, ExtensionManifest, ManifestError};
use freshell_platform::detect::{host_os_live, is_windows, HostOs};
use freshell_platform::{CommandRunner, StdCommandRunner};
use serde_json::{json, Map, Value};

const MANIFEST_FILE: &str = "freshell.json";

// ── Manifest schema ─────────────────────────────────────────────────────────
//
// The strict schema now lives in the `freshell-extensions` crate (df1 EXT-01):
// `freshell_extensions::ExtensionManifest` is obtainable ONLY through
// validation (`parse_manifest`), so the lenient/strict split is structurally
// impossible here. Validation failures map to the legacy scan warnings:
// `ManifestError::InvalidJson` → 'invalid JSON in manifest';
// `ManifestError::Invalid(issues)` → 'invalid manifest' (issues are zod-parity
// (code, path, message) triples — see the crate docs).

// ── Registry ─────────────────────────────────────────────────────────────────

/// One discovered extension (`ExtensionRegistryEntry` — `extension-manager.ts:25-29`,
/// minus the server-process handle, which this read-only port never spawns).
#[derive(Debug, Clone)]
struct RegistryEntry {
    manifest: ExtensionManifest,
}

/// A CLI availability-detection spec (`CliDetectionSpec` — `platform.ts:95`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliDetectionSpec {
    pub name: String,
    /// The env var that overrides the command (empty in the manifest → `None`).
    pub env_var: Option<String>,
    pub default_cmd: String,
}

/// The in-memory extension registry (`extension-manager.ts` `registry`).
#[derive(Debug, Clone, Default)]
pub struct ExtensionRegistry {
    entries: Vec<RegistryEntry>,
}

impl ExtensionRegistry {
    /// `scan(dirs)` (`extension-manager.ts:62-131`): for each dir, read `freshell.json`
    /// from each subdirectory, parse it, and register under `manifest.name`
    /// (first-wins on duplicate). Invalid/missing manifests are skipped WITH A
    /// WARNING (`extension-manager.ts:90-111`) — the two failure classes map to
    /// legacy's two log lines ('invalid JSON in manifest' / 'invalid manifest',
    /// the latter carrying the zod-parity issue list).
    ///
    /// **Determinism note:** the original iterates `fs.readdirSync` order (which is
    /// filesystem-dependent, i.e. nondeterministic); this port sorts subdirectory
    /// names so the client-registry array is stable across boots (the picker
    /// re-groups anyway, so this cannot change what the user sees).
    pub fn scan(dirs: &[PathBuf]) -> Self {
        let mut entries: Vec<RegistryEntry> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();

        for dir in dirs {
            let Ok(read) = std::fs::read_dir(dir) else {
                continue;
            };
            let mut sub_names: Vec<String> = read
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_type()
                        .map(|t| t.is_dir() || t.is_symlink())
                        .unwrap_or(false)
                })
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            sub_names.sort();

            for name in sub_names {
                let manifest_path = dir.join(&name).join(MANIFEST_FILE);
                let Ok(bytes) = std::fs::read(&manifest_path) else {
                    continue;
                };
                // Legacy `fs.readFileSync(path, 'utf-8')` replaces invalid
                // UTF-8 with U+FFFD rather than throwing; match that exactly so
                // corrupted manifests land on the same warn/skip path (and
                // U+FFFD inside a string literal parses identically both ways).
                let raw = String::from_utf8_lossy(&bytes);
                let manifest = match parse_manifest(&raw) {
                    Ok(manifest) => manifest,
                    Err(ManifestError::InvalidJson(err)) => {
                        // `extension-manager.ts:100` — 'invalid JSON in manifest'
                        tracing::warn!(
                            manifest_path = %manifest_path.display(),
                            error = %err,
                            "Extension scan: invalid JSON in manifest"
                        );
                        continue;
                    }
                    Err(ManifestError::Invalid(issues)) => {
                        // `extension-manager.ts:106-109` — 'invalid manifest' with
                        // the issue list (legacy: `result.error.format()`; here:
                        // the same (code, path, message) content, flat).
                        tracing::warn!(
                            manifest_path = %manifest_path.display(),
                            ?issues,
                            "Extension scan: invalid manifest"
                        );
                        continue;
                    }
                };
                if seen.contains(&manifest.name) {
                    continue; // duplicate name — first wins
                }
                seen.insert(manifest.name.clone());
                entries.push(RegistryEntry { manifest });
            }
        }

        ExtensionRegistry { entries }
    }

    /// `toClientRegistry()` (`extension-manager.ts:144-191`): serialize the registry
    /// to the `ClientExtensionEntry[]` shape the SPA fetches at `GET /api/extensions`.
    pub fn to_client_registry(&self) -> Vec<Value> {
        self.entries
            .iter()
            .map(|entry| client_entry(&entry.manifest))
            .collect()
    }

    /// The names of GENUINELY discovered CLI extension manifests -- NO
    /// `DEFAULT_CLI_DETECTION_SPECS` fallback (the JS default-parameter set in
    /// `server/platform.ts:97-103`; the Rust mirror was deleted as dead code). This is the source for
    /// `codingCli.knownProviders` (settings tree): the original seeds
    /// `knownProviders` strictly from discovered extension manifests
    /// (`server/index.ts:276-294`), genuinely empty when none are found --
    /// unlike `availableClis` detection, which DOES fall back to a built-in
    /// CLI set for probing. Conflating the two made the port's `knownProviders`
    /// non-empty in environments where the original's is empty (verified: T0
    /// handshake `settings.updated` diverged on this before the fix).
    pub fn discovered_cli_names(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|e| e.manifest.category == Category::Cli && e.manifest.cli.is_some())
            .map(|e| e.manifest.name.clone())
            .collect()
    }

    /// Build CLI detection specs from the CLI extensions (`server/index.ts:257-264`).
    /// GENUINELY EMPTY when no CLI extension is discovered: the original always
    /// passes its extension-derived `cliDetectionSpecs` array to
    /// `detectAvailableClis(cliDetectionSpecs)` (`server/index.ts`), so
    /// `DEFAULT_CLI_DETECTION_SPECS` — a JS *default parameter* that only applies
    /// when the argument is omitted entirely — never kicks in there. A previous
    /// fallback here made `availableClis` a 5-key map when the process cwd had no
    /// `extensions/` dir, where the live original serves `availableClis: {}`
    /// (pinned by a cwd-neutral two-server differential, 2026-07-12).
    /// Build the full coding-CLI command specs from the CLI extensions —
    /// `server/index.ts:231-255` (`compileArgTemplate` + `registerCodingCliCommands`),
    /// per `port/machine/specs/cli-argv-fidelity.md` §3.1. Like the reference's
    /// `registerCodingCliCommands(cliCommandsMap)`, the result is GENUINELY EMPTY
    /// when no CLI extension is discovered (the `FALLBACK_CODING_CLI_COMMAND_SPECS`
    /// seed at `terminal-registry.ts:128-130` is REPLACED on boot, not merged).
    /// Template substitution semantics (replaceAll vs first-occurrence resume)
    /// are applied at resolve time by `freshell_platform::cli_launch`; the
    /// templates ride through verbatim here.
    pub fn cli_command_specs(&self) -> Vec<freshell_platform::CliCommandSpec> {
        self.entries
            .iter()
            .filter(|e| e.manifest.category == Category::Cli)
            .filter_map(|e| e.manifest.cli.as_ref().map(|cli| (e, cli)))
            .map(|(e, cli)| freshell_platform::CliCommandSpec {
                name: e.manifest.name.clone(),
                label: e.manifest.label.clone(),
                // `envVar: cli.envVar || ''` then `spec.envVar && env[...]`:
                // empty is falsy, so model it as `None`.
                env_var: cli.env_var.clone().filter(|v| !v.is_empty()),
                default_cmd: cli.command.clone(),
                base_args: cli.args.clone(),
                base_env: cli
                    .env
                    .clone()
                    .map(|m| m.into_iter().collect())
                    .unwrap_or_default(),
                resume_args: cli.resume_args.clone(),
                create_session_args: cli.create_session_args.clone(),
                model_args: cli.model_args.clone(),
                effort_args: cli.effort_args.clone(),
                sandbox_args: cli.sandbox_args.clone(),
                permission_mode_args: cli.permission_mode_args.clone(),
            })
            .collect()
    }

    pub fn cli_detection_specs(&self) -> Vec<CliDetectionSpec> {
        self.entries
            .iter()
            .filter(|e| e.manifest.category == Category::Cli)
            .filter_map(|e| e.manifest.cli.as_ref().map(|cli| (e, cli)))
            .map(|(e, cli)| CliDetectionSpec {
                name: e.manifest.name.clone(),
                // Empty envVar in the manifest means "no override" (`|| ''` → falsy).
                env_var: cli.env_var.clone().filter(|v| !v.is_empty()),
                default_cmd: cli.command.clone(),
            })
            .collect()
    }
}

/// Build one `ClientExtensionEntry` (`extension-manager.ts:145-190`). Optional
/// fields are omitted when absent, matching `JSON.stringify`'s `undefined` elision.
fn client_entry(m: &ExtensionManifest) -> Value {
    let mut obj = Map::new();
    obj.insert("name".into(), json!(m.name));
    obj.insert("version".into(), json!(m.version));
    obj.insert("label".into(), json!(m.label));
    obj.insert("description".into(), json!(m.description));
    obj.insert("category".into(), json!(m.category.as_str()));
    // `serverRunning` is always present; this read-only port never runs server
    // extensions, so it is always false (and `serverPort` is omitted).
    obj.insert("serverRunning".into(), json!(false));

    // Legacy gates on TRUTHINESS (`if (manifest.icon)`): an empty-string icon
    // is schema-valid but must not produce an iconUrl.
    if m.icon.as_ref().is_some_and(|icon| !icon.is_empty()) {
        obj.insert(
            "iconUrl".into(),
            json!(format!(
                "/api/extensions/{}/icon",
                encode_uri_component(&m.name)
            )),
        );
    }
    if let Some(url) = &m.url {
        obj.insert("url".into(), json!(url));
    }
    if let Some(cs) = &m.content_schema {
        // Typed content schema re-serializes exactly (validated input keys
        // only, optionals elided, insertion order preserved).
        obj.insert(
            "contentSchema".into(),
            serde_json::to_value(cs).unwrap_or(Value::Null),
        );
    }
    if let Some(p) = &m.picker {
        obj.insert(
            "picker".into(),
            serde_json::to_value(p).unwrap_or(Value::Null),
        );
    }
    if m.category == Category::Cli {
        if let Some(cli) = &m.cli {
            let mut c = Map::new();
            if let Some(v) = cli.supports_permission_mode {
                c.insert("supportsPermissionMode".into(), json!(v));
            }
            if let Some(v) = cli.supports_model {
                c.insert("supportsModel".into(), json!(v));
            }
            if let Some(v) = cli.supports_effort {
                c.insert("supportsEffort".into(), json!(v));
            }
            if let Some(v) = cli.supports_sandbox {
                c.insert("supportsSandbox".into(), json!(v));
            }
            c.insert("supportsResume".into(), json!(cli.resume_args.is_some()));
            if let Some(ra) = &cli.resume_args {
                let mut tpl = vec![cli.command.clone()];
                tpl.extend(ra.clone());
                c.insert("resumeCommandTemplate".into(), json!(tpl));
            }
            if let Some(tb) = &cli.terminal_behavior {
                c.insert(
                    "terminalBehavior".into(),
                    serde_json::to_value(tb).unwrap_or(Value::Null),
                );
            }
            obj.insert("cli".into(), Value::Object(c));
        }
    }

    Value::Object(obj)
}

// ── availableClis detection ─────────────────────────────────────────────────

/// `detectAvailableClis(specs)` (`platform.ts:107-118`): for each spec, resolve the
/// command (`env[envVar] || defaultCmd`) and probe it with the OS finder
/// (`isCommandAvailable` — `platform.ts:84-91`), returning `{ name: bool }`.
///
/// IO is injected (`env` + `runner`) so the unit tests are hermetic. The live
/// wiring passes the process env + [`StdCommandRunner`] (a READ-ONLY `which`/
/// `where.exe` probe — never a mutating command).
pub fn detect_available_clis(
    specs: &[CliDetectionSpec],
    env: &dyn Fn(&str) -> Option<String>,
    host_os: HostOs,
    runner: &dyn CommandRunner,
) -> Value {
    // `process.platform === 'win32' ? 'where.exe' : 'which'` (platform.ts:85).
    let finder = if is_windows(host_os) {
        "where.exe"
    } else {
        "which"
    };
    let mut map = Map::new();
    for spec in specs {
        let cmd = spec
            .env_var
            .as_deref()
            .and_then(env)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| spec.default_cmd.clone());
        let out = runner.run(finder, &[cmd.as_str()]);
        // `resolve(!err)`: err is set on non-zero exit OR spawn failure.
        let available = out.exit_code == Some(0);
        map.insert(spec.name.clone(), Value::Bool(available));
    }
    Value::Object(map)
}

/// Live edge for [`detect_available_clis`]: process env + [`StdCommandRunner`] +
/// the live host-OS finder.
pub fn detect_available_clis_live(specs: &[CliDetectionSpec]) -> Value {
    let runner = StdCommandRunner::default();
    detect_available_clis(specs, &|k| std::env::var(k).ok(), host_os_live(), &runner)
}

/// Promote an extension-backed CLI when its executable is supplied by the
/// managed workload image rather than the web host. Never invent a provider:
/// only an existing detection-map key may be changed from false to true.
pub fn promote_managed_runtime_cli(available: &mut Value, name: &str) {
    let Some(map) = available.as_object_mut() else {
        return;
    };
    let Some(slot) = map.get_mut(name) else {
        return;
    };
    *slot = Value::Bool(true);
}

// ── Live directory resolution ───────────────────────────────────────────────

/// Resolve the extension scan dirs, mirroring `server/index.ts:224-228`:
/// `[<home>/.freshell/extensions, <cwd>/.freshell/extensions, <builtin>/extensions]`.
/// The builtin dir is resolved like the client dir: `FRESHELL_EXTENSIONS_DIR`
/// override → compile-time `<crate>/../../extensions` → `./extensions`.
pub fn resolve_extension_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".freshell").join("extensions"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join(".freshell").join("extensions"));
    }
    dirs.push(resolve_builtin_extensions_dir());
    dirs
}

fn resolve_builtin_extensions_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("FRESHELL_EXTENSIONS_DIR") {
        return PathBuf::from(dir);
    }
    // `path.join(process.cwd(), 'extensions')` (`server/index.ts:227`): the
    // original's "builtin" dir is CWD-RELATIVE — there is NO compiled-in
    // fallback. A previous `CARGO_MANIFEST_DIR` fallback here made
    // `GET /api/extensions` and `availableClis` non-empty when the process cwd
    // wasn't the repo checkout, diverging from the live original (pinned by a
    // cwd-neutral two-server differential, 2026-07-12: original with fresh HOME
    // + cwd outside the repo serves `extensions=[]`, `availableClis={}`,
    // `knownProviders=[]`).
    PathBuf::from("extensions")
}

/// `encodeURIComponent` for the icon URL — escape everything but the unreserved
/// set `A-Za-z0-9-_.!~*'()`. Extension names are already unreserved, so this is a
/// faithful no-op for the bundled set.
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_platform::{CommandOutput, FakeCommandRunner};
    use std::collections::HashMap;

    fn write_manifest(dir: &Path, sub: &str, json: &str) {
        let ext_dir = dir.join(sub);
        std::fs::create_dir_all(&ext_dir).unwrap();
        std::fs::write(ext_dir.join(MANIFEST_FILE), json).unwrap();
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "freshell-ext-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const CLAUDE_MANIFEST: &str = r#"{
      "name": "claude", "version": "1.0.0", "label": "Claude CLI",
      "description": "Anthropic's Claude Code CLI agent", "category": "cli",
      "cli": { "command": "claude", "envVar": "CLAUDE_CMD",
        "resumeArgs": ["--resume", "{{sessionId}}"],
        "permissionModeArgs": ["--permission-mode", "{{permissionMode}}"],
        "supportsPermissionMode": true },
      "picker": { "shortcut": "L", "group": "agents" }
    }"#;

    const OPENCODE_MANIFEST: &str = r#"{
      "name": "opencode", "version": "1.0.0", "label": "OpenCode",
      "description": "OpenCode CLI agent", "category": "cli",
      "cli": { "command": "opencode", "envVar": "OPENCODE_CMD",
        "resumeArgs": ["--session", "{{sessionId}}"], "modelArgs": ["--model", "{{model}}"],
        "supportsModel": true,
        "terminalBehavior": { "preferredRenderer": "canvas", "scrollInputPolicy": "native" } },
      "picker": { "group": "agents" }
    }"#;

    // ── df1 EXT-01: the scan path consumes the STRICT manifest schema ──────
    //
    // Legacy `extension-manager.ts` validates every `freshell.json` against
    // the strict zod schema and skips-with-warning on ANY failure; the
    // previous Rust port ran a lenient subset (unknown keys ignored,
    // client/server manifests accepted without their config blocks). These
    // tests pin the strict behavior through the real scan path.

    #[test]
    fn scan_skips_manifest_with_unknown_key_but_keeps_valid_sibling() {
        // Strict-mode core rule: an unknown key rejects the WHOLE manifest
        // (`unrecognized_keys`), like a typo'd legacy manifest.
        const BAD: &str = r#"{
          "name": "typo-ext", "version": "1.0.0", "label": "L",
          "description": "D", "category": "cli",
          "cli": { "command": "x" }, "clii": { "command": "y" }
        }"#;
        let root = tmp();
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);
        write_manifest(&root, "typo-ext", BAD);
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        assert_eq!(
            reg.discovered_cli_names(),
            vec!["claude"],
            "typo manifest skipped, valid sibling kept"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_skips_category_block_mismatch_and_missing_blocks() {
        // The category refine: exactly one block, matching `category`.
        const MISSING_BLOCK: &str = r#"{
          "name": "no-block", "version": "1.0.0", "label": "L",
          "description": "D", "category": "cli"
        }"#;
        const WRONG_BLOCK: &str = r#"{
          "name": "wrong-block", "version": "1.0.0", "label": "L",
          "description": "D", "category": "cli",
          "server": { "command": "node" }
        }"#;
        let root = tmp();
        write_manifest(&root, "no-block", MISSING_BLOCK);
        write_manifest(&root, "wrong-block", WRONG_BLOCK);
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        assert!(
            reg.to_client_registry().is_empty(),
            "category/block mismatches must not register"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_skips_client_and_server_manifests_without_their_blocks() {
        // The lenient subset accepted category=client/server unconditionally;
        // the strict schema requires the matching block (client.entry /
        // server.command).
        const CLIENT_NO_BLOCK: &str = r#"{
          "name": "client-no-block", "version": "1.0.0", "label": "L",
          "description": "D", "category": "client"
        }"#;
        const SERVER_NO_BLOCK: &str = r#"{
          "name": "server-no-block", "version": "1.0.0", "label": "L",
          "description": "D", "category": "server"
        }"#;
        const CLIENT_OK: &str = r#"{
          "name": "client-ok", "version": "1.0.0", "label": "L",
          "description": "D", "category": "client",
          "client": { "entry": "./index.html" }
        }"#;
        let root = tmp();
        write_manifest(&root, "client-no-block", CLIENT_NO_BLOCK);
        write_manifest(&root, "server-no-block", SERVER_NO_BLOCK);
        write_manifest(&root, "client-ok", CLIENT_OK);
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        let entries = reg.to_client_registry();
        assert_eq!(entries.len(), 1, "only the well-formed client manifest");
        assert_eq!(entries[0]["name"], json!("client-ok"));
        assert_eq!(entries[0]["category"], json!("client"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_skips_invalid_json_manifest_text() {
        let root = tmp();
        let bad = root.join("not-json");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join(MANIFEST_FILE), "{ not json").unwrap();
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        assert_eq!(reg.discovered_cli_names(), vec!["claude"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_string_icon_produces_no_icon_url() {
        // `icon` is a bare z.string() in the legacy schema — "" is VALID —
        // but the legacy registry gates iconUrl on TRUTHINESS
        // (`if (manifest.icon)`), so "" must not emit one.
        const EMPTY_ICON: &str = r#"{
          "name": "empty-icon", "version": "1.0.0", "label": "L",
          "description": "D", "category": "cli",
          "cli": { "command": "x" }, "icon": ""
        }"#;
        let root = tmp();
        write_manifest(&root, "empty-icon", EMPTY_ICON);
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        let entries = reg.to_client_registry();
        assert_eq!(
            entries.len(),
            1,
            "empty-icon manifest is VALID under strict"
        );
        assert!(
            entries[0].get("iconUrl").is_none(),
            "empty icon must not produce iconUrl (legacy truthiness gate)"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn all_bundled_manifests_validate_and_register_through_scan() {
        // Boot-path regression: the repo's extensions/ tree must survive the
        // strict schema (all six are CLI-category today). Read-only: the
        // dir is only scanned, never written.
        let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../extensions"));
        let reg = ExtensionRegistry::scan(&[dir]);
        let mut names = reg.discovered_cli_names();
        names.sort();
        assert_eq!(
            names,
            ["amplifier", "claude", "codex", "gemini", "kimi", "opencode"],
            "every bundled extension must validate under the strict schema"
        );
    }

    #[test]
    fn scan_warns_with_legacys_two_log_lines_for_the_two_failure_classes() {
        // EXT-01 diagnostics parity: legacy logs 'invalid JSON in manifest'
        // for unparseable text and 'invalid manifest' (+ issues) for schema
        // failures — warn and skip, never crash discovery. Assert BOTH lines
        // actually fire (absence from the registry alone was also true of the
        // old lenient port).
        //
        // Capture strategy (matching freshell-freshagent's documented
        // investigation): a set_global_default subscriber installed EXACTLY
        // ONCE per test binary via OnceLock. Thread-local set_default proved
        // nondeterministic under parallel `cargo test` (callsite interest
        // caching); the global layer observes every event, and this test
        // filters by its unique temp manifest_path.
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex, OnceLock};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Level, Subscriber};
        use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

        struct Captured {
            message: String,
            fields: BTreeMap<String, String>,
        }
        #[derive(Default)]
        struct V {
            message: String,
            fields: BTreeMap<String, String>,
        }
        impl Visit for V {
            fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
                let r = format!("{v:?}");
                if f.name() == "message" {
                    self.message = r;
                } else {
                    self.fields.insert(f.name().into(), r);
                }
            }
            fn record_str(&mut self, f: &Field, v: &str) {
                if f.name() == "message" {
                    self.message = v.into();
                } else {
                    self.fields.insert(f.name().into(), v.into());
                }
            }
        }
        struct CaptureLayer {
            events: Arc<Mutex<Vec<Captured>>>,
        }
        impl<S: Subscriber> Layer<S> for CaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                if *event.metadata().level() != Level::WARN {
                    return;
                }
                let mut v = V::default();
                event.record(&mut v);
                self.events.lock().expect("capture lock").push(Captured {
                    message: v.message,
                    fields: v.fields,
                });
            }
        }

        static GLOBAL_EVENTS: OnceLock<Arc<Mutex<Vec<Captured>>>> = OnceLock::new();
        let events = GLOBAL_EVENTS.get_or_init(|| {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            // Ignore the error case: some OTHER test installed a global
            // subscriber first — then this assertion would fail noisily
            // below, but no freshell-server test does that today.
            let _ =
                tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer));
            events
        });

        let root = tmp();
        let bad_json = root.join("bad-json");
        std::fs::create_dir_all(&bad_json).unwrap();
        std::fs::write(bad_json.join(MANIFEST_FILE), "{ nope").unwrap();
        write_manifest(
            &root,
            "bad-schema",
            r#"{ "name": "x", "version": "1", "label": "l", "description": "d", "category": "cli" }"#,
        );
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);

        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        assert_eq!(reg.discovered_cli_names(), vec!["claude"]);

        let root_marker = root.display().to_string();
        let mine: Vec<String> = events
            .lock()
            .expect("capture lock")
            .iter()
            .filter(|e| {
                e.fields
                    .get("manifest_path")
                    .is_some_and(|p| p.contains(&root_marker))
            })
            .map(|e| e.message.clone())
            .collect();
        assert_eq!(
            mine.len(),
            2,
            "one warn per rejected manifest, got {mine:?}"
        );
        assert!(
            mine.iter().any(|m| m.contains("invalid JSON in manifest")),
            "JSON-parse warn line present: {mine:?}"
        );
        assert!(
            mine.iter()
                .any(|m| m.contains("invalid manifest") && !m.contains("invalid JSON")),
            "schema-invalid warn line present: {mine:?}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_discovers_cli_manifests_and_dedups_first_wins() {
        let root = tmp();
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);
        write_manifest(&root, "opencode", OPENCODE_MANIFEST);
        // Duplicate name in a later-scanned dir must be ignored (first wins).
        let root2 = tmp();
        write_manifest(&root2, "claude-dup", CLAUDE_MANIFEST);

        let reg = ExtensionRegistry::scan(&[root.clone(), root2.clone()]);
        assert_eq!(reg.entries.len(), 2, "claude + opencode, dup dropped");
        // Strictly stronger than the deleted has_cli(): proves WHICH CLI manifests
        // were discovered, not just that one exists (scan() sorts subdir names, so
        // root's "claude-code" + "opencode" yield ["claude", "opencode"]; root2's
        // dup is dropped).
        assert_eq!(reg.discovered_cli_names(), vec!["claude", "opencode"]);

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&root2).ok();
    }

    #[test]
    fn client_registry_matches_frozen_shape_for_claude() {
        let root = tmp();
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        let entries = reg.to_client_registry();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e["name"], json!("claude"));
        assert_eq!(e["category"], json!("cli"));
        assert_eq!(e["serverRunning"], json!(false));
        assert_eq!(e["picker"], json!({ "shortcut": "L", "group": "agents" }));
        // cli block: supportsPermissionMode + supportsResume + resumeCommandTemplate,
        // NO supportsModel/supportsSandbox/terminalBehavior (undefined → omitted).
        assert_eq!(e["cli"]["supportsPermissionMode"], json!(true));
        assert_eq!(e["cli"]["supportsResume"], json!(true));
        assert_eq!(
            e["cli"]["resumeCommandTemplate"],
            json!(["claude", "--resume", "{{sessionId}}"])
        );
        assert!(e["cli"].get("supportsModel").is_none());
        assert!(e["cli"].get("supportsSandbox").is_none());
        assert!(e["cli"].get("terminalBehavior").is_none());
        assert!(e.get("serverPort").is_none());
        assert!(e.get("iconUrl").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn client_registry_includes_terminal_behavior_and_model_for_opencode() {
        let root = tmp();
        write_manifest(&root, "opencode", OPENCODE_MANIFEST);
        let e = &ExtensionRegistry::scan(std::slice::from_ref(&root)).to_client_registry()[0];
        assert_eq!(e["cli"]["supportsModel"], json!(true));
        assert_eq!(
            e["cli"]["terminalBehavior"],
            json!({ "preferredRenderer": "canvas", "scrollInputPolicy": "native" })
        );
        // opencode has no resumeArgs? It does — supportsResume true.
        assert_eq!(e["cli"]["supportsResume"], json!(true));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn detection_specs_from_extensions_use_command_and_env_var() {
        let root = tmp();
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);
        write_manifest(&root, "opencode", OPENCODE_MANIFEST);
        let specs = ExtensionRegistry::scan(std::slice::from_ref(&root)).cli_detection_specs();
        assert_eq!(specs.len(), 2);
        let claude = specs.iter().find(|s| s.name == "claude").unwrap();
        assert_eq!(claude.env_var.as_deref(), Some("CLAUDE_CMD"));
        assert_eq!(claude.default_cmd, "claude");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_registry_yields_empty_specs() {
        // `detectAvailableClis(cliDetectionSpecs)` is always called with the
        // extension-derived array in `server/index.ts` — an empty registry means
        // an EMPTY spec list (original cwd-neutral live probe: `availableClis: {}`),
        // never the `DEFAULT_CLI_DETECTION_SPECS` default-parameter set.
        let reg = ExtensionRegistry::default();
        assert!(reg.cli_detection_specs().is_empty());
    }

    #[test]
    fn detect_available_clis_probes_finder_and_honors_env_override() {
        let specs = vec![
            CliDetectionSpec {
                name: "claude".into(),
                env_var: Some("CLAUDE_CMD".into()),
                default_cmd: "claude".into(),
            },
            CliDetectionSpec {
                name: "codex".into(),
                env_var: Some("CODEX_CMD".into()),
                default_cmd: "codex".into(),
            },
        ];
        // `which claude-real` → found (exit 0); `which codex` → not found.
        let runner = FakeCommandRunner::new()
            .on(
                "which",
                &["claude-real"],
                CommandOutput {
                    exit_code: Some(0),
                    stdout: "/usr/bin/claude-real".into(),
                    stderr: String::new(),
                    timed_out: false,
                },
            )
            .on(
                "which",
                &["codex"],
                CommandOutput {
                    exit_code: Some(1),
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                },
            );
        let mut env = HashMap::new();
        env.insert("CLAUDE_CMD".to_string(), "claude-real".to_string());
        let get = |k: &str| env.get(k).cloned();

        let out = detect_available_clis(&specs, &get, HostOs::Linux, &runner);
        assert_eq!(out["claude"], json!(true));
        assert_eq!(out["codex"], json!(false));
    }

    #[test]
    fn managed_runtime_availability_only_promotes_already_registered_provider() {
        let mut value = serde_json::json!({"claude": false, "opencode": false});
        promote_managed_runtime_cli(&mut value, "opencode");
        promote_managed_runtime_cli(&mut value, "not-registered");
        assert_eq!(
            value,
            serde_json::json!({"claude": false, "opencode": true})
        );
    }

    #[test]
    fn detect_available_clis_uses_where_exe_on_windows() {
        let specs = vec![CliDetectionSpec {
            name: "claude".into(),
            env_var: Some("CLAUDE_CMD".into()),
            default_cmd: "claude".into(),
        }];
        let runner = FakeCommandRunner::new().on(
            "where.exe",
            &["claude"],
            CommandOutput {
                exit_code: Some(0),
                stdout: "C:\\claude.exe".into(),
                stderr: String::new(),
                timed_out: false,
            },
        );
        let get = |_: &str| None;
        let out = detect_available_clis(&specs, &get, HostOs::Windows, &runner);
        assert_eq!(out["claude"], json!(true));
    }

    #[test]
    fn spawn_failure_reports_unavailable() {
        let specs = vec![CliDetectionSpec {
            name: "kimi".into(),
            env_var: Some("KIMI_CMD".into()),
            default_cmd: "kimi".into(),
        }];
        // No rule → FakeCommandRunner returns a spawn_failure (exit_code None).
        let runner = FakeCommandRunner::new();
        let get = |_: &str| None;
        let out = detect_available_clis(&specs, &get, HostOs::Linux, &runner);
        assert_eq!(out["kimi"], json!(false));
    }
}
