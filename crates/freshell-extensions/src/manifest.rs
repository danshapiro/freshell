//! The typed manifest model (`ExtensionManifest` and its blocks), mirroring
//! `z.infer<typeof ExtensionManifestSchema>` from `server/extension-manifest.ts`
//! — with zod defaults MATERIALIZED (see field docs).
//!
//! Wire (de)serialization: `Serialize` reproduces zod's output-object shape
//! exactly (camelCase keys, absent optionals elided, materialized defaults
//! always present) — this is what the registry echoes to clients. No
//! `Deserialize` impls exist ON PURPOSE: the ONLY way to obtain this model is
//! `validate_manifest`/`parse_manifest`, so the lenient-vs-strict split that
//! bit the `freshell-server` subset port can't reappear here.

use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Number, Value};

/// `category: z.enum(['client', 'server', 'cli'])`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Client,
    Server,
    Cli,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Client => "client",
            Category::Server => "server",
            Category::Cli => "cli",
        }
    }
}

impl Serialize for Category {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// `type: z.enum(['string', 'number', 'boolean'])` on a content-schema field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
    String,
    Number,
    Boolean,
}

impl FieldType {
    pub fn as_str(self) -> &'static str {
        match self {
            FieldType::String => "string",
            FieldType::Number => "number",
            FieldType::Boolean => "boolean",
        }
    }
}

impl Serialize for FieldType {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// `default: z.union([z.string(), z.number(), z.boolean()])`.
///
/// Numbers integrate to a canonical [`serde_json::Number`]: integral values in
/// `±(2^53-1)` are stored as integers so re-serialization matches
/// `JSON.stringify` (which never prints a trailing `.0`); non-integral values
/// stay f64.
#[derive(Debug, Clone, PartialEq)]
pub enum DefaultValue {
    String(String),
    Number(Number),
    Boolean(bool),
}

impl DefaultValue {
    /// Build a number default from a parsed JSON number, matching the DOUBLE
    /// `JSON.parse` produces bit-for-bit: everything goes through f64 first
    /// (so integer text beyond 2^53 rounds like JS instead of staying u64-
    /// exact), then integral values in `±(2^53-1)` are stored as integers so
    /// re-serialization matches `JSON.stringify` (which never prints a
    /// trailing `.0`). Larger or non-integral values stay f64 — the stored
    /// double is identical to JS's; only exponent-notation text cosmetics
    /// differ at extremes (recorded divergence).
    pub(crate) fn number(n: &Number) -> Self {
        let f = n.as_f64().expect("serde_json::Number is always f64-able");
        if f.fract() == 0.0 && f.abs() <= 9007199254740991.0 {
            return DefaultValue::Number(Number::from(f as i64));
        }
        DefaultValue::Number(Number::from_f64(f).expect("JSON numbers are finite"))
    }

    /// The JS `typeof` of this value — the operand of the content-schema
    /// field-type refine (`typeof field.default === field.type`).
    pub(crate) fn js_typeof(&self) -> &'static str {
        match self {
            DefaultValue::String(_) => "string",
            DefaultValue::Number(_) => "number",
            DefaultValue::Boolean(_) => "boolean",
        }
    }
}

impl Serialize for DefaultValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            DefaultValue::String(v) => v.serialize(s),
            DefaultValue::Number(v) => v.serialize(s),
            DefaultValue::Boolean(v) => v.serialize(s),
        }
    }
}

/// `ContentSchemaFieldSchema` — a dynamic field descriptor for extension
/// props (`extension-manifest.ts:14-25`).
#[derive(Debug, Clone, PartialEq)]
pub struct ContentSchemaField {
    pub field_type: FieldType,
    pub label: String,
    pub required: Option<bool>,
    pub default: Option<DefaultValue>,
}

impl Serialize for ContentSchemaField {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        m.insert(
            "type".into(),
            Value::String(self.field_type.as_str().into()),
        );
        m.insert("label".into(), Value::String(self.label.clone()));
        if let Some(v) = self.required {
            m.insert("required".into(), Value::Bool(v));
        }
        if let Some(v) = &self.default {
            m.insert(
                "default".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        Value::Object(m).serialize(s)
    }
}

/// `preferredRenderer: z.enum(['canvas'])` — single-option enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreferredRenderer {
    Canvas,
}

impl Serialize for PreferredRenderer {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str("canvas")
    }
}

/// `scrollInputPolicy: z.enum(['native',
/// 'fallbackToCursorKeysWhenAltScreenMouseCapture'])`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollInputPolicy {
    Native,
    FallbackToCursorKeysWhenAltScreenMouseCapture,
}

impl Serialize for ScrollInputPolicy {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(match self {
            ScrollInputPolicy::Native => "native",
            ScrollInputPolicy::FallbackToCursorKeysWhenAltScreenMouseCapture => {
                "fallbackToCursorKeysWhenAltScreenMouseCapture"
            }
        })
    }
}

/// `TerminalBehaviorConfigSchema` (`extension-manifest.ts:45-48`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalBehavior {
    pub preferred_renderer: Option<PreferredRenderer>,
    pub scroll_input_policy: Option<ScrollInputPolicy>,
}

impl Serialize for TerminalBehavior {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        if let Some(v) = &self.preferred_renderer {
            m.insert(
                "preferredRenderer".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.scroll_input_policy {
            m.insert(
                "scrollInputPolicy".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        Value::Object(m).serialize(s)
    }
}

/// `ClientConfigSchema` (`extension-manifest.ts:31-33`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientConfig {
    pub entry: String,
}

impl Serialize for ClientConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        m.insert("entry".into(), Value::String(self.entry.clone()));
        Value::Object(m).serialize(s)
    }
}

/// `ServerConfigSchema` (`extension-manifest.ts:35-43`) with zod defaults
/// materialized: `args` and `ready_timeout` and `singleton` are always
/// concrete here (defaults `[]`, `10000`, `true`).
#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub command: String,
    /// Default-materialized (`[]` when absent in the manifest).
    pub args: Vec<String>,
    pub env: Option<IndexMap<String, String>>,
    pub ready_pattern: Option<String>,
    /// Default-materialized (`10000` when absent). Validated as a JS-safe-int
    /// positive millisecond value: `1..=9007199254740991`.
    pub ready_timeout: u64,
    pub health_check: Option<String>,
    /// Default-materialized (`true` when absent).
    pub singleton: bool,
}

impl Serialize for ServerConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        m.insert("command".into(), Value::String(self.command.clone()));
        m.insert(
            "args".into(),
            serde_json::to_value(&self.args).unwrap_or(Value::Null),
        );
        if let Some(v) = &self.env {
            m.insert("env".into(), serde_json::to_value(v).unwrap_or(Value::Null));
        }
        if let Some(v) = &self.ready_pattern {
            m.insert("readyPattern".into(), Value::String(v.clone()));
        }
        m.insert(
            "readyTimeout".into(),
            Value::Number(Number::from(self.ready_timeout)),
        );
        if let Some(v) = &self.health_check {
            m.insert("healthCheck".into(), Value::String(v.clone()));
        }
        m.insert("singleton".into(), Value::Bool(self.singleton));
        Value::Object(m).serialize(s)
    }
}

/// `CliConfigSchema` (`extension-manifest.ts:50-66`) — the full launch/
/// capability surface: command override, args/env, create/resume identity
/// (`createSessionArgs`/`resumeArgs` `{{sessionId}}` templates), models
/// (`modelArgs`/`supportsModel`), effort (`effortArgs`/`supportsEffort`),
/// sandbox (`sandboxArgs`/`supportsSandbox`),
/// permissions (`permissionModeArgs`/`permissionModeEnvVar`/
/// `permissionModeValues`/`supportsPermissionMode`), and terminal behavior.
#[derive(Debug, Clone, PartialEq)]
pub struct CliConfig {
    pub command: String,
    /// Default-materialized (`[]` when absent in the manifest).
    pub args: Vec<String>,
    pub env: Option<IndexMap<String, String>>,
    /// Env var that overrides `command` (e.g. `CLAUDE_CMD`).
    pub env_var: Option<String>,
    /// `{{sessionId}}` template for resuming a session.
    pub resume_args: Option<Vec<String>>,
    /// `{{sessionId}}` template for fresh session identity.
    pub create_session_args: Option<Vec<String>>,
    /// `{{model}}` template.
    pub model_args: Option<Vec<String>>,
    /// `{{effort}}` template.
    pub effort_args: Option<Vec<String>>,
    /// `{{sandbox}}` template.
    pub sandbox_args: Option<Vec<String>>,
    /// `{{permissionMode}}` template.
    pub permission_mode_args: Option<Vec<String>>,
    pub permission_mode_env_var: Option<String>,
    pub permission_mode_values: Option<IndexMap<String, String>>,
    pub supports_permission_mode: Option<bool>,
    pub supports_model: Option<bool>,
    pub supports_effort: Option<bool>,
    pub supports_sandbox: Option<bool>,
    pub terminal_behavior: Option<TerminalBehavior>,
}

impl Serialize for CliConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        m.insert("command".into(), Value::String(self.command.clone()));
        m.insert(
            "args".into(),
            serde_json::to_value(&self.args).unwrap_or(Value::Null),
        );
        if let Some(v) = &self.env {
            m.insert("env".into(), serde_json::to_value(v).unwrap_or(Value::Null));
        }
        if let Some(v) = &self.env_var {
            m.insert("envVar".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.resume_args {
            m.insert(
                "resumeArgs".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.create_session_args {
            m.insert(
                "createSessionArgs".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.model_args {
            m.insert(
                "modelArgs".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.effort_args {
            m.insert(
                "effortArgs".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.sandbox_args {
            m.insert(
                "sandboxArgs".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.permission_mode_args {
            m.insert(
                "permissionModeArgs".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.permission_mode_env_var {
            m.insert("permissionModeEnvVar".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.permission_mode_values {
            m.insert(
                "permissionModeValues".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = self.supports_permission_mode {
            m.insert("supportsPermissionMode".into(), Value::Bool(v));
        }
        if let Some(v) = self.supports_model {
            m.insert("supportsModel".into(), Value::Bool(v));
        }
        if let Some(v) = self.supports_effort {
            m.insert("supportsEffort".into(), Value::Bool(v));
        }
        if let Some(v) = self.supports_sandbox {
            m.insert("supportsSandbox".into(), Value::Bool(v));
        }
        if let Some(v) = &self.terminal_behavior {
            m.insert(
                "terminalBehavior".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        Value::Object(m).serialize(s)
    }
}

/// `PickerConfigSchema` (`extension-manifest.ts:72-75`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerConfig {
    pub shortcut: Option<String>,
    pub group: Option<String>,
}

impl Serialize for PickerConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        if let Some(v) = &self.shortcut {
            m.insert("shortcut".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.group {
            m.insert("group".into(), Value::String(v.clone()));
        }
        Value::Object(m).serialize(s)
    }
}

/// The top-level manifest (`extension-manifest.ts:81-103`). Exactly one of
/// `client`/`server`/`cli` is `Some`, always the one matching `category`
/// (enforced by the validator's refine).
#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionManifest {
    pub name: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub category: Category,
    pub icon: Option<String>,
    pub url: Option<String>,
    /// Insertion-ordered (manifest text order) — the client renders
    /// content-schema forms in this order.
    pub content_schema: Option<IndexMap<String, ContentSchemaField>>,
    pub picker: Option<PickerConfig>,
    pub client: Option<ClientConfig>,
    pub server: Option<ServerConfig>,
    pub cli: Option<CliConfig>,
}

impl ExtensionManifest {
    /// Serialize to the zod-output shape (`Json.parse(JSON.stringify(
    /// result.data))`): camelCase keys, absent optionals elided, materialized
    /// defaults present. This is the shape the oracle fixture pins.
    pub fn to_zod_output_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), Value::String(self.name.clone()));
        m.insert("version".into(), Value::String(self.version.clone()));
        m.insert("label".into(), Value::String(self.label.clone()));
        m.insert(
            "description".into(),
            Value::String(self.description.clone()),
        );
        m.insert(
            "category".into(),
            Value::String(self.category.as_str().into()),
        );
        if let Some(v) = &self.icon {
            m.insert("icon".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.url {
            m.insert("url".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.content_schema {
            let mut cs = Map::new();
            for (k, f) in v {
                cs.insert(k.clone(), serde_json::to_value(f).unwrap_or(Value::Null));
            }
            m.insert("contentSchema".into(), Value::Object(cs));
        }
        if let Some(v) = &self.picker {
            m.insert(
                "picker".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.client {
            m.insert(
                "client".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.server {
            m.insert(
                "server".into(),
                serde_json::to_value(v).unwrap_or(Value::Null),
            );
        }
        if let Some(v) = &self.cli {
            m.insert("cli".into(), serde_json::to_value(v).unwrap_or(Value::Null));
        }
        Value::Object(m)
    }
}

impl Serialize for ExtensionManifest {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_zod_output_value().serialize(s)
    }
}
