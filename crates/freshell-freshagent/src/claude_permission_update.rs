//! Claude permission updates (the SDK's `PermissionUpdate`, client-alerts plan
//! G20): the CLI's own suggestions on a permission request
//! (`sdk.permission.request.suggestions`) and the `updatedPermissions` a
//! client sends back to accept them.
//!
//! [`normalize_permission_updates`] keeps only well-formed updates of the
//! documented variants, with exactly the documented keys. The snapshot's
//! `pendingApprovals[].suggestions` is parsed by a `.strict()` client schema
//! (`FreshAgentPermissionUpdateSchema`), so one unknown variant or extra key
//! relayed raw would fail the whole snapshot and hide every card (the
//! AGENT-06 lesson behind `normalize_question_definitions`).
//!
//! [`validate_decision`] refuses an approval decision whose
//! `updatedPermissions` is not such a list: the sidecar resolves a decision
//! verbatim, and a malformed update reaching the CLI would fail or misapply
//! the user's choice.

use serde_json::{Map, Value};

/// Where an update applies (the SDK's `PermissionUpdateDestination`).
const DESTINATIONS: [&str; 5] = [
    "userSettings",
    "projectSettings",
    "localSettings",
    "session",
    "cliArg",
];
/// The SDK's `PermissionBehavior`.
const BEHAVIORS: [&str; 3] = ["allow", "deny", "ask"];
/// The SDK's `PermissionMode` (a wider set than the four a pane can show).
const MODES: [&str; 6] = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
];

/// Normalize a list of permission updates: every well-formed update of a
/// documented variant, rebuilt with exactly its documented keys, in order.
/// Anything else (a non-list, an unknown variant, a bad destination, mode or
/// behavior, an empty rule or directory list) is dropped. `None` when nothing
/// survives.
pub(crate) fn normalize_permission_updates(value: Option<&Value>) -> Option<Vec<Value>> {
    let updates: Vec<Value> = value?
        .as_array()?
        .iter()
        .filter_map(normalize_permission_update)
        .collect();
    (!updates.is_empty()).then_some(updates)
}

/// Check an approval decision's `updatedPermissions`: absent is fine;
/// present, it must be a list every member of which is already a
/// well-formed update (it normalizes to itself).
pub(crate) fn validate_decision(decision: &Value) -> Result<(), String> {
    let Some(updates) = decision.get("updatedPermissions") else {
        return Ok(());
    };
    let Some(list) = updates.as_array() else {
        return Err("updatedPermissions must be a list of permission updates".to_string());
    };
    for update in list {
        if normalize_permission_update(update).as_ref() != Some(update) {
            return Err(format!(
                "updatedPermissions holds an update Claude does not accept: {update}"
            ));
        }
    }
    Ok(())
}

/// One update, rebuilt with exactly the keys of its variant, or `None`.
fn normalize_permission_update(update: &Value) -> Option<Value> {
    let object = update.as_object()?;
    let kind = object.get("type")?.as_str()?;
    let destination = one_of(object.get("destination"), &DESTINATIONS)?;
    let mut out = Map::new();
    out.insert("type".to_string(), Value::String(kind.to_string()));
    match kind {
        "addRules" | "replaceRules" | "removeRules" => {
            let rules = object
                .get("rules")?
                .as_array()?
                .iter()
                .map(normalize_rule)
                .collect::<Option<Vec<Value>>>()?;
            if rules.is_empty() {
                return None;
            }
            out.insert("rules".to_string(), Value::Array(rules));
            out.insert(
                "behavior".to_string(),
                one_of(object.get("behavior"), &BEHAVIORS)?,
            );
        }
        "setMode" => {
            out.insert("mode".to_string(), one_of(object.get("mode"), &MODES)?);
        }
        "addDirectories" | "removeDirectories" => {
            let directories = object.get("directories")?.as_array()?;
            if directories.is_empty() || !directories.iter().all(Value::is_string) {
                return None;
            }
            out.insert("directories".to_string(), Value::Array(directories.clone()));
        }
        _ => return None,
    }
    out.insert("destination".to_string(), destination);
    Some(Value::Object(out))
}

/// One rule (`PermissionRuleValue`): `toolName`, and `ruleContent` when given.
fn normalize_rule(rule: &Value) -> Option<Value> {
    let object = rule.as_object()?;
    let mut out = Map::new();
    let tool_name = object.get("toolName")?.as_str()?;
    out.insert("toolName".to_string(), Value::String(tool_name.to_string()));
    match object.get("ruleContent") {
        None => {}
        Some(Value::String(content)) => {
            out.insert("ruleContent".to_string(), Value::String(content.clone()));
        }
        Some(_) => return None,
    }
    Some(Value::Object(out))
}

/// `value` when it is one of `allowed`.
fn one_of(value: Option<&Value>, allowed: &[&str]) -> Option<Value> {
    let text = value?.as_str()?;
    allowed
        .contains(&text)
        .then(|| Value::String(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalized(value: Value) -> Option<Vec<Value>> {
        normalize_permission_updates(Some(&value))
    }

    /// One of every documented variant, as the pinned CLI and SDK shape them.
    fn every_variant() -> Vec<Value> {
        vec![
            json!({ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test *" }], "behavior": "allow", "destination": "localSettings" }),
            json!({ "type": "replaceRules", "rules": [{ "toolName": "Read" }], "behavior": "deny", "destination": "projectSettings" }),
            json!({ "type": "removeRules", "rules": [{ "toolName": "Edit", "ruleContent": "src/**" }], "behavior": "ask", "destination": "userSettings" }),
            json!({ "type": "setMode", "mode": "acceptEdits", "destination": "session" }),
            json!({ "type": "setMode", "mode": "bypassPermissions", "destination": "cliArg" }),
            json!({ "type": "addDirectories", "directories": ["/srv/data"], "destination": "session" }),
            json!({ "type": "removeDirectories", "directories": ["/srv/old", "/srv/older"], "destination": "localSettings" }),
        ]
    }

    #[test]
    fn every_documented_variant_is_kept_exactly() {
        let updates = every_variant();
        assert_eq!(normalized(Value::Array(updates.clone())), Some(updates));
    }

    #[test]
    fn every_permission_mode_the_sdk_names_is_kept() {
        for mode in [
            "default",
            "acceptEdits",
            "bypassPermissions",
            "plan",
            "dontAsk",
            "auto",
        ] {
            let update = json!({ "type": "setMode", "mode": mode, "destination": "session" });
            assert_eq!(
                normalized(json!([update.clone()])),
                Some(vec![update]),
                "{mode}"
            );
        }
    }

    #[test]
    fn an_unknown_variant_a_bad_destination_or_a_bad_mode_is_dropped_and_the_rest_kept() {
        let good = json!({ "type": "setMode", "mode": "acceptEdits", "destination": "session" });
        let list = json!([
            { "type": "grantEverything", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "everywhere" },
            { "type": "setMode", "mode": "yolo", "destination": "session" },
            good,
        ]);
        assert_eq!(normalized(list), Some(vec![good]));
    }

    #[test]
    fn malformed_members_are_dropped() {
        assert_eq!(
            normalized(json!([
                "addRules",
                null,
                { "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "session" },
                { "type": "addRules", "behavior": "allow", "destination": "session" },
                { "type": "addRules", "rules": [], "behavior": "allow", "destination": "session" },
                { "type": "addRules", "rules": [{ "ruleContent": "x" }], "behavior": "allow", "destination": "session" },
                { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": 7 }], "behavior": "allow", "destination": "session" },
                { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "always", "destination": "session" },
                { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow" },
                { "type": "addDirectories", "directories": [], "destination": "session" },
                { "type": "addDirectories", "directories": ["/a", 3], "destination": "session" },
                { "type": "setMode", "destination": "session" },
            ])),
            None
        );
    }

    #[test]
    fn extra_keys_are_stripped_at_every_level() {
        assert_eq!(
            normalized(json!([
                { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "ls", "note": "x" }], "behavior": "allow", "destination": "session", "id": 4 },
                { "type": "setMode", "mode": "plan", "destination": "session", "reason": "plan first" },
                { "type": "addDirectories", "directories": ["/a"], "destination": "session", "recursive": true },
            ])),
            Some(vec![
                json!({ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "ls" }], "behavior": "allow", "destination": "session" }),
                json!({ "type": "setMode", "mode": "plan", "destination": "session" }),
                json!({ "type": "addDirectories", "directories": ["/a"], "destination": "session" }),
            ])
        );
    }

    #[test]
    fn an_empty_absent_or_non_list_value_is_none() {
        assert_eq!(normalized(json!([])), None);
        assert_eq!(normalize_permission_updates(None), None);
        assert_eq!(normalized(Value::Null), None);
        assert_eq!(
            normalized(json!({ "type": "setMode", "mode": "plan", "destination": "session" })),
            None
        );
    }

    #[test]
    fn a_decision_without_updated_permissions_or_with_an_empty_list_is_valid() {
        assert_eq!(validate_decision(&json!({ "behavior": "allow" })), Ok(()));
        assert_eq!(
            validate_decision(&json!({ "behavior": "deny", "message": "no", "interrupt": false })),
            Ok(())
        );
        assert_eq!(
            validate_decision(&json!({ "behavior": "allow", "updatedPermissions": [] })),
            Ok(())
        );
    }

    #[test]
    fn a_decision_with_well_formed_updates_is_valid() {
        assert_eq!(
            validate_decision(
                &json!({ "behavior": "allow", "updatedPermissions": every_variant() })
            ),
            Ok(())
        );
    }

    #[test]
    fn a_decision_whose_updated_permissions_is_not_a_well_formed_list_is_refused() {
        for bad in [
            json!(null),
            json!("addRules"),
            json!(3),
            json!({ "type": "setMode", "mode": "plan", "destination": "session" }),
            json!([{ "type": "grantEverything", "destination": "session" }]),
            json!([{ "type": "setMode", "mode": "plan", "destination": "session", "extra": 1 }]),
            json!([
                { "type": "setMode", "mode": "plan", "destination": "session" },
                { "type": "setMode", "mode": "yolo", "destination": "session" },
            ]),
        ] {
            let decision = json!({ "behavior": "allow", "updatedPermissions": bad });
            assert!(validate_decision(&decision).is_err(), "accepted {decision}");
        }
    }
}
