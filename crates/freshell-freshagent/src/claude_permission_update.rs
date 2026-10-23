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
//! the user's choice. The [`DecisionRefusal`] names the failing update by its
//! position and variant only: a rule's content (a Bash command, a path) is
//! user content, which claude logs never carry.

use std::fmt;

use serde_json::{Map, Value};

/// Where an update applies (the SDK's `PermissionUpdateDestination`).
const DESTINATIONS: [&str; 5] = [
    "userSettings",
    "projectSettings",
    "localSettings",
    "session",
    "cliArg",
];
/// The SDK's `PermissionUpdate` variants (its `type`).
const KINDS: [&str; 6] = [
    "addRules",
    "replaceRules",
    "removeRules",
    "setMode",
    "addDirectories",
    "removeDirectories",
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

/// Why [`validate_decision`] refused a decision, without any of its content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecisionRefusal {
    /// `updatedPermissions` is present but not a list.
    NotAList,
    /// The update at `index` is not a well-formed update. `kind` is its
    /// variant when Claude defines one, else `"unknown"` (a client-chosen
    /// `type` is never echoed).
    MalformedUpdate { index: usize, kind: &'static str },
}

impl DecisionRefusal {
    /// The failing update's position, when one update failed.
    pub(crate) fn update_index(self) -> Option<usize> {
        match self {
            Self::NotAList => None,
            Self::MalformedUpdate { index, .. } => Some(index),
        }
    }

    /// The failing update's variant, when one update failed.
    pub(crate) fn update_type(self) -> Option<&'static str> {
        match self {
            Self::NotAList => None,
            Self::MalformedUpdate { kind, .. } => Some(kind),
        }
    }
}

impl fmt::Display for DecisionRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAList => {
                f.write_str("updatedPermissions must be a list of permission updates")
            }
            Self::MalformedUpdate { index, kind } => write!(
                f,
                "updatedPermissions[{index}] ({kind}) is not a permission update Claude accepts"
            ),
        }
    }
}

/// Check an approval decision's `updatedPermissions`: absent is fine;
/// present, it must be a list every member of which is already a
/// well-formed update (it normalizes to itself).
pub(crate) fn validate_decision(decision: &Value) -> Result<(), DecisionRefusal> {
    let Some(updates) = decision.get("updatedPermissions") else {
        return Ok(());
    };
    let list = updates.as_array().ok_or(DecisionRefusal::NotAList)?;
    match list
        .iter()
        .position(|update| normalize_permission_update(update).as_ref() != Some(update))
    {
        Some(index) => Err(DecisionRefusal::MalformedUpdate {
            index,
            kind: kind_of(&list[index]),
        }),
        None => Ok(()),
    }
}

/// An update's variant as Claude names it, or `"unknown"`.
fn kind_of(update: &Value) -> &'static str {
    let kind = update.get("type").and_then(Value::as_str);
    KINDS
        .into_iter()
        .find(|known| Some(*known) == kind)
        .unwrap_or("unknown")
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

    #[test]
    fn a_refusal_names_the_update_by_position_and_variant_never_by_its_content() {
        let decision = json!({ "behavior": "allow", "updatedPermissions": [
            { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
            { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "deploy --token s3cr3t" }],
              "behavior": "allow", "destination": "session", "extra": 1 },
        ] });
        let refusal = validate_decision(&decision).unwrap_err();
        assert_eq!(
            refusal,
            DecisionRefusal::MalformedUpdate {
                index: 1,
                kind: "addRules"
            }
        );
        let text = refusal.to_string();
        assert!(
            !text.contains("s3cr3t"),
            "the refusal echoes content: {text}"
        );
        assert!(text.contains("updatedPermissions[1]"), "{text}");
        assert!(text.contains("addRules"), "{text}");
    }

    #[test]
    fn a_refusal_never_echoes_a_variant_name_claude_does_not_define() {
        let decision = json!({ "behavior": "allow", "updatedPermissions": [
            { "type": "grant everything in /home/me/s3cr3t", "destination": "session" },
        ] });
        let refusal = validate_decision(&decision).unwrap_err();
        assert_eq!(
            refusal,
            DecisionRefusal::MalformedUpdate {
                index: 0,
                kind: "unknown"
            }
        );
        let text = refusal.to_string();
        assert!(
            !text.contains("s3cr3t"),
            "the refusal echoes content: {text}"
        );
        assert!(text.contains("updatedPermissions[0]"), "{text}");
    }
}
