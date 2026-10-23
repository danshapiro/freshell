//! Claude REST pane defaults follow the picker, including saved catalog levels.

use freshell_protocol::{ModelSelection, SettingsFreshAgent};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedClaudeCreate {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_effort_levels: Option<Vec<String>>,
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub plugins: Vec<String>,
}

pub fn resolve_claude_rest_create(
    session_type: &str,
    body: &Value,
    settings: &SettingsFreshAgent,
) -> Result<ResolvedClaudeCreate, String> {
    if !matches!(session_type, "freshclaude" | "kilroy") {
        return Err(format!("unsupported Claude session type: {session_type}"));
    }
    let inputs = crate::rest_lane::provider_inputs(body)?;
    let saved = &settings.providers[session_type];
    let model_selection = match inputs.model_selection {
        Some(selection) => selection,
        None => saved
            .get("modelSelection")
            .and_then(|selection| serde_json::from_value::<ModelSelection>(selection.clone()).ok())
            .filter(|selection| selection.kind == "exact" && !selection.model_id.trim().is_empty()),
    };
    let model = optional_string(body, "model")?
        .or_else(|| {
            model_selection
                .as_ref()
                .map(|selection| selection.model_id.trim().to_string())
        })
        .unwrap_or_else(|| "opus[1m]".into());
    let model_effort_levels = saved
        .get("modelEffortLevels")
        .filter(|stamp| stamp.get("modelId").and_then(Value::as_str) == Some(model.as_str()))
        .and_then(|stamp| stamp.get("levels"))
        .and_then(|levels| serde_json::from_value::<Vec<String>>(levels.clone()).ok());
    let candidate = optional_string(body, "effort")?.or_else(|| {
        saved
            .get("effort")
            .and_then(Value::as_str)
            .and_then(non_blank)
    });
    let effort = resolve_effort(&model, model_effort_levels.as_deref(), candidate);
    Ok(ResolvedClaudeCreate {
        model,
        model_selection,
        model_effort_levels,
        permission_mode: inputs
            .permission_mode
            .or_else(|| {
                saved
                    .get("defaultPermissionMode")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "bypassPermissions".into()),
        effort,
        plugins: inputs
            .plugins
            .unwrap_or_else(|| settings.default_plugins.clone()),
    })
}

fn resolve_effort(
    model: &str,
    levels: Option<&[String]>,
    candidate: Option<String>,
) -> Option<String> {
    let candidate = candidate.unwrap_or_else(|| "high".into());
    if model != "opus[1m]" {
        if let Some(levels) = levels {
            return if levels.contains(&candidate) {
                Some(candidate)
            } else {
                levels.first().cloned()
            };
        }
    }
    Some(
        if matches!(
            candidate.as_str(),
            "low" | "medium" | "high" | "xhigh" | "max"
        ) {
            candidate
        } else {
            "high".into()
        },
    )
}

fn non_blank(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn optional_string(body: &Value, key: &str) -> Result<Option<String>, String> {
    body.get(key)
        .map(|value| {
            value
                .as_str()
                .map(non_blank)
                .ok_or_else(|| format!("invalid {key}"))
        })
        .transpose()
        .map(Option::flatten)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(providers: Value) -> SettingsFreshAgent {
        SettingsFreshAgent {
            default_plugins: vec!["/default-plugin".into()],
            enabled: true,
            providers,
            initial_setup_done: None,
        }
    }

    #[test]
    fn explicit_request_fields_override_saved_defaults_and_can_clear_selection() {
        let settings = settings(json!({"freshclaude": {
            "modelSelection": {"kind":"exact", "modelId":"saved-model"},
            "defaultPermissionMode":"plan", "effort":"low"
        }}));
        let resolved = resolve_claude_rest_create(
            "freshclaude",
            &json!({
                "model":"opus[1m]", "modelSelection":null, "effort":"max",
                "permissionMode":"acceptEdits", "plugins":[]
            }),
            &settings,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(resolved).unwrap(),
            json!({
                "model":"opus[1m]", "effort":"max", "permissionMode":"acceptEdits", "plugins":[]
            })
        );
    }

    #[test]
    fn explicit_selection_changes_the_model_and_discards_old_catalog_levels() {
        let settings = settings(json!({"kilroy": {
            "modelSelection": {"kind":"exact", "modelId":"saved-model"},
            "modelEffortLevels":{"modelId":"saved-model", "levels":[]}
        }}));
        let resolved = resolve_claude_rest_create(
            "kilroy",
            &json!({
                "modelSelection":{"kind":"exact", "modelId":"new-model"}
            }),
            &settings,
        )
        .unwrap();
        assert_eq!(resolved.model, "new-model");
        assert_eq!(resolved.model_selection.unwrap().model_id, "new-model");
        assert_eq!(resolved.model_effort_levels, None);
        assert_eq!(resolved.effort.as_deref(), Some("high"));
    }

    #[test]
    fn invalid_provider_inputs_are_refused() {
        let settings = settings(json!({}));
        assert!(
            resolve_claude_rest_create("freshclaude", &json!({"plugins":"bad"}), &settings)
                .is_err()
        );
        assert!(resolve_claude_rest_create("freshcodex", &json!({}), &settings).is_err());
    }

    #[test]
    fn rest_and_picker_resolve_the_same_claude_defaults() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../test/fixtures/fresh-agent/claude-create-defaults.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let mut settings = SettingsFreshAgent {
                default_plugins: vec![],
                enabled: true,
                providers: json!({}),
                initial_setup_done: None,
            };
            if let Some(fresh) = fixture["settings"].get("freshAgent") {
                if let Some(plugins) = fresh.get("defaultPlugins") {
                    settings.default_plugins = serde_json::from_value(plugins.clone()).unwrap();
                }
                if let Some(providers) = fresh.get("providers") {
                    settings.providers = providers.clone();
                }
            }
            let resolved = resolve_claude_rest_create(
                fixture["sessionType"].as_str().unwrap(),
                &json!({}),
                &settings,
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(resolved).unwrap(),
                fixture["expected"],
                "{}",
                fixture["name"]
            );
        }
    }
}
