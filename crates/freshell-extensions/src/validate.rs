//! The strict manifest validator — a hand-written `serde_json::Value` walker
//! replicating zod-4.3.6 semantics exactly (see crate docs and
//! `docs/plans/df1/EXT-01.md` DC-4 for the pinned rule set).
//!
//! Design calls baked in here:
//! * DC-2 — validate from `Value`, never derive-`Deserialize` (duplicate JSON
//!   keys must last-win like `JSON.parse`; literal `null` for `.optional()`
//!   fields must REJECT, not coerce to absent).
//! * DC-3 — issues are zod's flattened `{code, path, message}` triples with
//!   byte-exact 4.3.6 message text (the legacy `.format()` log nesting is
//!   intentionally not reproduced; content parity, shape flattened).
//! * DC-4 — emission order: object members in SCHEMA-DEFINITION order,
//!   `unrecognized_keys` last within each object, refines after their object's
//!   base issues; refine gating: refines run iff their subtree accumulated no
//!   ABORTING issue (invalid_type | invalid_value | invalid_union |
//!   unrecognized_keys); check codes (too_small | too_big) never gate.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::issue::{IssueCode, ManifestError, ManifestIssue, PathSeg};
use crate::manifest::{
    Category, CliConfig, ClientConfig, ContentSchemaField, DefaultValue, ExtensionManifest,
    FieldType, PickerConfig, PreferredRenderer, ScrollInputPolicy, ServerConfig, TerminalBehavior,
};

/// Parse+validate manifest file TEXT — the full legacy flow
/// (`JSON.parse(raw)` → `ExtensionManifestSchema.safeParse(json)`) in one
/// call. `serde_json::from_str::<Value>` matches `JSON.parse` on duplicate
/// keys (last wins) and number rounding (IEEE-754 nearest).
pub fn parse_manifest(json_text: &str) -> Result<ExtensionManifest, ManifestError> {
    let value: Value =
        serde_json::from_str(json_text).map_err(|e| ManifestError::InvalidJson(e.to_string()))?;
    validate_manifest(&value).map_err(ManifestError::Invalid)
}

/// Validate an already-parsed JSON value — legacy `safeParse(json)`.
pub fn validate_manifest(value: &Value) -> Result<ExtensionManifest, Vec<ManifestIssue>> {
    Validator::new().validate(value)
}

// ──────────────────────────────────────────────────────────────
// Messages (byte-exact zod 4.3.6 text — pinned by the oracle fixture)
// ──────────────────────────────────────────────────────────────

fn received_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn msg_invalid_type(expected: &str, received: &str) -> String {
    format!("Invalid input: expected {expected}, received {received}")
}

const MSG_FIELD_DEFAULT_TYPE: &str = "default value must match the declared field type";
const MSG_CATEGORY_BLOCK: &str = "category must have exactly its own config block (no others)";

/// JS-safe-int bounds from zod-4 `.int()` (Number.MAX_SAFE_INTEGER).
const SAFE_INT_MIN_F: f64 = -9007199254740991.0;
const SAFE_INT_MAX_F: f64 = 9007199254740991.0;

// ── JS object enumeration semantics (verified against zod 4.3.6 behavior) ──
//
// Two JS object-key behaviors are observable in zod's output and must be
// reproduced when validating `serde_json::Value` objects:
//
// 1. **JS own-key enumeration order** (`for…in` / `Reflect.ownKeys` over the
//    plain objects `JSON.parse` produces): canonical array-index keys FIRST in
//    ascending numeric order, then the remaining string keys in insertion
//    order. Affects the `unrecognized_keys` message member order and the
//    iteration/output order of records (contentSchema, env,
//    permissionModeValues).
// 2. **`__proto__` is silently skipped in `z.record(...)` values**
//    (`$ZodRecord` explicitly continues on it) but NOT in strict objects
//    (there it surfaces as a normal `unrecognized_keys` member). Skipping
//    means: never validated, never kept in output.

/// A canonical JS array-index key: all ASCII digits, no leading zeros (the
/// `ToString(ToNumber(k)) === k` canonicality rule), value < 2^32-1.
fn js_array_index(k: &str) -> Option<u32> {
    if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = k.parse().ok()?;
    if n >= 4294967295 || n.to_string() != k {
        return None;
    }
    Some(n as u32)
}

/// JS own-key enumeration order over a parsed JSON object.
fn js_ordered_keys(m: &Map<String, Value>) -> Vec<&str> {
    let mut indexed: Vec<(u32, &str)> = Vec::new();
    let mut rest: Vec<&str> = Vec::new();
    for k in m.keys() {
        match js_array_index(k) {
            Some(n) => indexed.push((n, k)),
            None => rest.push(k),
        }
    }
    indexed.sort_by_key(|(n, _)| *n);
    indexed.into_iter().map(|(_, k)| k).chain(rest).collect()
}

// ──────────────────────────────────────────────────────────────
// The validator
// ──────────────────────────────────────────────────────────────

struct Validator {
    issues: Vec<ManifestIssue>,
    /// Path cursor: the shared prefix for every pushed issue.
    path: Vec<PathSeg>,
}

/// Tri-state result of checking one property: `Good(v)` | `Bad` (issue(s)
/// already pushed) | `Absent` (key not in the object — valid for optionals
/// only). Required fields map `Absent` to `Bad` at their call sites.
enum Check<T> {
    Good(T),
    Bad,
    Absent,
}

impl<T> Check<T> {
    fn is_bad(&self) -> bool {
        matches!(self, Check::Bad)
    }
}

macro_rules! bad {
    ($($c:expr),+ $(,)?) => {
        $($c.is_bad())||+
    };
}

impl Validator {
    fn new() -> Self {
        Validator {
            issues: Vec::new(),
            path: Vec::new(),
        }
    }

    fn push(&mut self, code: IssueCode, message: String) {
        self.issues.push(ManifestIssue {
            code,
            path: self.path.clone(),
            message,
        });
    }

    /// True iff the issues emitted since `mark` contain an aborting issue
    /// (DC-4.2 — the refine-gating rule).
    fn aborted_since(&self, mark: usize) -> bool {
        self.issues[mark..].iter().any(|i| i.code.is_aborting())
    }

    fn validate(mut self, value: &Value) -> Result<ExtensionManifest, Vec<ManifestIssue>> {
        let Value::Object(obj) = value else {
            self.push(
                IssueCode::InvalidType,
                msg_invalid_type("object", received_name(value)),
            );
            return Err(self.issues);
        };

        // Member validation in SCHEMA-DEFINITION order
        // (extension-manifest.ts:81-103): property issues never follow input
        // member order (DC-4.1).
        let name = self.req_str(obj, "name", Min::One);
        let version = self.req_str(obj, "version", Min::One);
        let label = self.req_str(obj, "label", Min::One);
        let description = self.req_str(obj, "description", Min::One);
        let category = self.req_enum(obj, "category", Category::OPTIONS);
        let icon = self.opt_str(obj, "icon");
        let url = self.opt_str(obj, "url");
        let content_schema = self.opt_content_schema(obj, "contentSchema");
        let picker = self.opt_picker(obj, "picker");
        let client = self.opt_client(obj, "client");
        let server = self.opt_server(obj, "server");
        let cli = self.opt_cli(obj, "cli");

        // strictObject: any other key is rejected (DC-4.1: after members).
        self.unrecognized(
            obj,
            &[
                "name",
                "version",
                "label",
                "description",
                "category",
                "icon",
                "url",
                "contentSchema",
                "picker",
                "client",
                "server",
                "cli",
            ],
        );

        // The category↔block refine (extension-manifest.ts:96-103), gated by
        // the abort rule (DC-4.2) over the WHOLE manifest subtree. Presence
        // is best-effort RAW-KEY presence: a block that produced only
        // check-level failures (e.g. empty command) still counts as present.
        if !self.aborted_since(0) {
            let present: Vec<&str> = ["client", "server", "cli"]
                .into_iter()
                .filter(|k| obj.contains_key(*k))
                .collect();
            let matches = present.len() == 1
                && matches!(&category, Check::Good(c) if present[0] == c.as_str());
            if !matches {
                self.push(IssueCode::Custom, MSG_CATEGORY_BLOCK.into());
            }
        }

        if !self.issues.is_empty() {
            return Err(self.issues);
        }

        // Invariant: with zero issues every required member is Good and every
        // optional resolved to Absent or Good — anything else is a validator
        // bug, not a manifest problem, so panic loudly in that case.
        let unwrap = |c: Check<String>, field: &str| match c {
            Check::Good(v) => v,
            _ => unreachable!("zero-issue manifest must not have Bad/missing {field}"),
        };
        Ok(ExtensionManifest {
            name: unwrap(name, "name"),
            version: unwrap(version, "version"),
            label: unwrap(label, "label"),
            description: unwrap(description, "description"),
            category: match category {
                Check::Good(c) => c,
                _ => unreachable!("zero-issue manifest must have a valid category"),
            },
            icon: opt_out(icon),
            url: opt_out(url),
            content_schema: opt_out(content_schema),
            picker: opt_out(picker),
            client: opt_out(client),
            server: opt_out(server),
            cli: opt_out(cli),
        })
    }

    // ── Scalar property checkers ────────────────────────────────────────────

    /// `z.string()` with optional `.min(1)`. `min(1)` rejects only the EMPTY
    /// string; whitespace-only strings pass.
    fn str_prop(&mut self, obj: &Map<String, Value>, key: &str, min: Min) -> Check<String> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        self.path.push(PathSeg::Key(key.into()));
        let out = match v {
            Value::String(s) => {
                if min == Min::One && s.is_empty() {
                    self.push(
                        IssueCode::TooSmall,
                        "Too small: expected string to have >=1 characters".into(),
                    );
                    Check::Bad
                } else {
                    Check::Good(s.clone())
                }
            }
            other => {
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("string", received_name(other)),
                );
                Check::Bad
            }
        };
        self.path.pop();
        out
    }

    fn req_str(&mut self, obj: &Map<String, Value>, key: &str, min: Min) -> Check<String> {
        match self.str_prop(obj, key, min) {
            Check::Absent => {
                self.path.push(PathSeg::Key(key.into()));
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("string", "undefined"),
                );
                self.path.pop();
                Check::Bad
            }
            other => other,
        }
    }

    fn opt_str(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<String>> {
        match self.str_prop(obj, key, Min::Zero) {
            Check::Absent => Check::Absent,
            Check::Bad => Check::Bad,
            Check::Good(v) => Check::Good(Some(v)),
        }
    }

    /// `z.enum([...])`: zod-4 collapses missing AND wrong-type AND wrong-value
    /// to ONE `invalid_value` issue (probed + fixture-pinned; never
    /// invalid_type), with the single-option message form when there is one
    /// option.
    fn enum_prop<T: Copy>(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
        options: &[(&str, T)],
        required: bool,
    ) -> Check<T> {
        let Some(v) = obj.get(key) else {
            return if required {
                self.path.push(PathSeg::Key(key.into()));
                self.push(IssueCode::InvalidValue, msg_enum(options));
                self.path.pop();
                Check::Bad
            } else {
                Check::Absent
            };
        };
        if let Value::String(s) = v {
            if let Some((_, val)) = options.iter().find(|(name, _)| *name == s) {
                return Check::Good(*val);
            }
        }
        self.path.push(PathSeg::Key(key.into()));
        self.push(IssueCode::InvalidValue, msg_enum(options));
        self.path.pop();
        Check::Bad
    }

    fn req_enum<T: Copy>(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
        options: &[(&str, T)],
    ) -> Check<T> {
        self.enum_prop(obj, key, options, true)
    }

    fn opt_enum<T: Copy>(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
        options: &[(&str, T)],
    ) -> Check<Option<T>> {
        match self.enum_prop(obj, key, options, false) {
            Check::Absent => Check::Absent,
            Check::Bad => Check::Bad,
            Check::Good(v) => Check::Good(Some(v)),
        }
    }

    fn opt_bool(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<bool>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        match v {
            Value::Bool(b) => Check::Good(Some(*b)),
            other => {
                self.path.push(PathSeg::Key(key.into()));
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("boolean", received_name(other)),
                );
                self.path.pop();
                Check::Bad
            }
        }
    }

    /// `z.array(z.string())` — every non-string element reports at its
    /// numeric index (path `[..., key, idx]`).
    fn opt_str_array(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<Vec<String>>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        self.path.push(PathSeg::Key(key.into()));
        let out = match v {
            Value::Array(items) => {
                let mut acc = Vec::with_capacity(items.len());
                let mut ok = true;
                for (i, item) in items.iter().enumerate() {
                    match item {
                        Value::String(s) => acc.push(s.clone()),
                        other => {
                            self.path.push(PathSeg::Index(i as u32));
                            self.push(
                                IssueCode::InvalidType,
                                msg_invalid_type("string", received_name(other)),
                            );
                            self.path.pop();
                            ok = false;
                        }
                    }
                }
                if ok {
                    Check::Good(Some(acc))
                } else {
                    Check::Bad
                }
            }
            other => {
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("array", received_name(other)),
                );
                Check::Bad
            }
        };
        self.path.pop();
        out
    }

    /// `z.record(z.string(), z.string())` — non-objects report with zod's
    /// `record` expected-type word; bad values report at `[..., key, entry]`.
    /// Entries iterate in JS own-key order; `__proto__` is silently SKIPPED
    /// per `$ZodRecord` (never validated, never kept).
    fn opt_str_record(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
    ) -> Check<Option<IndexMap<String, String>>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        self.path.push(PathSeg::Key(key.into()));
        let out = match v {
            Value::Object(entries) => {
                let mut acc = IndexMap::with_capacity(entries.len());
                let mut ok = true;
                for k in js_ordered_keys(entries) {
                    if k == "__proto__" {
                        continue;
                    }
                    let entry = &entries[k];
                    match entry {
                        Value::String(s) => {
                            acc.insert(k.to_string(), s.clone());
                        }
                        other => {
                            self.path.push(PathSeg::Key(k.to_string()));
                            self.push(
                                IssueCode::InvalidType,
                                msg_invalid_type("string", received_name(other)),
                            );
                            self.path.pop();
                            ok = false;
                        }
                    }
                }
                if ok {
                    Check::Good(Some(acc))
                } else {
                    Check::Bad
                }
            }
            other => {
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("record", received_name(other)),
                );
                Check::Bad
            }
        };
        self.path.pop();
        out
    }

    /// `z.number().int().positive()` for `readyTimeout`. zod-4 `.int()` is
    /// JS-safe-int: non-number → invalid_type ("expected number");
    /// non-integral → invalid_type ("expected int", chain-aborting); integral
    /// but out of `±(2^53-1)` → too_small/too_big (ACCUMULATING with the
    /// positive check, which runs after).
    fn opt_ready_timeout(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<u64>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        self.path.push(PathSeg::Key(key.into()));
        let out = match v {
            Value::Number(n) => {
                let f = n.as_f64().expect("serde_json::Number is always f64-able");
                if f.fract() != 0.0 {
                    // Type/format failure: aborts the check chain (DC-4.3).
                    self.push(IssueCode::InvalidType, msg_invalid_type("int", "number"));
                    Check::Bad
                } else {
                    let mut ok = true;
                    if f < SAFE_INT_MIN_F {
                        self.push(
                            IssueCode::TooSmall,
                            "Too small: expected int to be >=-9007199254740991".into(),
                        );
                        ok = false;
                    } else if f > SAFE_INT_MAX_F {
                        self.push(
                            IssueCode::TooBig,
                            "Too big: expected int to be <=9007199254740991".into(),
                        );
                        ok = false;
                    }
                    // NaN is unreachable (serde_json never produces it), so
                    // `f <= 0.0` ≡ zod's `!(f > 0)` positivity failure.
                    if f <= 0.0 {
                        self.push(
                            IssueCode::TooSmall,
                            "Too small: expected number to be >0".into(),
                        );
                        ok = false;
                    }
                    if ok {
                        // f integral in 1..=2^53-1 fits u64 exactly.
                        Check::Good(Some(f as u64))
                    } else {
                        Check::Bad
                    }
                }
            }
            other => {
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("number", received_name(other)),
                );
                Check::Bad
            }
        };
        self.path.pop();
        out
    }

    // ── Object property checkers ────────────────────────────────────────────

    /// Shared strict-object prelude for optional sub-blocks: absent → Absent;
    /// non-object (incl. literal null — `.optional()` never accepts null) →
    /// invalid_type "expected object"; object → hands the map to `inner`.
    fn opt_object<T>(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
        inner: impl FnOnce(&mut Self, &Map<String, Value>) -> T,
    ) -> Check<Option<T>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        self.path.push(PathSeg::Key(key.into()));
        let out = match v {
            Value::Object(m) => Check::Good(Some(inner(self, m))),
            other => {
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("object", received_name(other)),
                );
                Check::Bad
            }
        };
        self.path.pop();
        out
    }

    /// strictObject tail: one `unrecognized_keys` issue listing every unknown
    /// key in JS own-key order (canonical array-index keys ascending, then
    /// insertion order — `for…in` over a `JSON.parse` object),
    /// singular/plural message forms. `__proto__` is NOT special here (it is
    /// a normal unrecognized key for strict objects).
    fn unrecognized(&mut self, obj: &Map<String, Value>, known: &[&str]) {
        let mut unknown: Vec<&str> = Vec::new();
        for k in js_ordered_keys(obj) {
            if !known.contains(&k) {
                unknown.push(k);
            }
        }
        match unknown.as_slice() {
            [] => {}
            [one] => self.push(
                IssueCode::UnrecognizedKeys,
                format!("Unrecognized key: \"{one}\""),
            ),
            many => {
                let list = many
                    .iter()
                    .map(|k| format!("\"{k}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                self.push(
                    IssueCode::UnrecognizedKeys,
                    format!("Unrecognized keys: {list}"),
                );
            }
        }
    }

    fn opt_picker(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<PickerConfig>> {
        self.opt_object(obj, key, |v, m| {
            // definition order: shortcut, group (extension-manifest.ts:72-75)
            let shortcut = v.opt_str(m, "shortcut");
            let group = v.opt_str(m, "group");
            v.unrecognized(m, &["shortcut", "group"]);
            if bad!(shortcut, group) {
                return None;
            }
            Some(PickerConfig {
                shortcut: opt_out(shortcut),
                group: opt_out(group),
            })
        })
        .into_flat()
    }

    fn opt_client(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<ClientConfig>> {
        self.opt_object(obj, key, |v, m| {
            let entry = v.req_str(m, "entry", Min::One);
            v.unrecognized(m, &["entry"]);
            match entry {
                Check::Good(entry) => Some(ClientConfig { entry }),
                _ => None,
            }
        })
        .into_flat()
    }

    fn opt_server(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<ServerConfig>> {
        self.opt_object(obj, key, |v, m| {
            // definition order (extension-manifest.ts:35-43)
            let command = v.req_str(m, "command", Min::One);
            let args = v.opt_str_array(m, "args");
            let env = v.opt_str_record(m, "env");
            let ready_pattern = v.opt_str(m, "readyPattern");
            let ready_timeout = v.opt_ready_timeout(m, "readyTimeout");
            let health_check = v.opt_str(m, "healthCheck");
            let singleton = v.opt_bool(m, "singleton");
            v.unrecognized(
                m,
                &[
                    "command",
                    "args",
                    "env",
                    "readyPattern",
                    "readyTimeout",
                    "healthCheck",
                    "singleton",
                ],
            );
            if bad!(
                command,
                args,
                env,
                ready_pattern,
                ready_timeout,
                health_check,
                singleton
            ) {
                return None;
            }
            let Check::Good(command) = command else {
                return None;
            };
            Some(ServerConfig {
                command,
                // zod defaults materialize here (extension-manifest.ts:37,40,42).
                args: opt_out(args).unwrap_or_default(),
                env: opt_out(env),
                ready_pattern: opt_out(ready_pattern),
                ready_timeout: opt_out(ready_timeout).unwrap_or(10000),
                health_check: opt_out(health_check),
                singleton: opt_out(singleton).unwrap_or(true),
            })
        })
        .into_flat()
    }

    fn opt_cli(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<CliConfig>> {
        self.opt_object(obj, key, |v, m| {
            // definition order (extension-manifest.ts:50-66)
            let command = v.req_str(m, "command", Min::One);
            let args = v.opt_str_array(m, "args");
            let env = v.opt_str_record(m, "env");
            let env_var = v.opt_str(m, "envVar");
            let resume_args = v.opt_str_array(m, "resumeArgs");
            let create_session_args = v.opt_str_array(m, "createSessionArgs");
            let model_args = v.opt_str_array(m, "modelArgs");
            let effort_args = v.opt_str_array(m, "effortArgs");
            let sandbox_args = v.opt_str_array(m, "sandboxArgs");
            let permission_mode_args = v.opt_str_array(m, "permissionModeArgs");
            let permission_mode_env_var = v.opt_str(m, "permissionModeEnvVar");
            let permission_mode_values = v.opt_str_record(m, "permissionModeValues");
            let supports_permission_mode = v.opt_bool(m, "supportsPermissionMode");
            let supports_model = v.opt_bool(m, "supportsModel");
            let supports_effort = v.opt_bool(m, "supportsEffort");
            let supports_sandbox = v.opt_bool(m, "supportsSandbox");
            let terminal_behavior = v
                .opt_object(m, "terminalBehavior", |v, m| {
                    let preferred_renderer =
                        v.opt_enum(m, "preferredRenderer", PreferredRenderer::OPTIONS);
                    let scroll_input_policy =
                        v.opt_enum(m, "scrollInputPolicy", ScrollInputPolicy::OPTIONS);
                    v.unrecognized(m, &["preferredRenderer", "scrollInputPolicy"]);
                    if bad!(preferred_renderer, scroll_input_policy) {
                        return None;
                    }
                    Some(TerminalBehavior {
                        preferred_renderer: opt_out(preferred_renderer),
                        scroll_input_policy: opt_out(scroll_input_policy),
                    })
                })
                .into_flat();
            v.unrecognized(
                m,
                &[
                    "command",
                    "args",
                    "env",
                    "envVar",
                    "resumeArgs",
                    "createSessionArgs",
                    "modelArgs",
                    "effortArgs",
                    "sandboxArgs",
                    "permissionModeArgs",
                    "permissionModeEnvVar",
                    "permissionModeValues",
                    "supportsPermissionMode",
                    "supportsModel",
                    "supportsEffort",
                    "supportsSandbox",
                    "terminalBehavior",
                ],
            );
            if bad!(
                command,
                args,
                env,
                env_var,
                resume_args,
                create_session_args,
                model_args,
                effort_args,
                sandbox_args,
                permission_mode_args,
                permission_mode_env_var,
                permission_mode_values,
                supports_permission_mode,
                supports_model,
                supports_effort,
                supports_sandbox,
                terminal_behavior
            ) {
                return None;
            }
            let Check::Good(command) = command else {
                return None;
            };
            Some(CliConfig {
                command,
                // zod default materializes here (extension-manifest.ts:52).
                args: opt_out(args).unwrap_or_default(),
                env: opt_out(env),
                env_var: opt_out(env_var),
                resume_args: opt_out(resume_args),
                create_session_args: opt_out(create_session_args),
                model_args: opt_out(model_args),
                effort_args: opt_out(effort_args),
                sandbox_args: opt_out(sandbox_args),
                permission_mode_args: opt_out(permission_mode_args),
                permission_mode_env_var: opt_out(permission_mode_env_var),
                permission_mode_values: opt_out(permission_mode_values),
                supports_permission_mode: opt_out(supports_permission_mode),
                supports_model: opt_out(supports_model),
                supports_effort: opt_out(supports_effort),
                supports_sandbox: opt_out(supports_sandbox),
                terminal_behavior: opt_out(terminal_behavior),
            })
        })
        .into_flat()
    }

    fn opt_content_schema(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
    ) -> Check<Option<IndexMap<String, ContentSchemaField>>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        self.path.push(PathSeg::Key(key.into()));
        let out = match v {
            Value::Object(entries) => {
                let mut acc = IndexMap::with_capacity(entries.len());
                let mut ok = true;
                // Record entries iterate in JS own-key order (array-index keys
                // ascending first); `__proto__` is silently skipped
                // (never validated, never kept) per `$ZodRecord`.
                for field_key in js_ordered_keys(entries) {
                    if field_key == "__proto__" {
                        continue;
                    }
                    let field_val = &entries[field_key];
                    self.path.push(PathSeg::Key(field_key.to_string()));
                    match self.content_schema_field(field_val) {
                        Some(field) => {
                            acc.insert(field_key.to_string(), field);
                        }
                        None => ok = false,
                    }
                    self.path.pop();
                }
                if ok {
                    Check::Good(Some(acc))
                } else {
                    Check::Bad
                }
            }
            other => {
                self.push(
                    IssueCode::InvalidType,
                    msg_invalid_type("record", received_name(other)),
                );
                Check::Bad
            }
        };
        self.path.pop();
        out
    }

    /// One `ContentSchemaFieldSchema` value (path cursor already AT the
    /// field key). Returns None when any issue was pushed for this field.
    fn content_schema_field(&mut self, value: &Value) -> Option<ContentSchemaField> {
        let mark = self.issues.len();
        let Value::Object(m) = value else {
            self.push(
                IssueCode::InvalidType,
                msg_invalid_type("object", received_name(value)),
            );
            return None;
        };
        // definition order (extension-manifest.ts:14-18)
        let field_type = self.req_enum(m, "type", FieldType::OPTIONS);
        let label = self.req_str(m, "label", Min::Zero);
        let required = self.opt_bool(m, "required");
        let default = self.opt_default(m, "default");
        self.unrecognized(m, &["type", "label", "required", "default"]);

        // The field-type refine (extension-manifest.ts:19-25), gated by the
        // abort rule over THIS FIELD's subtree only (DC-4.2).
        if !self.aborted_since(mark) {
            if let (Check::Good(ft), Check::Good(Some(d))) = (&field_type, &default) {
                if d.js_typeof() != ft.as_str() {
                    self.push(IssueCode::Custom, MSG_FIELD_DEFAULT_TYPE.into());
                }
            }
        }

        if bad!(field_type, label, required, default) {
            return None;
        }
        let (Check::Good(field_type), Check::Good(label)) = (field_type, label) else {
            return None;
        };
        Some(ContentSchemaField {
            field_type,
            label,
            required: opt_out(required),
            default: opt_out(default),
        })
    }

    /// `z.union([z.string(), z.number(), z.boolean()])` for the field
    /// default: string/number/boolean accepted, everything else (incl. null,
    /// arrays, objects) → one `invalid_union` "Invalid input".
    fn opt_default(&mut self, obj: &Map<String, Value>, key: &str) -> Check<Option<DefaultValue>> {
        let Some(v) = obj.get(key) else {
            return Check::Absent;
        };
        match v {
            Value::String(s) => Check::Good(Some(DefaultValue::String(s.clone()))),
            Value::Number(n) => Check::Good(Some(DefaultValue::number(n))),
            Value::Bool(b) => Check::Good(Some(DefaultValue::Boolean(*b))),
            _ => {
                self.path.push(PathSeg::Key(key.into()));
                self.push(IssueCode::InvalidUnion, "Invalid input".into());
                self.path.pop();
                Check::Bad
            }
        }
    }
}

/// `opt_object` wraps its closure's value in `Some`, so a closure returning
/// `Option<T>` (None = a member failed; issue already pushed) yields
/// `Check<Option<Option<T>>>`. Flatten back to `Check<Option<T>>`:
/// `Good(Some(None))` (member failure) is `Bad`, NOT a present block.
trait IntoFlat<T> {
    fn into_flat(self) -> Check<Option<T>>;
}

impl<T> IntoFlat<T> for Check<Option<Option<T>>> {
    fn into_flat(self) -> Check<Option<T>> {
        match self {
            Check::Good(inner) => match inner {
                Some(Some(v)) => Check::Good(Some(v)),
                // Member-level failure (issue already pushed), or the
                // never-produced bare Good(None) — either way not a good block.
                Some(None) | None => Check::Bad,
            },
            Check::Bad => Check::Bad,
            Check::Absent => Check::Absent,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Min {
    Zero,
    One,
}

fn msg_enum<T>(options: &[(&str, T)]) -> String {
    if options.len() == 1 {
        format!("Invalid input: expected \"{}\"", options[0].0)
    } else {
        let list = options
            .iter()
            .map(|(n, _)| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join("|");
        format!("Invalid option: expected one of {list}")
    }
}

/// Flatten the optional tri-state into the output `Option` (Bad is
/// unreachable at assembly time — guarded by the zero-issue invariant).
fn opt_out<T>(c: Check<Option<T>>) -> Option<T> {
    match c {
        Check::Good(v) => v,
        Check::Absent => None,
        Check::Bad => unreachable!("zero-issue manifest must not have Bad optionals"),
    }
}

impl Category {
    const OPTIONS: &'static [(&'static str, Category)] = &[
        ("client", Category::Client),
        ("server", Category::Server),
        ("cli", Category::Cli),
    ];
}

impl FieldType {
    const OPTIONS: &'static [(&'static str, FieldType)] = &[
        ("string", FieldType::String),
        ("number", FieldType::Number),
        ("boolean", FieldType::Boolean),
    ];
}

impl PreferredRenderer {
    const OPTIONS: &'static [(&'static str, PreferredRenderer)] =
        &[("canvas", PreferredRenderer::Canvas)];
}

impl ScrollInputPolicy {
    const OPTIONS: &'static [(&'static str, ScrollInputPolicy)] = &[
        ("native", ScrollInputPolicy::Native),
        (
            "fallbackToCursorKeysWhenAltScreenMouseCapture",
            ScrollInputPolicy::FallbackToCursorKeysWhenAltScreenMouseCapture,
        ),
    ];
}

#[cfg(test)]
mod tests;
