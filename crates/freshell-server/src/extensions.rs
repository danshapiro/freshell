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
//!   (`src/hooks/useEnsureExtensionsRegistry.ts`). The original's per-skip
//!   `Extension scan: …` log diagnostics (:66-130) are mirrored as structured
//!   `extension.scan.*` tracing events (EXT-02).
//! * `server/extension-manifest.ts` — the FULL strict manifest schema
//!   (:14-103): `z.strictObject` unknown-key rejection at every level, the
//!   client/server/cli config blocks (with zod defaults materialized:
//!   `args: []`, `readyTimeout: 10000`, `singleton: true`), min(1) identity
//!   strings, the terminalBehavior enums, the contentSchema field schema +
//!   default-matches-type refine, and the category↔config-block coupling
//!   refine. The rules serde cannot express are applied by
//!   `validate_manifest` after parsing.
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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use freshell_platform::detect::{host_os_live, is_windows, HostOs};
use freshell_platform::{CommandRunner, StdCommandRunner};
use serde::Deserialize;
use serde_json::{json, Map, Value};

const MANIFEST_FILE: &str = "freshell.json";

// ── Manifest schema (full strict port of server/extension-manifest.ts) ──────

/// `preferredRenderer: z.enum(['canvas'])` (extension-manifest.ts:46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
enum PreferredRenderer {
    #[serde(rename = "canvas")]
    Canvas,
}

impl PreferredRenderer {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Canvas => "canvas",
        }
    }
}

/// `scrollInputPolicy: z.enum(['native', 'fallbackToCursorKeysWhenAltScreenMouseCapture'])`
/// (extension-manifest.ts:47).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
enum ScrollInputPolicy {
    #[serde(rename = "native")]
    Native,
    #[serde(rename = "fallbackToCursorKeysWhenAltScreenMouseCapture")]
    FallbackToCursorKeysWhenAltScreenMouseCapture,
}

impl ScrollInputPolicy {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::FallbackToCursorKeysWhenAltScreenMouseCapture => {
                "fallbackToCursorKeysWhenAltScreenMouseCapture"
            }
        }
    }
}

/// The terminal-behavior block (`extension-manifest.ts:45-48`) — strict like
/// the original's `z.strictObject`: unknown keys and non-enum values reject
/// the manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalBehavior {
    #[serde(rename = "preferredRenderer", skip_serializing_if = "Option::is_none")]
    preferred_renderer: Option<PreferredRenderer>,
    #[serde(rename = "scrollInputPolicy", skip_serializing_if = "Option::is_none")]
    scroll_input_policy: Option<ScrollInputPolicy>,
}

/// The client config block (`extension-manifest.ts:31-33`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientConfig {
    /// `entry: z.string().min(1)` (:32) — non-empty checked by validate_manifest.
    entry: String,
}

/// The server config block (`extension-manifest.ts:35-43`) with the zod
/// defaults materialized (:37 `args: []`, :40 `readyTimeout: 10000`,
/// :42 `singleton: true`). This read-only port never spawns server extensions,
/// so only the SCHEMA is parity-relevant here (the consuming `startServer`
/// lifecycle, extension-manager.ts:218-309, is unported).
#[allow(dead_code)] // parse/validate-only fields — see the doc comment above
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServerConfig {
    /// `command: z.string().min(1)` (:36) — non-empty checked by validate_manifest.
    command: String,
    /// `args: z.array(z.string()).optional().default([])` (:37).
    #[serde(default)]
    args: Vec<String>,
    /// `env: z.record(z.string(), z.string()).optional()` (:38).
    env: Option<BTreeMap<String, String>>,
    #[serde(rename = "readyPattern")]
    ready_pattern: Option<String>,
    /// `readyTimeout: z.number().int().positive().optional().default(10000)`
    /// (:40) — `u64` deserialization already rejects null/negative/fractional
    /// input; zero is rejected by validate_manifest.
    #[serde(rename = "readyTimeout", default = "default_ready_timeout")]
    ready_timeout: u64,
    #[serde(rename = "healthCheck")]
    health_check: Option<String>,
    /// `singleton: z.boolean().optional().default(true)` (:42).
    #[serde(default = "default_singleton")]
    singleton: bool,
}

/// The zod defaults (:37/:40/:42). Explicit `null` for any of these still
/// fails — serde must materialize a concrete `Vec`/`u64`/`bool` — matching
/// zod, where `.optional().default(v)` accepts `undefined` only.
fn default_ready_timeout() -> u64 {
    10_000
}

fn default_singleton() -> bool {
    true
}

/// The CLI config block (`extension-manifest.ts:50-66`). The full arg-template
/// fields (`args`/`env`/`modelArgs`/`sandboxArgs`/`permissionModeArgs`/
/// `createSessionArgs`) are modeled since task-006: they feed the coding-CLI
/// command specs (`server/index.ts:231-255` compilation), per
/// `port/machine/specs/cli-argv-fidelity.md` §3.1.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CliConfig {
    /// `command: z.string().min(1)` (:51) — non-empty checked by validate_manifest.
    command: String,
    #[serde(rename = "envVar")]
    env_var: Option<String>,
    /// `args: z.array(z.string()).optional().default([])` (:52).
    #[serde(default)]
    args: Vec<String>,
    env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(rename = "resumeArgs")]
    resume_args: Option<Vec<String>>,
    #[serde(rename = "createSessionArgs")]
    create_session_args: Option<Vec<String>>,
    #[serde(rename = "modelArgs")]
    model_args: Option<Vec<String>>,
    #[serde(rename = "sandboxArgs")]
    sandbox_args: Option<Vec<String>>,
    #[serde(rename = "permissionModeArgs")]
    permission_mode_args: Option<Vec<String>>,
    /// `permissionModeEnvVar: z.string().optional()` (:60). Parsed + validated
    /// for schema parity; not plumbed into `CliCommandSpec` (documented at
    /// freshell_platform::cli_launch:32 — the consuming branch,
    /// terminal-registry.ts:367-373, is inert for the shipped manifests; EXT-05).
    #[allow(dead_code)]
    #[serde(rename = "permissionModeEnvVar")]
    permission_mode_env_var: Option<String>,
    /// `permissionModeValues: z.record(z.string(), z.string()).optional()` (:61)
    /// — same parse-only status as `permissionModeEnvVar`.
    #[allow(dead_code)]
    #[serde(rename = "permissionModeValues")]
    permission_mode_values: Option<BTreeMap<String, String>>,
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
#[serde(deny_unknown_fields)]
struct PickerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    shortcut: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

/// The top-level manifest (`extension-manifest.ts:81-103`) — STRICT port: like
/// the original's `z.strictObject`, unknown keys reject the manifest (catches
/// typos in manifest files, :5-6). `validate_manifest` then applies the rules
/// serde cannot express: min(1) strings (:82-85), the category enum (:86), the
/// contentSchema field schema + default-matches-type refine (:14-25), and the
/// category↔config-block coupling refine (:96-103).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionManifest {
    name: String,
    version: String,
    label: String,
    description: String,
    category: String,
    icon: Option<String>,
    url: Option<String>,
    /// Tri-state: zod's `.optional()` accepts ABSENT (`undefined`) but REJECTS
    /// an explicit `null` (`contentSchema: z.record(...).optional()`,
    /// `extension-manifest.ts:90`); a bare `Option<Value>` would collapse the
    /// two (EXT-04). `Present` values are shape-checked against
    /// ContentSchemaFieldSchema (:14-25) by `validate_manifest` (the original's
    /// single `safeParse` gate, extension-manager.ts:104-110) and echoed
    /// bit-for-bit by `toClientRegistry` (`ClientExtensionEntry.contentSchema`,
    /// shared/extension-types.ts:30).
    #[serde(
        rename = "contentSchema",
        default,
        deserialize_with = "de_content_schema"
    )]
    content_schema: ContentSchemaSlot,
    picker: Option<PickerConfig>,
    client: Option<ClientConfig>,
    server: Option<ServerConfig>,
    cli: Option<CliConfig>,
}

/// Tri-state for the manifest's optional `contentSchema` block (see the field
/// doc above): the original distinguishes "key absent" (valid, block omitted
/// from the client entry) from "key present but `null`/malformed" (manifest
/// rejected outright).
#[derive(Debug, Clone, PartialEq)]
enum ContentSchemaSlot {
    Absent,
    Present(Value),
}

impl Default for ContentSchemaSlot {
    fn default() -> Self {
        ContentSchemaSlot::Absent
    }
}

/// Any PRESENT value (including `null`) deserializes as `Present(..)` — the
/// absent case is handled by `#[serde(default)]`, which never calls this.
fn de_content_schema<'de, D>(deserializer: D) -> Result<ContentSchemaSlot, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(ContentSchemaSlot::Present(Value::deserialize(
        deserializer,
    )?))
}

// ── Registry ─────────────────────────────────────────────────────────────────

/// One discovered extension (`ExtensionRegistryEntry` — `extension-manager.ts:25-29`,
/// minus the entry `path` and `serverPort`: this read-only port never allocates a
/// port, and the path only matters during scanning (the duplicate diagnostic's
/// `existingPath`, :117), where the `seen` map tracks it).
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
    /// (first-wins on duplicate). Invalid/missing manifests are skipped with the
    /// original's per-skip log diagnostics mirrored as structured
    /// `extension.scan.*` tracing events (line refs below).
    ///
    /// **Determinism note:** the original iterates `fs.readdirSync` order (which is
    /// filesystem-dependent, i.e. nondeterministic); this port sorts subdirectory
    /// names so the client-registry array is stable across boots (the picker
    /// re-groups anyway, so this cannot change what the user sees).
    pub fn scan(dirs: &[PathBuf]) -> Self {
        let mut entries: Vec<RegistryEntry> = Vec::new();
        // Name → winning entry dir (`registry.set(manifest.name, { manifest, path })`,
        // :123) so the duplicate warning can report the original's `existingPath`
        // field (:117).
        let mut seen: BTreeMap<String, PathBuf> = BTreeMap::new();

        for dir in dirs {
            // `if (!fs.existsSync(dir))` (:66): missing scan roots are routine
            // (user/project dirs usually absent), so the original logs at debug.
            if !dir.exists() {
                tracing::debug!(dir = %dir.display(), "extension.scan.dir_missing");
                continue;
            }
            let read = match std::fs::read_dir(dir) {
                Ok(read) => read,
                Err(err) => {
                    // `failed to read directory` (:74-77).
                    tracing::warn!(dir = %dir.display(), error = %err, "extension.scan.dir_read_failed");
                    continue;
                }
            };
            // Only directories and symlinks (`entry.isDirectory() || entry.isSymbolicLink()`,
            // :80-81) — a symlink target may live outside the scan root; like the
            // original, this port registers the link's NAME, never a path.
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
                let entry_dir = dir.join(&name);
                let manifest_path = entry_dir.join(MANIFEST_FILE);
                // `if (!fs.existsSync(manifestPath)) continue` (:86) is SILENT in
                // the original — a subdir without a manifest simply is not an
                // extension. `exists()` follows links, so dangling symlinks land
                // here too (legacy `fs.existsSync` likewise follows).
                if !manifest_path.exists() {
                    continue;
                }
                let raw = match std::fs::read_to_string(&manifest_path) {
                    Ok(raw) => raw,
                    Err(err) => {
                        // `failed to read manifest file` (:91-94).
                        tracing::warn!(
                            manifest_path = %manifest_path.display(),
                            error = %err,
                            "extension.scan.manifest_read_failed"
                        );
                        continue;
                    }
                };
                let manifest: ExtensionManifest = match serde_json::from_str(&raw) {
                    Ok(manifest) => manifest,
                    Err(err) => {
                        // The original splits this in two: `invalid JSON in
                        // manifest` on a JSON.parse throw (:99-101) and `invalid
                        // manifest` on a schema reject (:104-110). serde_json folds
                        // both into one error; its classification restores the split.
                        if err.is_syntax() || err.is_eof() {
                            tracing::warn!(
                                manifest_path = %manifest_path.display(),
                                error = %err,
                                "extension.scan.invalid_json_in_manifest"
                            );
                        } else {
                            // Data errors (missing fields, wrong types, unknown
                            // keys, bad enum variants) are the first half of the
                            // legacy schema reject (:104-110, logged as
                            // { manifestPath, errors }).
                            tracing::warn!(
                                manifest_path = %manifest_path.display(),
                                errors = %err,
                                "extension.scan.invalid_manifest"
                            );
                        }
                        continue;
                    }
                };
                if let Err(errors) = validate_manifest(&manifest) {
                    // The refinement half of `invalid manifest` (:104-110): schema
                    // rules serde cannot express, including the typed
                    // `contentSchema` scan gate (incl. the default-matches-type
                    // refinement and the explicit-`null` reject, EXT-04) — the
                    // original's one `safeParse` covers all of it.
                    tracing::warn!(
                        manifest_path = %manifest_path.display(),
                        errors = %errors,
                        "extension.scan.invalid_manifest"
                    );
                    continue;
                }
                if let Some(existing_path) = seen.get(&manifest.name) {
                    // `duplicate name, skipping` with { name, path, existingPath }
                    // (:115-121) — first wins.
                    tracing::warn!(
                        name = %manifest.name,
                        path = %entry_dir.display(),
                        existing_path = %existing_path.display(),
                        "extension.scan.duplicate_name"
                    );
                    continue;
                }
                seen.insert(manifest.name.clone(), entry_dir);
                entries.push(RegistryEntry { manifest });
            }
        }

        // `Extension scan complete` with { count, names } (:127-130).
        tracing::info!(
            count = entries.len(),
            names = ?entries.iter().map(|e| e.manifest.name.as_str()).collect::<Vec<_>>(),
            "extension.scan.complete"
        );

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
            .filter(|e| e.manifest.category == "cli" && e.manifest.cli.is_some())
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
            .filter(|e| e.manifest.category == "cli")
            .filter_map(|e| e.manifest.cli.as_ref().map(|cli| (e, cli)))
            .map(|(e, cli)| freshell_platform::CliCommandSpec {
                name: e.manifest.name.clone(),
                label: e.manifest.label.clone(),
                // `envVar: cli.envVar || ''` then `spec.envVar && env[...]`:
                // empty is falsy, so model it as `None`.
                env_var: cli.env_var.clone().filter(|v| !v.is_empty()),
                default_cmd: cli.command.clone(),
                base_args: cli.args.clone(),
                base_env: cli.env.clone().unwrap_or_default(),
                resume_args: cli.resume_args.clone(),
                create_session_args: cli.create_session_args.clone(),
                model_args: cli.model_args.clone(),
                sandbox_args: cli.sandbox_args.clone(),
                permission_mode_args: cli.permission_mode_args.clone(),
            })
            .collect()
    }

    pub fn cli_detection_specs(&self) -> Vec<CliDetectionSpec> {
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

/// The manifest rules serde cannot express, mirroring the zod schema
/// (`extension-manifest.ts`): min(1) top-level identity strings (:82-85), the
/// category enum (:86), the category↔config-block coupling refine (:96-103,
/// message verbatim), per-block min(1) command/entry strings (:32/:36/:51),
/// readyTimeout positivity (:40), and the `contentSchema` record's field
/// schema with its default-matches-type refine (:14-25). All violations are
/// collected and joined into one diagnostic string — the legacy logs
/// `result.error.format()` for the same purpose (extension-manager.ts:104-110).
fn validate_manifest(m: &ExtensionManifest) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    // `z.string().min(1)` on the four identity strings (:82-85).
    for (field, value) in [
        ("name", &m.name),
        ("version", &m.version),
        ("label", &m.label),
        ("description", &m.description),
    ] {
        if value.is_empty() {
            errors.push(format!("{field}: must contain at least 1 character(s)"));
        }
    }

    // `category: z.enum(['client', 'server', 'cli'])` (:86).
    let category_known = matches!(m.category.as_str(), "client" | "server" | "cli");
    if !category_known {
        errors.push(format!(
            "category: unknown category `{}`; expected 'client', 'server', or 'cli'",
            m.category
        ));
    }

    // The coupling refine (:96-103): exactly the category's own block, no
    // others. Zod effects skip the refine when the base parse fails, so an
    // unknown category skips this check.
    let present: Vec<&str> = [
        ("client", m.client.is_some()),
        ("server", m.server.is_some()),
        ("cli", m.cli.is_some()),
    ]
    .into_iter()
    .filter_map(|(block, is_present)| is_present.then_some(block))
    .collect();
    if category_known && (present.len() != 1 || present[0] != m.category.as_str()) {
        errors.push("category must have exactly its own config block (no others)".to_string());
    }

    // Per-block min(1) strings (:32/:36/:51) + readyTimeout positivity (:40).
    if let Some(client) = &m.client {
        if client.entry.is_empty() {
            errors.push("client.entry: must contain at least 1 character(s)".to_string());
        }
    }
    if let Some(server) = &m.server {
        if server.command.is_empty() {
            errors.push("server.command: must contain at least 1 character(s)".to_string());
        }
        if server.ready_timeout == 0 {
            errors.push("server.readyTimeout: must be a positive integer".to_string());
        }
    }
    if let Some(cli) = &m.cli {
        if cli.command.is_empty() {
            errors.push("cli.command: must contain at least 1 character(s)".to_string());
        }
    }
    // The typed `contentSchema` scan gate (EXT-04): a PRESENT value (including
    // an explicit `null`) must satisfy the ContentSchemaFieldSchema; ABSENT
    // passes, mirroring zod's `.optional()` undefined-only semantics (:90).
    if let ContentSchemaSlot::Present(content_schema) = &m.content_schema {
        validate_content_schema(content_schema, &mut errors);
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// `ContentSchemaFieldSchema` (extension-manifest.ts:14-25) applied to the raw
/// `contentSchema` value: a record (:90) of strict objects (:14) with
/// `type ∈ {string,number,boolean}`, a required string `label`, an optional
/// boolean `required`, and an optional `default ∈ string|number|boolean` whose
/// JS typeof must equal the declared `type` (:19-25 refine). The manifest keeps
/// the raw Value so `toClientRegistry` echoes it bit-for-bit.
fn validate_content_schema(v: &Value, errors: &mut Vec<String>) {
    let Some(fields) = v.as_object() else {
        errors.push("contentSchema: must be an object of field definitions".to_string());
        return;
    };
    for (key, field) in fields {
        let Some(obj) = field.as_object() else {
            errors.push(format!("contentSchema.{key}: must be an object"));
            continue;
        };
        // `z.strictObject` (:14): keys beyond these four reject.
        for k in obj.keys() {
            if !matches!(k.as_str(), "type" | "label" | "required" | "default") {
                errors.push(format!(
                    "contentSchema.{key}: unknown field `{k}`; expected 'type', 'label', 'required', or 'default'"
                ));
            }
        }
        let declared_type = match obj.get("type") {
            Some(Value::String(t)) if matches!(t.as_str(), "string" | "number" | "boolean") => {
                Some(t.as_str())
            }
            Some(Value::String(t)) => {
                errors.push(format!(
                    "contentSchema.{key}.type: unknown type `{t}`; expected 'string', 'number', or 'boolean'"
                ));
                None
            }
            Some(_) => {
                errors.push(format!(
                    "contentSchema.{key}.type: must be one of 'string', 'number', or 'boolean'"
                ));
                None
            }
            None => {
                errors.push(format!("contentSchema.{key}.type: required"));
                None
            }
        };
        match obj.get("label") {
            Some(Value::String(_)) => {}
            Some(_) => errors.push(format!("contentSchema.{key}.label: must be a string")),
            None => errors.push(format!("contentSchema.{key}.label: required")),
        }
        if let Some(required) = obj.get("required") {
            if !required.is_boolean() {
                errors.push(format!("contentSchema.{key}.required: must be a boolean"));
            }
        }
        if let Some(default) = obj.get("default") {
            // `z.union([z.string(), z.number(), z.boolean()])` (:18): null,
            // arrays, and objects reject outright.
            let js_type = match default {
                Value::String(_) => Some("string"),
                Value::Number(_) => Some("number"),
                Value::Bool(_) => Some("boolean"),
                _ => None,
            };
            match (js_type, declared_type) {
                (None, _) => errors.push(format!(
                    "contentSchema.{key}.default: must be a string, number, or boolean"
                )),
                // :19-25 refine — message verbatim.
                (Some(js), Some(declared)) if js != declared => errors.push(format!(
                    "contentSchema.{key}.default: default value must match the declared field type"
                )),
                _ => {}
            }
        }
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
    // Only VALID present schemas reach here (invalid ones were rejected at
    // scan); absent → key omitted, mirroring `undefined` elision (:167-169).
    if let ContentSchemaSlot::Present(cs) = &m.content_schema {
        obj.insert("contentSchema".into(), cs.clone());
    }
    if let Some(p) = &m.picker {
        obj.insert(
            "picker".into(),
            serde_json::to_value(p).unwrap_or(Value::Null),
        );
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
            m.insert("preferredRenderer".into(), json!(v.as_str()));
        }
        if let Some(v) = &self.scroll_input_policy {
            m.insert("scrollInputPolicy".into(), json!(v.as_str()));
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

    /// Extension dirs may be SYMLINKS (`t.is_dir() || t.is_symlink()` in `scan`).
    /// Unix-only helper: symlink creation on Windows requires privileges, so the
    /// symlink tests below are `#[cfg(unix)]`.
    #[cfg(unix)]
    fn symlink_dir(original: &Path, link: &Path) {
        std::os::unix::fs::symlink(original, link).unwrap();
    }

    /// Run `f` with a THREAD-LOCAL tracing subscriber that records every event
    /// `scan()` emits as one `LEVEL target field=value … message=…` line,
    /// returning (captured log text, f's result). Threads the assert on the
    /// diagnostics parity added for EXT-02 (legacy `Extension scan: …` warnings,
    /// extension-manager.ts:66-130). The subscriber is hand-rolled with
    /// `enabled() == true` rather than routed through tracing-subscriber's
    /// fmt/LevelFilter machinery, so per-callsite interest caching and any
    /// level/EnvFilter configuration can never silence the events under test.
    /// `with_default` (not a global init) keeps parallel unit tests isolated,
    /// and `scan()` is synchronous on this thread so its events all land here.
    fn capture_tracing<T>(f: impl FnOnce() -> T) -> (String, T) {
        use std::fmt::Write as _;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{span, Event, Metadata, Subscriber};

        // `%`-displayed values (`manifest_path = %p.display()` and friends)
        // arrive at `record_debug` via `DisplayValue`, whose `Debug` impl is a
        // passthrough to `Display` (tracing-core field.rs) — so they are
        // written RAW (no quotes) and path-substring asserts apply directly.
        struct FieldVisitor(String);
        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let _ = write!(self.0, " {}={:?}", field.name(), value);
            }
            fn record_str(&mut self, field: &Field, value: &str) {
                let _ = write!(self.0, " {}={}", field.name(), value);
            }
        }

        struct Capture {
            lines: Arc<Mutex<Vec<String>>>,
            next_span: AtomicU64,
        }
        impl Subscriber for Capture {
            fn enabled(&self, _: &Metadata<'_>) -> bool {
                true
            }
            fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
                span::Id::from_u64(self.next_span.fetch_add(1, Ordering::Relaxed))
            }
            fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
            fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
            fn event(&self, event: &Event<'_>) {
                let meta = event.metadata();
                let mut visitor = FieldVisitor(format!("{} {}", meta.level(), meta.target()));
                event.record(&mut visitor);
                self.lines.lock().unwrap().push(visitor.0);
            }
            fn enter(&self, _: &span::Id) {}
            fn exit(&self, _: &span::Id) {}
        }

        let lines = Arc::new(Mutex::new(Vec::new()));
        let subscriber = Capture {
            lines: Arc::clone(&lines),
            // `Id::from_u64` must never be 0 (NonZeroU64) — start at 1.
            next_span: AtomicU64::new(1),
        };
        let result = tracing::subscriber::with_default(subscriber, f);
        let captured = lines.lock().unwrap().join("\n");
        (captured, result)
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

    /// Same `name` as CLAUDE_MANIFEST (duplicate candidate), distinct label so
    /// the winning entry is identifiable.
    const CLAUDE_DUP_MANIFEST: &str = r#"{
      "name": "claude", "version": "9.9.9", "label": "Claude DUP",
      "description": "duplicate claude entry from a later root", "category": "cli",
      "cli": { "command": "claude-dup" }
    }"#;

    const MINI_VALID_MANIFEST: &str = r#"{
      "name": "mini-cli", "version": "1.0.0", "label": "Mini CLI",
      "description": "minimal valid cli manifest", "category": "cli",
      "cli": { "command": "mini" }
    }"#;

    /// Missing the required `label` field — schema-shape reject (legacy zod
    /// `invalid manifest`, extension-manager.ts:104-110).
    const MISSING_LABEL_MANIFEST: &str = r#"{
      "name": "no-label", "version": "1.0.0",
      "description": "missing required label", "category": "cli",
      "cli": { "command": "nolabel" }
    }"#;

    /// `category: "cli"` without a `cli` block — refinement reject
    /// (`validate_manifest`, mirroring extension-manifest.ts:96-103).
    const CLI_WITHOUT_BLOCK_MANIFEST: &str = r#"{
      "name": "cli-no-block", "version": "1.0.0", "label": "No Block",
      "description": "cli category but no cli block", "category": "cli"
    }"#;

    const UNKNOWN_CATEGORY_MANIFEST: &str = r#"{
      "name": "weird-cat", "version": "1.0.0", "label": "Weird",
      "description": "unknown category", "category": "widget"
    }"#;

    // ── EXT-01 strict-schema fixtures (mirror test/unit/server/extension-manifest.test.ts) ──

    const VALID_SERVER_MANIFEST: &str = r#"{
      "name": "test-server-ext", "version": "0.1.0", "label": "Test Server Extension",
      "description": "A test server extension", "category": "server",
      "server": { "command": "node", "args": ["dist/index.js"],
        "readyPattern": "Listening on", "readyTimeout": 10000, "singleton": true }
    }"#;

    const VALID_CLIENT_MANIFEST: &str = r#"{
      "name": "test-client-ext", "version": "1.0.0", "label": "Test Client Extension",
      "description": "A test client extension", "category": "client",
      "client": { "entry": "./dist/index.html" }
    }"#;

    /// Client extension with every optional field (icon/url/contentSchema/
    /// picker), mirroring the legacy acceptance cases at
    /// extension-manifest.test.ts:186-207 and :433-451.
    const NOTES_CLIENT_MANIFEST: &str = r#"{
      "name": "notes", "version": "2.0.0", "label": "Notes",
      "description": "client pane with every optional field", "category": "client",
      "icon": "icon.svg", "url": "/notes/{{runId}}",
      "contentSchema": {
        "runId": { "type": "string", "label": "Run ID", "required": true },
        "count": { "type": "number", "label": "Count", "default": 5 },
        "verbose": { "type": "boolean", "label": "Verbose", "default": false }
      },
      "picker": { "shortcut": "N", "group": "tools" },
      "client": { "entry": "./dist/index.html" }
    }"#;

    /// Typo'd top-level key — `z.strictObject` reject (extension-manifest.ts:81-95).
    const TYPO_KEY_MANIFEST: &str = r#"{
      "name": "typo", "version": "1.0.0", "label": "Typo",
      "description": "unknown top-level key", "descripton": "typo", "category": "cli",
      "cli": { "command": "typo" }
    }"#;

    /// Empty required string — `z.string().min(1)` reject (:84).
    const EMPTY_LABEL_MANIFEST: &str = r#"{
      "name": "empty-label", "version": "1.0.0", "label": "",
      "description": "empty label", "category": "cli",
      "cli": { "command": "emptylabel" }
    }"#;

    /// `contentSchema` default whose JS typeof mismatches the declared type
    /// (the refine at :19-25).
    const BAD_CONTENT_DEFAULT_MANIFEST: &str = r#"{
      "name": "bad-default", "version": "1.0.0", "label": "Bad Default",
      "description": "contentSchema default mismatches declared type", "category": "client",
      "contentSchema": { "count": { "type": "number", "label": "Count", "default": "five" } },
      "client": { "entry": "./index.html" }
    }"#;

    /// Non-enum terminalBehavior value — `z.enum(['canvas'])` reject (:46).
    const BAD_RENDERER_MANIFEST: &str = r#"{
      "name": "bad-renderer", "version": "1.0.0", "label": "Bad Renderer",
      "description": "unknown preferredRenderer", "category": "cli",
      "cli": { "command": "webgl-app", "terminalBehavior": { "preferredRenderer": "webgl" } }
    }"#;

    /// `server` category without its `server` block (the refine at :96-103).
    const SERVER_WITHOUT_BLOCK_MANIFEST: &str = r#"{
      "name": "server-no-block", "version": "1.0.0", "label": "No Server Block",
      "description": "server category but no server block", "category": "server"
    }"#;

    /// `ExtensionManifestSchema.safeParse` (extension-manifest.ts:81-103):
    /// serde parse (shape + strictness) then the refine pass. Returns the
    /// parsed manifest or the combined diagnostics string.
    fn parse_manifest(json: &str) -> Result<ExtensionManifest, String> {
        let m: ExtensionManifest = serde_json::from_str(json).map_err(|e| e.to_string())?;
        validate_manifest(&m)?;
        Ok(m)
    }

    // ── EXT-01 strict-schema tests (mirror test/unit/server/extension-manifest.test.ts) ──

    #[test]
    fn valid_manifests_per_category_parse() {
        // Acceptance cases (extension-manifest.test.ts:49-76).
        let server = parse_manifest(VALID_SERVER_MANIFEST).unwrap();
        let s = server.server.as_ref().unwrap();
        assert_eq!(s.command, "node");
        assert_eq!(s.args, vec!["dist/index.js"]);
        assert_eq!(s.ready_pattern.as_deref(), Some("Listening on"));
        assert_eq!(s.ready_timeout, 10_000);
        assert!(s.singleton);

        let client = parse_manifest(VALID_CLIENT_MANIFEST).unwrap();
        assert_eq!(client.client.as_ref().unwrap().entry, "./dist/index.html");

        // permissionModeEnvVar / permissionModeValues (:60-61) — the legacy
        // acceptance case at extension-manifest.test.ts:77-101.
        let perm = parse_manifest(
            r#"{
          "name": "perm-cli", "version": "1.0.0", "label": "Perm CLI",
          "description": "cli manifest with the permission-mode env mapping", "category": "cli",
          "cli": { "command": "opencode",
            "resumeArgs": ["--session", "{{sessionId}}"],
            "createSessionArgs": ["--session-id", "{{sessionId}}"],
            "modelArgs": ["--model", "{{model}}"],
            "sandboxArgs": ["--sandbox", "{{sandbox}}"],
            "permissionModeArgs": ["--permission-mode", "{{permissionMode}}"],
            "permissionModeEnvVar": "AGENT_PERMISSION_MODE",
            "permissionModeValues": { "plan": "{\"edit\":\"ask\",\"bash\":\"ask\"}" },
            "supportsPermissionMode": true, "supportsModel": true, "supportsSandbox": true }
        }"#,
        )
        .unwrap();
        let cli = perm.cli.as_ref().unwrap();
        assert_eq!(
            cli.permission_mode_env_var.as_deref(),
            Some("AGENT_PERMISSION_MODE")
        );
        assert_eq!(
            cli.permission_mode_values.as_ref().unwrap()["plan"],
            "{\"edit\":\"ask\",\"bash\":\"ask\"}"
        );
        let create_session_args = cli.create_session_args.as_ref().unwrap();
        assert_eq!(create_session_args, &["--session-id", "{{sessionId}}"]);
    }

    #[test]
    fn server_config_zod_defaults_materialize() {
        // :37/:40/:42 (legacy defaults tests, extension-manifest.test.ts:275-335).
        let m = parse_manifest(
            r#"{
          "name": "srv", "version": "1.0.0", "label": "Srv",
          "description": "minimal server manifest", "category": "server",
          "server": { "command": "node" }
        }"#,
        )
        .unwrap();
        let s = m.server.as_ref().unwrap();
        assert!(s.args.is_empty(), "args defaults to [] (:37)");
        assert_eq!(
            s.ready_timeout, 10_000,
            "readyTimeout defaults to 10000 (:40)"
        );
        assert!(s.singleton, "singleton defaults to true (:42)");
        assert!(s.env.is_none());
        assert!(s.ready_pattern.is_none());
        assert!(s.health_check.is_none());

        // Explicit values win; singleton may be explicitly false (:307-321).
        let m = parse_manifest(
            r#"{
          "name": "srv2", "version": "1.0.0", "label": "Srv2",
          "description": "server manifest with explicit overrides", "category": "server",
          "server": { "command": "node", "readyTimeout": 2500, "singleton": false }
        }"#,
        )
        .unwrap();
        let s = m.server.as_ref().unwrap();
        assert_eq!(s.ready_timeout, 2500);
        assert!(!s.singleton);
    }

    #[test]
    fn strict_objects_reject_unknown_keys_with_named_diagnostics() {
        // `z.strictObject` at every level (:81/:31/:35/:45/:50/:72/:14). Every
        // diagnostic NAMES the stray key (zod's `Unrecognized key(s) in object`).
        let err = parse_manifest(TYPO_KEY_MANIFEST).unwrap_err();
        assert!(
            err.contains("descripton"),
            "top-level typo named, got: {err}"
        );

        let cases: &[(&str, &str)] = &[
            // (manifest JSON, stray key the diagnostic must name)
            (
                r#"{ "name": "a", "version": "1", "label": "A", "description": "d",
                   "category": "client", "client": { "entry": "./i.html", "entery": "oops" } }"#,
                "entery",
            ),
            (
                r#"{ "name": "b", "version": "1", "label": "B", "description": "d",
                   "category": "server", "server": { "command": "node", "comand": "oops" } }"#,
                "comand",
            ),
            (
                r#"{ "name": "c", "version": "1", "label": "C", "description": "d",
                   "category": "cli", "cli": { "command": "x", "envVars": "X" } }"#,
                "envVars",
            ),
            (
                r#"{ "name": "d", "version": "1", "label": "D", "description": "d",
                   "category": "cli", "cli": { "command": "x",
                     "terminalBehavior": { "renderer": "canvas" } } }"#,
                "renderer",
            ),
            (
                r#"{ "name": "e", "version": "1", "label": "E", "description": "d",
                   "category": "cli", "picker": { "shortcuts": "N" },
                   "cli": { "command": "x" } }"#,
                "shortcuts",
            ),
            (
                r#"{ "name": "f", "version": "1", "label": "F", "description": "d",
                   "category": "client", "client": { "entry": "./i.html" },
                   "contentSchema": { "runId": { "type": "string", "label": "Run", "bgcolor": "red" } } }"#,
                "bgcolor",
            ),
        ];
        for &(json, key) in cases {
            let err = parse_manifest(json)
                .err()
                .unwrap_or_else(|| panic!("stray key `{key}` must reject"));
            assert!(err.contains(key), "stray key `{key}` named, got: {err}");
        }
    }

    #[test]
    fn min1_identity_and_block_strings_reject() {
        // Top-level identity strings (:82-85).
        let err = parse_manifest(EMPTY_LABEL_MANIFEST).unwrap_err();
        assert!(err.contains("label"), "empty label diagnosed, got: {err}");
        for &(field, json) in [
            ("name", r#"{ "name": "", "version": "1", "label": "L", "description": "d", "category": "cli", "cli": { "command": "x" } }"#),
            ("version", r#"{ "name": "n", "version": "", "label": "L", "description": "d", "category": "cli", "cli": { "command": "x" } }"#),
            ("description", r#"{ "name": "n", "version": "1", "label": "L", "description": "", "category": "cli", "cli": { "command": "x" } }"#),
        ]
        .iter()
        {
            let err = parse_manifest(json).unwrap_err();
            assert!(err.contains(field), "empty {field} diagnosed, got: {err}");
        }
        // Per-block min(1) strings (:32/:36/:51).
        for &(field, json) in [
            ("client.entry", r#"{ "name": "n", "version": "1", "label": "L", "description": "d", "category": "client", "client": { "entry": "" } }"#),
            ("server.command", r#"{ "name": "n", "version": "1", "label": "L", "description": "d", "category": "server", "server": { "command": "" } }"#),
            ("cli.command", r#"{ "name": "n", "version": "1", "label": "L", "description": "d", "category": "cli", "cli": { "command": "" } }"#),
        ]
        .iter()
        {
            let err = parse_manifest(json).unwrap_err();
            assert!(err.contains(field), "empty {field} diagnosed, got: {err}");
        }
    }

    #[test]
    fn category_must_carry_exactly_its_own_config_block() {
        // The coupling refine at :96-103 — message verbatim.
        const MSG: &str = "category must have exactly its own config block (no others)";
        for &json in [
            CLI_WITHOUT_BLOCK_MANIFEST,
            SERVER_WITHOUT_BLOCK_MANIFEST,
            r#"{ "name": "cnb", "version": "1", "label": "CNB", "description": "d",
               "category": "client" }"#,
            r#"{ "name": "mismatch", "version": "1", "label": "MM", "description": "d",
               "category": "cli", "client": { "entry": "./i.html" } }"#,
        ]
        .iter()
        {
            let err = parse_manifest(json).unwrap_err();
            assert!(err.contains(MSG), "coupling refine fired, got: {err}");
        }
        // Unknown category: zod effects SKIP the refine when the base parse
        // fails, so only the enum error appears — never the coupling message.
        let err = parse_manifest(UNKNOWN_CATEGORY_MANIFEST).unwrap_err();
        assert!(
            err.contains("widget"),
            "bad category value named, got: {err}"
        );
        assert!(
            !err.contains(MSG),
            "refine skipped on base-parse failure, got: {err}"
        );
    }

    #[test]
    fn content_schema_field_rules_and_default_type_refine() {
        // Full acceptance case (extension-manifest.test.ts:433-451).
        parse_manifest(NOTES_CLIENT_MANIFEST).unwrap();

        // default-matches-type refine (:19-25) — message verbatim.
        let err = parse_manifest(BAD_CONTENT_DEFAULT_MANIFEST).unwrap_err();
        assert!(
            err.contains("default value must match the declared field type"),
            "got: {err}"
        );

        // Invalid field type (:15) and non-string label (:16).
        let bad_type = parse_manifest(
            r#"{ "name": "bt", "version": "1", "label": "BT",
          "description": "bad contentSchema field type", "category": "client",
          "contentSchema": { "n": { "type": "integer", "label": "N" } },
          "client": { "entry": "./i.html" } }"#,
        )
        .unwrap_err();
        assert!(bad_type.contains("contentSchema.n.type"), "got: {bad_type}");

        let bad_label = parse_manifest(
            r#"{ "name": "bl", "version": "1", "label": "BL",
          "description": "non-string contentSchema label", "category": "client",
          "contentSchema": { "n": { "type": "string", "label": 7 } },
          "client": { "entry": "./i.html" } }"#,
        )
        .unwrap_err();
        assert!(
            bad_label.contains("contentSchema.n.label"),
            "got: {bad_label}"
        );
    }

    #[test]
    fn enums_and_ready_timeout_bounds_reject() {
        // Non-enum terminalBehavior values (:46-47) fail at the serde layer.
        let err = parse_manifest(BAD_RENDERER_MANIFEST).unwrap_err();
        assert!(err.contains("webgl"), "bad variant named, got: {err}");
        let bad_scroll = r#"{ "name": "bs", "version": "1", "label": "BS",
          "description": "bad scrollInputPolicy", "category": "cli",
          "cli": { "command": "x", "terminalBehavior": { "scrollInputPolicy": "smooth" } } }"#;
        assert!(
            parse_manifest(bad_scroll).is_err(),
            "non-enum scrollInputPolicy rejects"
        );

        // readyTimeout: zero hits the positivity rule (:40); negative and
        // fractional values fail u64 deserialization.
        let zero = parse_manifest(
            r#"{ "name": "z", "version": "1", "label": "Z",
          "description": "zero readyTimeout", "category": "server",
          "server": { "command": "node", "readyTimeout": 0 } }"#,
        )
        .unwrap_err();
        assert!(zero.contains("readyTimeout"), "got: {zero}");
        assert!(
            parse_manifest(
                r#"{ "name": "n", "version": "1", "label": "N",
              "description": "negative readyTimeout", "category": "server",
              "server": { "command": "node", "readyTimeout": -5 } }"#
            )
            .is_err(),
            "negative readyTimeout rejects"
        );
        assert!(
            parse_manifest(
                r#"{ "name": "f", "version": "1", "label": "F",
              "description": "fractional readyTimeout", "category": "server",
              "server": { "command": "node", "readyTimeout": 1.5 } }"#
            )
            .is_err(),
            "fractional readyTimeout rejects"
        );
    }

    #[test]
    fn scan_registers_valid_per_category_and_diagnoses_every_invalid_class() {
        // Unit mirror of the checklist's seeding contract: one valid manifest per
        // category plus one specimen per invalid class. Only the valid ones
        // register, registry fields match the fixture, and every invalid
        // specimen is DIAGNOSED without crashing discovery.
        let root = tmp();
        write_manifest(&root, "mini", MINI_VALID_MANIFEST);
        write_manifest(&root, "notes", NOTES_CLIENT_MANIFEST);
        write_manifest(&root, "srv", VALID_SERVER_MANIFEST);
        write_manifest(&root, "typo", TYPO_KEY_MANIFEST);
        write_manifest(&root, "empty", EMPTY_LABEL_MANIFEST);
        write_manifest(&root, "bad-default", BAD_CONTENT_DEFAULT_MANIFEST);
        write_manifest(&root, "bad-renderer", BAD_RENDERER_MANIFEST);
        write_manifest(&root, "no-block", SERVER_WITHOUT_BLOCK_MANIFEST);

        let (logs, reg) = capture_tracing(|| ExtensionRegistry::scan(std::slice::from_ref(&root)));
        let names: Vec<&str> = reg
            .entries
            .iter()
            .map(|e| e.manifest.name.as_str())
            .collect();
        // scan() sorts subdir names, so valid registration order is mini, notes, srv.
        assert_eq!(
            names,
            ["mini-cli", "notes", "test-server-ext"],
            "one valid manifest per category; every invalid class skipped"
        );

        // Every registry field matches the fixture (notes client entry).
        let entries = reg.to_client_registry();
        let notes = entries
            .iter()
            .find(|e| e["name"] == json!("notes"))
            .unwrap();
        assert_eq!(notes["version"], json!("2.0.0"));
        assert_eq!(notes["label"], json!("Notes"));
        assert_eq!(
            notes["description"],
            json!("client pane with every optional field")
        );
        assert_eq!(notes["category"], json!("client"));
        assert_eq!(notes["serverRunning"], json!(false));
        assert_eq!(notes["iconUrl"], json!("/api/extensions/notes/icon"));
        assert_eq!(notes["url"], json!("/notes/{{runId}}"));
        assert_eq!(
            notes["picker"],
            json!({ "shortcut": "N", "group": "tools" })
        );
        // contentSchema echoes bit-for-bit (client_entry keeps the raw Value).
        assert_eq!(
            notes["contentSchema"],
            json!({
              "runId": { "type": "string", "label": "Run ID", "required": true },
              "count": { "type": "number", "label": "Count", "default": 5 },
              "verbose": { "type": "boolean", "label": "Verbose", "default": false }
            })
        );

        // Useful diagnostics for every invalid specimen; discovery completes.
        assert_eq!(
            logs.matches("extension.scan.invalid_manifest").count(),
            5,
            "typo + empty + bad-default + bad-renderer + no-block, got:\n{logs}"
        );
        assert!(
            logs.contains("descripton"),
            "unknown-key diagnostic names the typo, got:\n{logs}"
        );
        assert!(
            logs.contains("default value must match the declared field type"),
            "refine diagnostic carried to the log, got:\n{logs}"
        );
        assert!(logs.contains("extension.scan.complete"), "got:\n{logs}");

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

    #[cfg(unix)]
    #[test]
    fn scan_accepts_symlinked_dirs_and_skips_dangling_links() {
        // Symlinked extension entries are discovered exactly like real dirs
        // (`entry.isDirectory() || entry.isSymbolicLink()`, extension-manager.ts:80-81
        // → `t.is_dir() || t.is_symlink()` above), INCLUDING links whose targets
        // live outside the scan root — the `outside` dir here stands in for one.
        let outside = tmp();
        write_manifest(&outside, "real-opencode", OPENCODE_MANIFEST);
        let root = tmp();
        symlink_dir(
            &outside.join("real-opencode"),
            &root.join("linked-opencode"),
        );
        // A dangling symlink is silently NOT an extension: `existsSync(manifestPath)`
        // follows links and fails (:86) — mirrored here by `manifest_path.exists()`.
        symlink_dir(&outside.join("no-such-target"), &root.join("dangling"));

        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        assert_eq!(
            reg.entries.len(),
            1,
            "symlinked dir discovered, dangling link skipped"
        );
        assert_eq!(reg.entries[0].manifest.name, "opencode");

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_duplicate_in_later_root_loses_first_wins() {
        // First-wins dedup keyed on `manifest.name` (extension-manager.ts:115-121)
        // holds when the LATER root's candidate arrives via symlink — and the skip
        // is logged with the original's { name, path, existingPath } fields.
        let root1 = tmp();
        write_manifest(&root1, "claude-code", CLAUDE_MANIFEST);
        let outside = tmp();
        write_manifest(&outside, "claude-elsewhere", CLAUDE_DUP_MANIFEST);
        let root2 = tmp();
        symlink_dir(
            &outside.join("claude-elsewhere"),
            &root2.join("claude-dup-link"),
        );

        let (logs, reg) =
            capture_tracing(|| ExtensionRegistry::scan(&[root1.clone(), root2.clone()]));
        assert_eq!(reg.entries.len(), 1, "symlinked duplicate dropped");
        assert_eq!(
            reg.entries[0].manifest.label, "Claude CLI",
            "the FIRST root's entry wins"
        );
        assert!(
            logs.contains("extension.scan.duplicate_name"),
            "dup skip must be diagnosed (legacy :115-121 warn), got:\n{logs}"
        );
        assert!(logs.contains("existing_path="), "existingPath field");
        assert!(
            logs.contains(&root1.join("claude-code").display().to_string()),
            "existing_path points at the winner's dir, got:\n{logs}"
        );

        std::fs::remove_dir_all(&root1).ok();
        std::fs::remove_dir_all(&root2).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn invalid_manifests_are_skipped_with_parity_warnings() {
        // Each invalid class is skipped WITHOUT producing an entry, and each skip
        // is DIAGNOSED (legacy was silent in a previous port of this file — the
        // EXT-02 gap; legacy warnings at extension-manager.ts:91-119).
        let root = tmp();
        write_manifest(&root, "good", MINI_VALID_MANIFEST);
        // `invalid JSON in manifest` (:99-101):
        write_manifest(&root, "bad-json", "{ this is not json");
        // `invalid manifest` — schema-shape rejects (:104-110):
        write_manifest(&root, "missing-field", MISSING_LABEL_MANIFEST);
        // `invalid manifest` — refinement rejects (extension-manifest.ts:96-103):
        write_manifest(&root, "cli-no-block", CLI_WITHOUT_BLOCK_MANIFEST);
        write_manifest(&root, "unknown-cat", UNKNOWN_CATEGORY_MANIFEST);
        // Subdir without freshell.json — silently skipped in the original (:86),
        // so NO warning may fire for it here either.
        std::fs::create_dir_all(root.join("no-manifest")).unwrap();

        let (logs, reg) = capture_tracing(|| ExtensionRegistry::scan(std::slice::from_ref(&root)));

        let names: Vec<&str> = reg
            .entries
            .iter()
            .map(|e| e.manifest.name.as_str())
            .collect();
        assert_eq!(names, ["mini-cli"], "only the valid manifest registers");
        assert_eq!(
            logs.matches("extension.scan.invalid_json_in_manifest")
                .count(),
            1,
            "one JSON-parse warning (bad-json), got:\n{logs}"
        );
        assert_eq!(
            logs.matches("extension.scan.invalid_manifest").count(),
            3,
            "missing-field + cli-no-block + unknown-cat, got:\n{logs}"
        );
        assert!(
            !logs.contains("no-manifest"),
            "missing freshell.json is a SILENT skip (legacy :86), got:\n{logs}"
        );
        // `Extension scan complete` with { count, names } (:127-130).
        assert!(logs.contains("extension.scan.complete"), "got:\n{logs}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn client_registry_exposes_no_filesystem_paths_for_symlinked_entries() {
        // The serialized client registry must never reveal WHERE an extension
        // lives (`toClientRegistry`, extension-manager.ts:143-191, emits manifest
        // fields only) — even when the entry dir is a symlink whose TARGET is
        // outside the allowed scan root. `iconUrl` is an API route built from the
        // NAME (`/api/extensions/${encodeURIComponent(name)}/icon`, :160), never
        // a filesystem path.
        let outside = tmp();
        let icon_manifest = r#"{
          "name": "icon-ext", "version": "1.0.0", "label": "Icon Ext",
          "description": "client extension with an icon", "category": "client",
          "icon": "assets/icon.svg",
          "client": { "entry": "./dist/index.html" }
        }"#;
        write_manifest(&outside, "icon-extension", icon_manifest);
        let root = tmp();
        symlink_dir(
            &outside.join("icon-extension"),
            &root.join("linked-icon-ext"),
        );

        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
        assert_eq!(reg.entries.len(), 1);
        let entries = reg.to_client_registry();
        let e = &entries[0];
        assert_eq!(e["name"], json!("icon-ext"));
        assert_eq!(e["iconUrl"], json!("/api/extensions/icon-ext/icon"));
        assert!(e.get("path").is_none());
        assert!(e.get("dir").is_none());

        let serialized = serde_json::to_string(&entries).unwrap();
        assert!(
            !serialized.contains(root.to_str().unwrap()),
            "scan root path must not leak: {serialized}"
        );
        assert!(
            !serialized.contains(outside.to_str().unwrap()),
            "symlink target path (outside the allowed root) must not leak: {serialized}"
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
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
                },
            )
            .on(
                "which",
                &["codex"],
                CommandOutput {
                    exit_code: Some(1),
                    stdout: String::new(),
                    stderr: String::new(),
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

    /// Build a minimal `client`-category manifest with an optional raw
    /// `contentSchema` snippet (each name distinct — scan dedups by name). The
    /// `client` config block is included so these fixtures satisfy the
    /// category↔config-block coupling refine (extension-manifest.ts:96-103)
    /// and exercise ONLY the contentSchema gate.
    fn schema_manifest(name: &str, schema_json: Option<&str>) -> String {
        let schema = schema_json
            .map(|s| format!(r#", "contentSchema": {s}"#))
            .unwrap_or_default();
        format!(
            r#"{{ "name": "{name}", "version": "1.0.0", "label": "{name}", "description": "d", "category": "client", "client": {{ "entry": "./index.html" }}{schema} }}"#
        )
    }

    /// EXT-04: extension-scoped settings fields are TYPED
    /// (`extension-manifest.ts:14-28` — `type` ∈ string/number/boolean,
    /// required `label`, optional `required`/`default`). A manifest whose
    /// contentSchema satisfies the schema registers, and the schema reaches
    /// the client registry byte-IDENTICAL to the manifest source
    /// (`toClientRegistry`, extension-manager.ts:167-169) — the UI renders
    /// text/toggle fields from exactly these declarations, so no key may be
    /// dropped, renamed, or re-typed in transit.
    #[test]
    fn valid_content_schema_registers_and_passes_through_verbatim() {
        let root = tmp();
        let full_schema = r#"{
          "apiUrl": { "type": "string", "label": "API URL", "required": true, "default": "http://localhost:3000" },
          "pollSeconds": { "type": "number", "label": "Poll interval (s)", "default": 30 },
          "verbose": { "type": "boolean", "label": "Verbose logging", "default": false },
          "optionalNote": { "type": "string", "label": "Note" }
        }"#;
        write_manifest(&root, "notes", &schema_manifest("notes", Some(full_schema)));
        // An empty record is a valid schema (`z.record` of zero entries).
        write_manifest(&root, "empty", &schema_manifest("empty", Some("{}")));
        // An ABSENT contentSchema key stays absent on the wire.
        write_manifest(&root, "none", &schema_manifest("none", None));

        let (logs, reg) = capture_tracing(|| ExtensionRegistry::scan(std::slice::from_ref(&root)));
        assert_eq!(
            reg.entries.len(),
            3,
            "all three manifests valid, got:\n{logs}"
        );
        assert!(
            !logs.contains("extension.scan.invalid_manifest"),
            "no invalid manifest here, got:\n{logs}"
        );

        let entries = reg.to_client_registry();
        let by_name = |n: &str| {
            entries
                .iter()
                .find(|e| e["name"] == json!(n))
                .unwrap()
                .clone()
        };
        let expected: Value = serde_json::from_str(full_schema).unwrap();
        assert_eq!(
            by_name("notes")["contentSchema"],
            expected,
            "typed fields pass through verbatim (string/number/boolean + defaults)"
        );
        assert_eq!(by_name("empty")["contentSchema"], json!({}));
        assert!(
            by_name("none").get("contentSchema").is_none(),
            "absent key is omitted, mirroring the original's `undefined` elision"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// EXT-04: a manifest whose contentSchema violates the field schema is
    /// rejected WHOLE at scan — the original's single
    /// `ExtensionManifestSchema.safeParse` gate (extension-manager.ts:104-110)
    /// — and is therefore never served to the picker and never launches.
    /// Before this, the port carried the block as an opaque `Value` and
    /// registered these manifests anyway.
    #[test]
    fn invalid_content_schema_rejects_the_whole_manifest_with_parity_warning() {
        let root = tmp();
        write_manifest(&root, "good", MINI_VALID_MANIFEST);
        let cases: [(&str, &str); 9] = [
            // `type` outside the string/number/boolean enum.
            ("bad-type-enum", r#"{"f": {"type": "date", "label": "F"}}"#),
            // Missing the required `label` string.
            ("bad-missing-label", r#"{"f": {"type": "string"}}"#),
            // `default` must match the declared type (the `.refine`).
            (
                "bad-default-mismatch",
                r#"{"f": {"type": "string", "label": "F", "default": 42}}"#,
            ),
            (
                "bad-default-null",
                r#"{"f": {"type": "number", "label": "F", "default": null}}"#,
            ),
            // `required` is boolean-or-absent.
            (
                "bad-required",
                r#"{"f": {"type": "boolean", "label": "F", "required": "yes"}}"#,
            ),
            // The field object is `.strictObject` — unknown keys reject.
            (
                "bad-unknown-key",
                r#"{"f": {"type": "string", "label": "F", "bogus": 1}}"#,
            ),
            // A field must be an object.
            ("bad-field-nonobject", r#"{"f": "string"}"#),
            // contentSchema itself must be a record.
            ("bad-schema-nonobject", r#"[{"type": "string"}]"#),
            // `.optional()` accepts ABSENT, not explicit `null`.
            ("bad-schema-null", "null"),
        ];
        for (name, schema) in &cases {
            write_manifest(&root, name, &schema_manifest(name, Some(schema)));
        }

        let (logs, reg) = capture_tracing(|| ExtensionRegistry::scan(std::slice::from_ref(&root)));
        let names: Vec<&str> = reg
            .entries
            .iter()
            .map(|e| e.manifest.name.as_str())
            .collect();
        assert_eq!(
            names,
            ["mini-cli"],
            "every contentSchema violation rejects the whole manifest, got:\n{logs}"
        );
        assert_eq!(
            logs.matches("extension.scan.invalid_manifest").count(),
            cases.len(),
            "one `invalid manifest` warning per rejected manifest (legacy :104-110), got:\n{logs}"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
