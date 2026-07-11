//! Extension registry + coding-CLI availability detection (Follow-up 3.19).
//!
//! **FAITHFUL-PORT + unit-proven, NOT differential-oracle-proven.** There is no
//! captured original transcript for these boot reads; correctness is argued by a
//! faithful port with file:line citations, a response-SHAPE match to the frozen
//! client contract, and the unit tests below (+ curl smokes in the report).
//!
//! Ports, additively (no `server/` or `shared/` source touched):
//! * `server/extension-manager.ts` `scan()` (62-131) and `toClientRegistry()`
//!   (144-191) — discover `freshell.json` manifests under the extension dirs and
//!   serialize the client registry the SPA fetches at `GET /api/extensions`
//!   (`src/hooks/useEnsureExtensionsRegistry.ts`).
//! * `server/extension-manifest.ts` (81-103) — the manifest schema subset used by
//!   the registry + CLI detection (lenient: unknown keys ignored rather than the
//!   original's strict reject, since the bundled manifests are trusted).
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

use freshell_platform::detect::{host_os_live, is_windows, HostOs};
use freshell_platform::{CommandRunner, StdCommandRunner};
use serde::Deserialize;
use serde_json::{json, Map, Value};

const MANIFEST_FILE: &str = "freshell.json";

/// `DEFAULT_CLI_DETECTION_SPECS` (`server/platform.ts:97-103`) — the built-in CLI
/// set, used as the fallback when no `extensions/` dir is present (mirrors the
/// original's default parameter of `detectAvailableClis`).
pub const DEFAULT_CLI_DETECTION_SPECS: &[(&str, &str, &str)] = &[
    ("claude", "CLAUDE_CMD", "claude"),
    ("codex", "CODEX_CMD", "codex"),
    ("opencode", "OPENCODE_CMD", "opencode"),
    ("gemini", "GEMINI_CMD", "gemini"),
    ("kimi", "KIMI_CMD", "kimi"),
];

// ── Manifest schema (subset of server/extension-manifest.ts) ────────────────

/// The terminal-behavior block (`extension-manifest.ts:45-48`).
#[derive(Debug, Clone, Deserialize)]
struct TerminalBehavior {
    #[serde(rename = "preferredRenderer", skip_serializing_if = "Option::is_none")]
    preferred_renderer: Option<String>,
    #[serde(rename = "scrollInputPolicy", skip_serializing_if = "Option::is_none")]
    scroll_input_policy: Option<String>,
}

/// The CLI config block (`extension-manifest.ts:50-66`). Only the fields the
/// client registry + detection use are modeled; the rest (args/env/modelArgs/…)
/// are tolerated-and-ignored (lenient parse).
#[derive(Debug, Clone, Deserialize)]
struct CliConfig {
    command: String,
    #[serde(rename = "envVar")]
    env_var: Option<String>,
    #[serde(rename = "resumeArgs")]
    resume_args: Option<Vec<String>>,
    #[serde(rename = "supportsPermissionMode")]
    supports_permission_mode: Option<bool>,
    #[serde(rename = "supportsModel")]
    supports_model: Option<bool>,
    #[serde(rename = "supportsSandbox")]
    supports_sandbox: Option<bool>,
    #[serde(rename = "terminalBehavior")]
    terminal_behavior: Option<TerminalBehavior>,
}

/// The picker config block (`extension-manifest.ts:72-75`).
#[derive(Debug, Clone, Deserialize)]
struct PickerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    shortcut: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

/// The top-level manifest (`extension-manifest.ts:81-103`). Lenient: unknown keys
/// are ignored (the bundled manifests are trusted; the original's strict reject is
/// a manifest-authoring guard, not a wire invariant).
#[derive(Debug, Clone, Deserialize)]
struct ExtensionManifest {
    name: String,
    version: String,
    label: String,
    description: String,
    category: String,
    icon: Option<String>,
    url: Option<String>,
    #[serde(rename = "contentSchema")]
    content_schema: Option<Value>,
    picker: Option<PickerConfig>,
    cli: Option<CliConfig>,
}

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
    /// (first-wins on duplicate). Invalid/missing manifests are skipped.
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
                let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_str::<ExtensionManifest>(&raw) else {
                    continue;
                };
                if !is_valid_manifest(&manifest) {
                    continue;
                }
                if seen.contains(&manifest.name) {
                    continue; // duplicate name — first wins
                }
                seen.insert(manifest.name.clone());
                entries.push(RegistryEntry { manifest });
            }
        }

        ExtensionRegistry { entries }
    }

    /// Whether any CLI extension was discovered.
    pub fn has_cli(&self) -> bool {
        self.entries
            .iter()
            .any(|e| e.manifest.category == "cli" && e.manifest.cli.is_some())
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
    /// [`DEFAULT_CLI_DETECTION_SPECS`] fallback. This is the source for
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
            .filter(|e| e.manifest.category == "cli" && e.manifest.cli.is_some())
            .map(|e| e.manifest.name.clone())
            .collect()
    }

    /// Build CLI detection specs from the CLI extensions (`server/index.ts:257-264`).
    /// Falls back to [`DEFAULT_CLI_DETECTION_SPECS`] when no CLI extension is present
    /// (mirrors `detectAvailableClis`'s default parameter).
    pub fn cli_detection_specs(&self) -> Vec<CliDetectionSpec> {
        if !self.has_cli() {
            return DEFAULT_CLI_DETECTION_SPECS
                .iter()
                .map(|(name, env_var, cmd)| CliDetectionSpec {
                    name: (*name).to_string(),
                    env_var: Some((*env_var).to_string()),
                    default_cmd: (*cmd).to_string(),
                })
                .collect();
        }
        self.entries
            .iter()
            .filter(|e| e.manifest.category == "cli")
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

/// The manifest refinement (`extension-manifest.ts:96-103`): the declared category
/// must carry exactly its own config block. Only `cli` is modeled here; a `cli`
/// manifest without a `cli` block (or vice-versa) is rejected. `client`/`server`
/// manifests are accepted as-is (their blocks aren't modeled but aren't required
/// for the registry/CLI surface).
fn is_valid_manifest(m: &ExtensionManifest) -> bool {
    match m.category.as_str() {
        "cli" => m.cli.is_some(),
        "client" | "server" => true,
        _ => false,
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
    obj.insert("category".into(), json!(m.category));
    // `serverRunning` is always present; this read-only port never runs server
    // extensions, so it is always false (and `serverPort` is omitted).
    obj.insert("serverRunning".into(), json!(false));

    if m.icon.is_some() {
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
        obj.insert("contentSchema".into(), cs.clone());
    }
    if let Some(p) = &m.picker {
        obj.insert("picker".into(), serde_json::to_value(p).unwrap_or(Value::Null));
    }
    if m.category == "cli" {
        if let Some(cli) = &m.cli {
            let mut c = Map::new();
            if let Some(v) = cli.supports_permission_mode {
                c.insert("supportsPermissionMode".into(), json!(v));
            }
            if let Some(v) = cli.supports_model {
                c.insert("supportsModel".into(), json!(v));
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

impl serde::Serialize for TerminalBehavior {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        if let Some(v) = &self.preferred_renderer {
            m.insert("preferredRenderer".into(), json!(v));
        }
        if let Some(v) = &self.scroll_input_policy {
            m.insert("scrollInputPolicy".into(), json!(v));
        }
        Value::Object(m).serialize(s)
    }
}

impl serde::Serialize for PickerConfig {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        if let Some(v) = &self.shortcut {
            m.insert("shortcut".into(), json!(v));
        }
        if let Some(v) = &self.group {
            m.insert("group".into(), json!(v));
        }
        Value::Object(m).serialize(s)
    }
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
    let finder = if is_windows(host_os) { "where.exe" } else { "which" };
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
    detect_available_clis(
        specs,
        &|k| std::env::var(k).ok(),
        host_os_live(),
        &runner,
    )
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
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../extensions");
    if compiled.exists() {
        return compiled;
    }
    PathBuf::from("extensions")
}

/// `encodeURIComponent` for the icon URL — escape everything but the unreserved
/// set `A-Za-z0-9-_.!~*'()`. Extension names are already unreserved, so this is a
/// faithful no-op for the bundled set.
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
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
        assert!(reg.has_cli());

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&root2).ok();
    }

    #[test]
    fn client_registry_matches_frozen_shape_for_claude() {
        let root = tmp();
        write_manifest(&root, "claude-code", CLAUDE_MANIFEST);
        let reg = ExtensionRegistry::scan(&[root.clone()]);
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
        let e = &ExtensionRegistry::scan(&[root.clone()]).to_client_registry()[0];
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
        let specs = ExtensionRegistry::scan(&[root.clone()]).cli_detection_specs();
        assert_eq!(specs.len(), 2);
        let claude = specs.iter().find(|s| s.name == "claude").unwrap();
        assert_eq!(claude.env_var.as_deref(), Some("CLAUDE_CMD"));
        assert_eq!(claude.default_cmd, "claude");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_registry_falls_back_to_default_specs() {
        let reg = ExtensionRegistry::default();
        let specs = reg.cli_detection_specs();
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["claude", "codex", "opencode", "gemini", "kimi"]);
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
            .on("which", &["claude-real"], CommandOutput { exit_code: Some(0), stdout: "/usr/bin/claude-real".into(), stderr: String::new() })
            .on("which", &["codex"], CommandOutput { exit_code: Some(1), stdout: String::new(), stderr: String::new() });
        let mut env = HashMap::new();
        env.insert("CLAUDE_CMD".to_string(), "claude-real".to_string());
        let get = |k: &str| env.get(k).cloned();

        let out = detect_available_clis(&specs, &get, HostOs::Linux, &runner);
        assert_eq!(out["claude"], json!(true));
        assert_eq!(out["codex"], json!(false));
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
            CommandOutput { exit_code: Some(0), stdout: "C:\\claude.exe".into(), stderr: String::new() },
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
