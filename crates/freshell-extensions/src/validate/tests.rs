//! Focused unit tests for the strict validator (`super`): properties the
//! differential oracle cannot express — error-class distinctions at the API
//! boundary, issue Display formatting (what scan logs), JS own-key ORDER
//! fidelity (oracle JSON equality is order-insensitive), and the `__proto__`
//! record-skip shape.
//!
//! Verdict/message behavior is NOT unit-tested here on purpose — the
//! oracle fixture pins all 130 cases against the real zod schema.
use super::*;
use crate::manifest::FieldType;

/// `parse_manifest` distinguishes legacy's two scan log classes:
/// 'invalid JSON in manifest' (text not JSON) vs 'invalid manifest'
/// (schema failure).
#[test]
fn parse_manifest_splits_invalid_json_from_invalid_manifest() {
    let err = parse_manifest("{ not json").unwrap_err();
    assert!(matches!(err, ManifestError::InvalidJson(_)), "{err:?}");

    let err = parse_manifest(r#"{"name": 5}"#).unwrap_err();
    match err {
        ManifestError::Invalid(issues) => {
            // name + missing version/label/description/category; the
            // category refine is gated by the aborting failures.
            assert_eq!(issues.len(), 5, "{issues:?}");
            assert_eq!(issues[0].code, IssueCode::InvalidType);
            assert_eq!(issues[0].path, vec![PathSeg::Key("name".into())]);
        }
        other => panic!("expected Invalid, got {other:?}"),
    }
}

#[test]
fn issue_display_is_log_friendly() {
    let err = parse_manifest(
        r#"{"name":"x","version":"1","label":"l","description":"d","category":"cli","cli":{"command":"c","flags":[]}}"#,
    )
    .unwrap_err();
    let ManifestError::Invalid(issues) = err else {
        unreachable!()
    };
    assert_eq!(
        issues[0].to_string(),
        "[unrecognized_keys cli] Unrecognized key: \"flags\""
    );
}

/// contentSchema preserves manifest TEXT field order (JS object insertion
/// order) — the client renders the form in this order. Value-equality
/// (used by the oracle) is order-insensitive, so this pins the text.
#[test]
fn content_schema_output_preserves_manifest_field_order() {
    let manifest = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "client", "client": { "entry": "e" },
          "contentSchema": {
            "zebra": { "type": "string", "label": "Z" },
            "apple": { "type": "number", "label": "A" },
            "mango": { "type": "boolean", "label": "M" }
          }
        }"#,
    )
    .expect("valid");
    let text = serde_json::to_string(&manifest.to_zod_output_value()).unwrap();
    let (z, a, m) = (
        text.find("zebra").unwrap(),
        text.find("apple").unwrap(),
        text.find("mango").unwrap(),
    );
    assert!(z < a && a < m, "insertion order must survive: {text}");
    // And the typed model exposes the same order.
    let keys: Vec<&String> = manifest.content_schema.as_ref().unwrap().keys().collect();
    assert_eq!(keys, ["zebra", "apple", "mango"]);
}

/// env/permissionModeValues records preserve manifest text order too
/// (IndexMap, not BTreeMap).
#[test]
fn env_record_output_preserves_manifest_order() {
    let manifest = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "cli",
          "cli": { "command": "c", "env": { "ZED": "1", "ALPHA": "2" } }
        }"#,
    )
    .expect("valid");
    let keys: Vec<&String> = manifest
        .cli
        .as_ref()
        .unwrap()
        .env
        .as_ref()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(keys, ["ZED", "ALPHA"]);
}

/// JS own-key enumeration order (from the df1 independent review):
/// canonical array-index keys enumerate FIRST in ascending numeric order,
/// then other keys in insertion order — for records (env shown), for
/// contentSchema, and for the unrecognized_keys message. zod enumerates
/// `JSON.parse` objects this way (for…in / Reflect.ownKeys).
#[test]
fn env_record_uses_js_own_key_order_for_numeric_keys() {
    let manifest = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "cli",
          "cli": { "command": "c", "env": { "10": "a", "2": "b", "x": "c", "00": "d" } }
        }"#,
    )
    .expect("valid");
    // "2" before "10" (numeric), then insertion order for the rest
    // ("00" is NOT a canonical array index).
    let keys: Vec<&String> = manifest
        .cli
        .as_ref()
        .unwrap()
        .env
        .as_ref()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(keys, ["2", "10", "x", "00"]);
}

#[test]
fn content_schema_uses_js_own_key_order_for_numeric_keys() {
    let manifest = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "client", "client": { "entry": "e" },
          "contentSchema": {
            "zebra": { "type": "string", "label": "Z" },
            "10": { "type": "string", "label": "ten" },
            "2": { "type": "string", "label": "two" }
          }
        }"#,
    )
    .expect("valid");
    let keys: Vec<&String> = manifest.content_schema.as_ref().unwrap().keys().collect();
    assert_eq!(keys, ["2", "10", "zebra"]);
}

/// `$ZodRecord` silently skips `__proto__`: never validated (even an
/// invalid value passes), never kept in output. Strict objects still
/// reject it as an unrecognized key (a different code path).
#[test]
fn proto_key_is_skipped_in_records_but_rejected_in_strict_objects() {
    let manifest = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "cli",
          "cli": { "command": "c", "env": { "__proto__": 5, "x": "y" } }
        }"#,
    )
    .expect("__proto__ with an invalid value is skipped, not validated");
    let env = manifest.cli.as_ref().unwrap().env.as_ref().unwrap();
    assert_eq!(env.len(), 1, "__proto__ dropped from output");
    assert_eq!(env["x"], "y");

    let err = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "cli", "cli": { "command": "c" }, "__proto__": 1
        }"#,
    )
    .unwrap_err();
    let ManifestError::Invalid(issues) = err else {
        unreachable!()
    };
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].code, IssueCode::UnrecognizedKeys);
    assert_eq!(issues[0].message, "Unrecognized key: \"__proto__\"");
}

/// The content-schema default union reports ONE invalid_union for
/// non-scalar defaults (not three member failures) and does NOT fire the
/// field refine afterwards (invalid_union is aborting → refine gated).
#[test]
fn union_default_failure_is_single_invalid_union_no_refine() {
    let err = parse_manifest(
        r#"{
          "name": "x", "version": "1", "label": "l", "description": "d",
          "category": "client", "client": { "entry": "e" },
          "contentSchema": { "f": { "type": "string", "label": "L", "default": {} } }
        }"#,
    )
    .unwrap_err();
    let ManifestError::Invalid(issues) = err else {
        unreachable!()
    };
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].code, IssueCode::InvalidUnion);
    assert_eq!(issues[0].message, "Invalid input");
    assert_eq!(
        issues[0].path,
        vec![
            PathSeg::Key("contentSchema".into()),
            PathSeg::Key("f".into()),
            PathSeg::Key("default".into()),
        ]
    );
}

/// Data accessibility smoke: a fully-populated CLI manifest exposes every
/// launch/permission/model/sandbox field through the typed model and the
/// zod-output shape mirrors the input key-for-key (plus materialized
/// args).
#[test]
fn cli_full_surface_round_trips_key_for_key() {
    let input = r#"{
      "name": "opencode", "version": "1.0.0", "label": "OpenCode",
      "description": "x", "category": "cli",
      "cli": {
        "command": "opencode", "args": ["--ui"],
        "env": { "A": "1" }, "envVar": "OPENCODE_CMD",
        "resumeArgs": ["--session", "{{sessionId}}"],
        "createSessionArgs": ["--session-id", "{{sessionId}}"],
        "modelArgs": ["--model", "{{model}}"],
        "effortArgs": ["--effort", "{{effort}}"],
        "sandboxArgs": ["--sandbox", "{{sandbox}}"],
        "permissionModeArgs": ["--permission-mode", "{{permissionMode}}"],
        "permissionModeEnvVar": "AGENT_PERMISSION_MODE",
        "permissionModeValues": { "plan": "{}" },
        "supportsPermissionMode": true, "supportsModel": true, "supportsEffort": true, "supportsSandbox": false,
        "terminalBehavior": { "preferredRenderer": "canvas", "scrollInputPolicy": "native" }
      }
    }"#;
    let manifest = parse_manifest(input).expect("valid");
    let cli = manifest.cli.as_ref().unwrap();
    assert_eq!(cli.command, "opencode");
    assert_eq!(cli.args, ["--ui"]);
    assert_eq!(cli.env_var.as_deref(), Some("OPENCODE_CMD"));
    assert_eq!(
        cli.resume_args.as_ref().unwrap(),
        &["--session", "{{sessionId}}"]
    );
    assert_eq!(
        cli.create_session_args.as_ref().unwrap(),
        &["--session-id", "{{sessionId}}"]
    );
    assert_eq!(cli.model_args.as_ref().unwrap(), &["--model", "{{model}}"]);
    assert_eq!(
        cli.effort_args.as_ref().unwrap(),
        &["--effort", "{{effort}}"]
    );
    assert_eq!(cli.supports_effort, Some(true));
    assert_eq!(cli.permission_mode_values.as_ref().unwrap()["plan"], "{}");
    assert_eq!(cli.supports_sandbox, Some(false)); // explicit false preserved
                                                   // input had args → no default injection anywhere else:
    let out = manifest.to_zod_output_value();
    assert_eq!(out["cli"]["supportsSandbox"], serde_json::json!(false));
    assert_eq!(out["cli"]["supportsEffort"], serde_json::json!(true));
    assert!(out["cli"].get("serverRunning").is_none());
}

/// FieldType::as_str doubles as the JS typeof name — the coupling the
/// content-schema refine relies on. Pin it so a future rename can't
/// silently break the typeof comparison.
#[test]
fn field_type_as_str_matches_js_typeof_names() {
    assert_eq!(FieldType::String.as_str(), "string");
    assert_eq!(FieldType::Number.as_str(), "number");
    assert_eq!(FieldType::Boolean.as_str(), "boolean");
}
