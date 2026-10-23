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
                .and_then(Value::as_str)
                .map(str::to_string),
            native_session_id,
            plugins: inputs.plugins,
            model_selection: inputs.model_selection,
            permission_mode: inputs.permission_mode,
            sandbox: inputs.sandbox,
            observed_epoch,
            observed_generation,
            ..Default::default()
        };
        if provider == "claude" {
            let settings = if let Some(reader) = self.rest_create_settings.get() {
                reader().await
            } else {
                SettingsFreshAgent {
                    default_plugins: vec![],
                    enabled: false,
                    providers: json!({}),
                    initial_setup_done: None,
                }
            };
            let resolved = crate::claude_create_defaults::resolve_claude_rest_create(
                session_type,
                body,
                &settings,
            )
            .map_err(invalid)?;
            request.model = Some(resolved.model);
            request.model_selection = Some(resolved.model_selection);
            request.model_effort_levels = resolved.model_effort_levels;
            request.effort = resolved.effort;
            request.permission_mode = Some(resolved.permission_mode);
            request.plugins = Some(resolved.plugins);
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
        ("effort", request.effort.as_ref()),
        ("permissionMode", request.permission_mode.as_ref()),
        ("namingHandle", request.naming_handle.as_ref()),
    ] {
        if let Some(value) = value {
            content[key] = json!(value);
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
    content
}
