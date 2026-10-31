//! Codex next-turn defaults, independent of runtime identity and ownership.

use freshell_codex::{
    normalize_freshcodex_effort, normalize_freshcodex_model, to_codex_reasoning_effort,
};
use freshell_protocol::FreshAgentSendSettings;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexWorkMode {
    Default,
    Plan,
}

impl CodexWorkMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "default" => Some(Self::Default),
            "plan" => Some(Self::Plan),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Plan => "plan",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEffectiveSettings {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<CodexWorkMode>,
}

#[derive(Debug)]
pub struct SettingsError {
    pub code: &'static str,
    pub message: String,
}

impl CodexEffectiveSettings {
    /// An absent patch field preserves the exact selection, including native
    /// default effort and opaque provider model/effort values.
    pub fn resolve(base: &Self, patch: &FreshAgentSendSettings) -> Result<Self, SettingsError> {
        let model = normalize_freshcodex_model(patch.model.as_deref().or(Some(&base.model)));
        let effort = normalize_freshcodex_effort(
            Some(&model),
            patch
                .effort
                .as_ref()
                .map_or(base.effort.as_deref(), |value| value.as_deref()),
        );
        let mut sandbox = patch
            .sandbox
            .map(super::sandbox_wire_value)
            .or_else(|| base.sandbox.clone());
        let mut permission_mode = patch
            .permission_mode
            .clone()
            .or_else(|| base.permission_mode.clone());
        super::normalize_codex_permission(&mut permission_mode, &mut sandbox).map_err(
            |message| SettingsError {
                code: "INVALID_PERMISSION_MODE",
                message: message.into(),
            },
        )?;
        to_codex_reasoning_effort(effort.as_deref()).map_err(|error| SettingsError {
            code: "INVALID_EFFORT",
            message: error.to_string(),
        })?;
        let cwd = patch.cwd.clone().or_else(|| base.cwd.clone());
        if cwd.as_deref().is_some_and(|cwd| cwd.trim().is_empty()) {
            return Err(SettingsError {
                code: "INVALID_CWD",
                message: "Choose a nonempty working directory.".into(),
            });
        }
        let collaboration_mode = match patch.collaboration_mode.as_deref() {
            Some(value) => Some(CodexWorkMode::parse(value).ok_or_else(|| SettingsError {
                code: "INVALID_COLLABORATION_MODE",
                message: "Choose Build or Plan work mode.".into(),
            })?),
            None => base.collaboration_mode,
        };
        Ok(Self {
            model,
            effort,
            cwd,
            sandbox,
            permission_mode,
            collaboration_mode,
        })
    }

    /// The caller supplies the same wire-normalized effort used by turn/start.
    /// Default is explicit: omission could retain a previous native Plan mode.
    pub fn native_collaboration_mode(&self) -> Option<Value> {
        Some(
            json!({"mode":self.collaboration_mode.unwrap_or(CodexWorkMode::Default).as_str(),"settings":{
                "model":self.model,"reasoning_effort":self.effort,"developer_instructions":null,
            }}),
        )
    }

    pub fn as_json(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("Codex settings serialize");
        value["effort"] = json!(self.effort);
        value["collaborationMode"] =
            json!(self.collaboration_mode.unwrap_or(CodexWorkMode::Default));
        value
    }

    /// Adopt overrides actually supplied to thread/start or thread/resume.
    /// Effort and work mode are next-turn choices: those requests do not send
    /// them. Their native echoes are retained separately as thread observations.
    pub fn adopt_native(&mut self, native: &Value) {
        if let Some(model) = native
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.model = model.into();
        }
        if let Some(cwd) = native.get("cwd").and_then(Value::as_str) {
            self.cwd = Some(cwd.into());
        }
        if let Some(policy) = native.get("approvalPolicy").and_then(Value::as_str) {
            self.permission_mode = Some(policy.into());
        }
        if let Some(sandbox) = native.get("sandbox") {
            let mode = sandbox
                .as_str()
                .or_else(|| sandbox.get("type").and_then(Value::as_str));
            self.sandbox = match mode {
                Some("readOnly" | "read-only") => Some("read-only".into()),
                Some("workspaceWrite" | "workspace-write") => Some("workspace-write".into()),
                Some("dangerFullAccess" | "danger-full-access") => {
                    Some("danger-full-access".into())
                }
                _ => self.sandbox.clone(),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_mode_uses_selected_model_and_effort_without_changing_sandbox() {
        let settings = CodexEffectiveSettings {
            model: "provider-current".into(),
            effort: Some("xhigh".into()),
            cwd: Some("/work".into()),
            sandbox: Some("read-only".into()),
            permission_mode: Some("on-request".into()),
            collaboration_mode: Some(CodexWorkMode::Plan),
        };
        assert_eq!(
            settings.native_collaboration_mode(),
            Some(
                json!({"mode":"plan","settings":{"model":"provider-current","reasoning_effort":"xhigh","developer_instructions":null}})
            )
        );
        assert_eq!(settings.sandbox.as_deref(), Some("read-only"));
    }
}
