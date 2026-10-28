//! One create recipe for the REST tab and split paths. Defaults are read once
//! and the same resolved values launch the runtime and populate the web pane.

use crate::rest_lane::{self, RestLaneCreate, RestLaneCreated, RestLaneError, RestLaneErrorKind};
use crate::{naming, FreshAgentState};
use freshell_protocol::{SessionLocator, SettingsFreshAgent};
use serde_json::{json, Value};

impl FreshAgentState {
    pub(crate) async fn abandon_rest_create(
        &self,
        lane: &rest_lane::SharedFreshAgentRestLane,
        request: &RestLaneCreate,
        created: &RestLaneCreated,
    ) -> axum::response::Response {
        if let Some(pane_id) = request.pane_id.as_deref() {
            self.layout.rollback_split(pane_id);
        }
        if let Err(error) = lane.abandon_create(request, created).await {
            tracing::error!(event = "agent_api.abandoned_create_cleanup_failed", request_id = %request.request_id, session_id = %created.session_id, code = %error.code, message = %error.message);
            return crate::rest_lane_failure(error);
        }
        cancelled_create_response()
    }

    pub fn set_rest_create_settings_reader(
        &self,
        reader: rest_lane::RestCreateSettingsReader,
    ) -> Result<(), &'static str> {
        self.rest_create_settings
            .set(reader)
            .map_err(|_| "REST create settings reader is already installed")
    }

    pub(crate) async fn build_rest_lane_create(
        &self,
        provider: &str,
        session_type: &str,
        body: &Value,
    ) -> Result<RestLaneCreate, RestLaneError> {
        let invalid =
            |message| RestLaneError::new(RestLaneErrorKind::BadRequest, "INVALID_REQUEST", message);
        let inputs = rest_lane::provider_inputs(body).map_err(invalid)?;
        let (observed_epoch, observed_generation) = rest_lane::observed_fence(body)?;
        let native_session_id = match body.get("sessionRef") {
            None => None,
            Some(value) => match serde_json::from_value::<SessionLocator>(value.clone()) {
                Ok(locator) if locator.provider == provider && !locator.session_id.is_empty() => {
                    Some(locator.session_id)
                }
                _ => {
                    return Err(invalid(format!(
                        "sessionRef must identify a {provider} session"
                    )))
                }
            },
        };
        let mut request = RestLaneCreate {
            request_id: uuid::Uuid::new_v4().simple().to_string(),
            provider: provider.into(),
            session_type: session_type.into(),
            cwd: body.get("cwd").and_then(Value::as_str).map(str::to_string),
            model: body
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            effort: body
                .get("effort")
                .map(|value| {
                    serde_json::from_value(value.clone())
                        .map_err(|_| invalid("effort must be a string or null".into()))
                })
                .transpose()?,
            collaboration_mode: body
                .get("collaborationMode")
                .map(|value| {
                    serde_json::from_value(value.clone())
                        .map_err(|_| invalid("collaborationMode must be a string".into()))
                })
                .transpose()?,
            native_session_id,
            plugins: inputs.plugins,
            model_selection: inputs.model_selection,
            permission_mode: inputs.permission_mode,
            sandbox: inputs.sandbox,
            observed_epoch,
            observed_generation,
            ..Default::default()
        };
        if matches!(provider, "claude" | "codex") {
            let settings = if let Some(reader) = self.rest_create_settings.get() {
                reader().await
            } else {
                rest_lane::RestCreateSettings::from(SettingsFreshAgent {
                    default_plugins: vec![],
                    enabled: false,
                    providers: json!({}),
                    initial_setup_done: None,
                })
            };
            if provider == "codex" {
                resolve_codex_rest_create(&mut request, &settings)?;
            } else {
                let resolved = crate::claude_create_defaults::resolve_claude_rest_create(
                    session_type,
                    body,
                    &settings.fresh_agent,
                )
                .map_err(invalid)?;
                request.model = Some(resolved.model);
                request.model_selection = Some(resolved.model_selection);
                request.model_effort_levels = resolved.model_effort_levels;
                request.effort = resolved.effort.map(Some);
                request.permission_mode = Some(resolved.permission_mode);
                request.plugins = Some(resolved.plugins);
            }
        }
        if naming::is_unified_agent_mode(None, Some(session_type)) {
            request.naming_handle = Some(
                body.get("namingHandle")
                    .and_then(Value::as_str)
                    .filter(|handle| !handle.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("nh-{}", uuid::Uuid::new_v4().simple())),
            );
        }
        self.admit_rest_create_name(&request, body).await?;
        Ok(request)
    }

    async fn admit_rest_create_name(
        &self,
        request: &RestLaneCreate,
        body: &Value,
    ) -> Result<(), RestLaneError> {
        use freshell_protocol::session_names::{NameIntent, NamedProvider, SessionNameRef};
        let intent = body
            .get("nameIntent")
            .map(|value| serde_json::from_value::<NameIntent>(value.clone()))
            .transpose()
            .map_err(|_| {
                RestLaneError::new(
                    RestLaneErrorKind::BadRequest,
                    "INVALID_REQUEST",
                    "nameIntent must be user or automatic",
                )
            })?
            .unwrap_or(NameIntent::Automatic);
        let (Some(handle), Some(sink)) = (request.naming_handle.as_ref(), self.naming()) else {
            return Ok(());
        };
        let provider = match request.provider.as_str() {
            "claude" => NamedProvider::Claude,
            "codex" => NamedProvider::Codex,
            "opencode" => NamedProvider::Opencode,
            _ => return Ok(()),
        };
        let pending = SessionNameRef::Pending { id: handle.clone() };
        match sink
            .ensure_pending(naming::PendingNameInput {
                handle: handle.clone(),
                provider,
                cwd: request.cwd.clone(),
            })
            .await
        {
            Ok(_) => {
                if let Some(name) = body
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                {
                    if let Err(error) = sink
                        .rename(naming::RenameNameInput {
                            target: pending.clone(),
                            name: name.to_string(),
                            intent,
                            if_revision: None,
                            cwd: request.cwd.clone(),
                        })
                        .await
                    {
                        naming::log_name_error("rename", &pending, &error);
                    }
                }
            }
            Err(error) => naming::log_name_error("ensure_pending", &pending, &error),
        }
        Ok(())
    }
}

pub(crate) fn cancelled_create_response() -> axum::response::Response {
    let mut error = RestLaneError::new(
        RestLaneErrorKind::Conflict,
        "PANE_CREATE_CANCELLED",
        "the pane was closed while its runtime was starting",
    );
    error.retryable = Some(false);
    crate::rest_lane_failure(error)
}

pub(crate) fn pane_content(request: &RestLaneCreate, created: &RestLaneCreated) -> Value {
    let mut content = json!({
        "kind": "fresh-agent", "sessionType": request.session_type, "provider": request.provider,
        "sessionId": created.session_id, "createRequestId": request.request_id, "status": "connected",
    });
    for (key, value) in [
        ("initialCwd", request.cwd.as_ref()),
        ("model", request.model.as_ref()),
        ("effort", request.effort.as_ref().and_then(Option::as_ref)),
        ("permissionMode", request.permission_mode.as_ref()),
        ("namingHandle", request.naming_handle.as_ref()),
    ] {
        if let Some(value) = value {
            content[key] = json!(value);
        }
    }
    if request.provider == "codex" {
        if request.effort.is_some() {
            content["effortIsNativeDefault"] = json!(request.effort == Some(None));
        }
        if let Some(mode) = &request.collaboration_mode {
            content["collaborationMode"] = json!(mode);
        }
    }
    if let Some(value) = &request.plugins {
        content["plugins"] = json!(value);
    }
    if let Some(value) = &request.model_selection {
        content["modelSelection"] = json!(value);
    }
    if let Some(value) = &request.sandbox {
        content["sandbox"] = json!(value);
    }
    if let Some(value) = &request.model_effort_levels {
        content["modelEffortLevels"] = json!({ "modelId": request.model, "levels": value });
    }
    if let Some(value) = &created.session_ref {
        content["sessionRef"] = json!(value);
    }
    if let Some(settings) = &created.effective_settings {
        for (from, to) in [
            ("model", "model"),
            ("cwd", "initialCwd"),
            ("sandbox", "sandbox"),
            ("permissionMode", "permissionMode"),
            ("collaborationMode", "collaborationMode"),
        ] {
            if let Some(value) = settings.get(from) {
                if value.is_null() {
                    content.as_object_mut().expect("pane object").remove(to);
                } else {
                    content[to] = value.clone();
                }
            }
        }
        if let Some(effort) = settings.get("effort") {
            if effort.is_null() {
                content
                    .as_object_mut()
                    .expect("pane object")
                    .remove("effort");
            } else {
                content["effort"] = effort.clone();
            }
            if request.provider == "codex" {
                content["effortIsNativeDefault"] = json!(effort.is_null());
            }
        }
    }
    content
}

fn resolve_codex_rest_create(
    request: &mut RestLaneCreate,
    settings: &rest_lane::RestCreateSettings,
) -> Result<(), RestLaneError> {
    use crate::codex::settings::CodexEffectiveSettings;
    if request
        .effort
        .as_ref()
        .and_then(Option::as_deref)
        .is_some_and(|effort| effort.trim().is_empty())
    {
        return Err(RestLaneError::new(
            RestLaneErrorKind::BadRequest,
            "INVALID_EFFORT",
            "effort must be a nonempty string or null for native Default",
        ));
    }
    let saved = &settings.fresh_agent.providers["freshcodex"];
    let cli = settings
        .coding_cli
        .as_ref()
        .and_then(|settings| settings.providers.get("codex"));
    // A canonical resume inherits its conversation's saved choices in the runtime.
    // Provider defaults apply only when creating a new conversation.
    if request.native_session_id.is_none() {
        let selected_model = match &request.model_selection {
            Some(selection) => selection
                .as_ref()
                .map(|selection| selection.model_id.clone()),
            None => saved
                .pointer("/modelSelection/modelId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        request.model = request
            .model
            .take()
            .or(selected_model)
            .or_else(|| cli.and_then(|settings| settings.model.clone()));
        request.effort = request.effort.take().or_else(|| {
            Some(
                saved
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )
        });
        request.cwd = request
            .cwd
            .take()
            .or_else(|| saved.get("cwd").and_then(Value::as_str).map(str::to_owned));
        request.permission_mode = request
            .permission_mode
            .take()
            .or_else(|| {
                saved
                    .get("defaultPermissionMode")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .or_else(|| cli.and_then(|settings| settings.permission_mode.clone()))
            .or_else(|| Some("on-request".into()));
        request.collaboration_mode = request
            .collaboration_mode
            .take()
            .or_else(|| {
                saved
                    .get("collaborationMode")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .or_else(|| Some("default".into()));
        if request.sandbox.is_none() {
            let sandbox = saved
                .get("sandbox")
                .and_then(Value::as_str)
                .or_else(|| cli.and_then(|settings| settings.sandbox.as_deref()));
            request.sandbox = sandbox
                .map(|value| serde_json::from_value(json!(value)))
                .transpose()
                .map_err(|_| {
                    RestLaneError::new(
                        RestLaneErrorKind::BadRequest,
                        "INVALID_SANDBOX",
                        "saved Codex file access is invalid",
                    )
                })?;
        }
    }
    let effective = CodexEffectiveSettings::resolve(
        &CodexEffectiveSettings {
            model: request.model.clone().unwrap_or_default(),
            effort: request.effort.clone().flatten(),
            cwd: request.cwd.clone(),
            sandbox: None,
            permission_mode: None,
            collaboration_mode: None,
        },
        &freshell_protocol::FreshAgentSendSettings {
            sandbox: request.sandbox,
            permission_mode: request.permission_mode.clone(),
            collaboration_mode: request.collaboration_mode.clone(),
            ..Default::default()
        },
    )
    .map_err(|error| {
        RestLaneError::new(RestLaneErrorKind::BadRequest, error.code, error.message)
    })?;
    // Keep resume omissions absent; otherwise full defaults would override saved intent.
    if request.native_session_id.is_none() || request.model.is_some() {
        request.model = Some(effective.model);
    }
    if request.effort.is_some() {
        request.effort = Some(effective.effort);
    }
    request.permission_mode = effective.permission_mode;
    request.sandbox = effective
        .sandbox
        .map(|sandbox| serde_json::from_value(json!(sandbox)).expect("validated Codex sandbox"));
    request.collaboration_mode = effective
        .collaboration_mode
        .map(|mode| mode.as_str().into());
    Ok(())
}
