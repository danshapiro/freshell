//! Translate Codex's bidirectional requests into the shared approval/question UI.
use super::*;
use freshell_codex::protocol::RequestId;
use freshell_protocol::{FreshAgentApprovalRespond, FreshAgentQuestionRespond, StringOrNumber};

pub(super) type ControlRegistry =
    Arc<TokioMutex<HashMap<String, Arc<TokioMutex<PendingControls>>>>>;

#[derive(Default)]
pub(super) struct PendingControls {
    requests: Vec<PendingRequest>,
    last_waiting_at: Option<i64>,
}

struct PendingRequest {
    id: RequestId,
    method: String,
    params: Value,
    public: Value,
    question: bool,
}

fn request_key(id: &RequestId) -> String {
    id.to_json().to_string()
}
fn response_key(id: &StringOrNumber) -> String {
    match id {
        StringOrNumber::Str(s) => s.clone(),
        StringOrNumber::Num(n) => n.to_string(),
    }
}

fn normalize_request(id: RequestId, method: &str, params: &Value) -> Option<PendingRequest> {
    let key = request_key(&id);
    let question = method == "item/tool/requestUserInput";
    let public = if question {
        let questions = params.get("questions")?.as_array()?.iter().filter_map(|entry| {
            let mut value = json!({ "id": entry.get("id")?.as_str()?, "question": entry.get("question")?.as_str()? });
            if let Some(header) = entry.get("header").and_then(Value::as_str) { value["header"] = json!(header); }
            if let Some(options) = entry.get("options").and_then(Value::as_array) {
                value["options"] = json!(options.iter().filter_map(|option| Some(json!({
                    "label": option.get("label")?.as_str()?,
                    "description": option.get("description").and_then(Value::as_str).unwrap_or(""),
                }))).collect::<Vec<_>>());
            }
            Some(value)
        }).collect::<Vec<_>>();
        if questions.is_empty() {
            return None;
        }
        json!({ "requestId": key, "questions": questions })
    } else {
        let (tool, input) = match method {
            "item/commandExecution/requestApproval" => (
                "Bash",
                json!({ "command": params.get("command"), "cwd": params.get("cwd") }),
            ),
            "item/fileChange/requestApproval" => (
                "Edit",
                json!({ "path": params.get("grantRoot"), "itemId": params.get("itemId") }),
            ),
            "item/permissions/requestApproval" => {
                ("Additional permissions", params.get("permissions")?.clone())
            }
            _ => return None,
        };
        let mut value = json!({ "requestId": key, "toolName": tool, "input": input });
        if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
            value["toolUseID"] = json!(item_id);
        }
        if let Some(reason) = params.get("reason").and_then(Value::as_str) {
            value["decisionReason"] = json!(reason);
        }
        if let Some(path) = params.get("grantRoot").and_then(Value::as_str) {
            value["blockedPath"] = json!(path);
        }
        value
    };
    Some(PendingRequest {
        id,
        method: method.to_string(),
        params: params.clone(),
        public,
        question,
    })
}

impl FreshCodexState {
    async fn session_controls(&self, session_id: &str) -> Arc<TokioMutex<PendingControls>> {
        self.controls
            .lock()
            .await
            .entry(session_id.into())
            .or_default()
            .clone()
    }
    fn control_event(&self, session_id: &str, event: Value) {
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: PROVIDER.into(),
            session_type: SESSION_TYPE.into(),
            session_id: session_id.into(),
            event,
        }));
    }

    fn cancelled_control(&self, session_id: &str, request: &PendingRequest) {
        self.control_event(session_id, json!({
            "type": if request.question { "freshAgent.question.cancelled" } else { "freshAgent.permission.cancelled" },
            "sessionId": session_id, "requestId": request_key(&request.id),
        }));
    }

    pub(super) async fn clear_controls(&self, session_id: &str) {
        let controls = self.session_controls(session_id).await;
        let mut pending = controls.lock().await;
        for request in pending.requests.drain(..) {
            self.cancelled_control(session_id, &request);
        }
    }

    pub(super) async fn overlay_controls(&self, session_id: &str, snapshot: &mut Value) {
        snapshot["capabilities"]["approvals"] = json!(true);
        snapshot["capabilities"]["questions"] = json!(true);
        let controls = self.session_controls(session_id).await;
        let pending = controls.lock().await;
        snapshot["pendingApprovals"] = json!(pending
            .requests
            .iter()
            .filter(|r| !r.question)
            .map(|r| &r.public)
            .collect::<Vec<_>>());
        snapshot["pendingQuestions"] = json!(pending
            .requests
            .iter()
            .filter(|r| r.question)
            .map(|r| &r.public)
            .collect::<Vec<_>>());
    }

    pub(super) async fn consume_control_notification(
        &self,
        session_id: &str,
        notification: &CodexNotification,
    ) -> bool {
        match notification {
            CodexNotification::ServerRequest { id, method, params } => {
                let client = self
                    .sessions
                    .lock()
                    .await
                    .get(session_id)
                    .map(|s| s.client.clone());
                if params.get("threadId").and_then(Value::as_str) != Some(session_id) {
                    if let Some(client) = client {
                        let _ = client
                            .reject_request(id, "Request does not belong to this conversation")
                            .await;
                    }
                    return true;
                }
                let Some(request) = normalize_request(id.clone(), method, params) else {
                    tracing::warn!(
                        provider = PROVIDER,
                        session_id,
                        method,
                        "freshagent.codex.unsupported_request"
                    );
                    if let Some(client) = client {
                        let _ = client
                            .reject_request(id, "This Codex request is not supported by Freshell")
                            .await;
                    }
                    self.emit_fresh_agent_error(
                        session_id,
                        "UNSUPPORTED_CAPABILITY",
                        "Codex requested an unsupported action. Try continuing with a message.",
                    );
                    return true;
                };
                let controls = self.session_controls(session_id).await;
                let mut pending = controls.lock().await;
                let was_empty = pending.requests.is_empty();
                pending.requests.retain(|r| r.id != request.id);
                let event = if request.question {
                    json!({ "type": "freshAgent.question.request", "sessionId": session_id, "requestId": request_key(id), "questions": request.public["questions"] })
                } else {
                    json!({ "type": "freshAgent.permission.request", "sessionId": session_id, "requestId": request_key(id), "tool": { "name": request.public["toolName"], "input": request.public["input"] } })
                };
                pending.requests.push(request);
                self.control_event(session_id, event);
                if was_empty {
                    let at = freshell_codex::next_monotonic_turn_complete_at(
                        pending.last_waiting_at,
                        now_ms(),
                    );
                    pending.last_waiting_at = Some(at);
                    self.control_event(session_id, json!({ "type": "freshAgent.turn.waiting", "sessionId": session_id, "at": at }));
                }
                tracing::info!(
                    provider = PROVIDER,
                    session_id,
                    method,
                    "freshagent.codex.request_pending"
                );
                true
            }
            CodexNotification::Other { method, params } if method == "serverRequest/resolved" => {
                if let Some(params) = params {
                    if params.get("threadId").and_then(Value::as_str) == Some(session_id) {
                        let controls = self.session_controls(session_id).await;
                        let mut pending = controls.lock().await;
                        let id = params.get("requestId");
                        pending.requests.retain(|request| {
                            if id == Some(&request.id.to_json()) {
                                self.cancelled_control(session_id, request);
                                false
                            } else {
                                true
                            }
                        });
                    }
                }
                true
            }
            CodexNotification::TurnCompleted(event) if event.thread_id == session_id => {
                let controls = self.session_controls(session_id).await;
                let mut pending = controls.lock().await;
                pending.requests.retain(|request| {
                    if event.turn_id.as_deref().is_none_or(|id| {
                        request.params.get("turnId").and_then(Value::as_str) == Some(id)
                    }) {
                        self.cancelled_control(session_id, request);
                        false
                    } else {
                        true
                    }
                });
                false
            }
            CodexNotification::ThreadClosed { thread_id } if thread_id == session_id => {
                self.clear_controls(session_id).await;
                false
            }
            _ => false,
        }
    }

    pub async fn handle_approval_respond(&self, msg: FreshAgentApprovalRespond) {
        let allow = match msg.decision.get("behavior").and_then(Value::as_str) {
            Some("allow") => true,
            Some("deny") => false,
            _ => {
                self.emit_fresh_agent_error(
                    &msg.session_id,
                    "INVALID_DECISION",
                    "Choose Allow or Deny for the Codex request.",
                );
                return;
            }
        };
        self.respond_control(&msg.session_id, &response_key(&msg.request_id), false, |request| {
            Ok(if request.method == "item/permissions/requestApproval" {
                json!({ "permissions": if allow { request.params["permissions"].clone() } else { json!({}) }, "scope": "turn" })
            } else { json!({ "decision": if allow { "accept" } else { "decline" } }) })
        }).await;
    }

    pub async fn handle_question_respond(&self, msg: FreshAgentQuestionRespond) {
        self.respond_control(
            &msg.session_id,
            &response_key(&msg.request_id),
            true,
            |request| {
                let mut answers = Map::new();
                for question in request.public["questions"]
                    .as_array()
                    .expect("normalized questions")
                {
                    let id = question["id"].as_str().expect("normalized id");
                    let text = question["question"].as_str().expect("normalized question");
                    let Some(answer) = msg.answers.get(id).or_else(|| msg.answers.get(text)) else {
                        return Err("Answer every question before submitting.");
                    };
                    answers.insert(id.into(), json!({ "answers": [answer] }));
                }
                Ok(json!({ "answers": answers }))
            },
        )
        .await;
    }

    async fn respond_control(
        &self,
        session_id: &str,
        key: &str,
        question: bool,
        build: impl FnOnce(&PendingRequest) -> Result<Value, &'static str>,
    ) {
        let client = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| s.client.clone());
        let Some(client) = client else {
            self.emit_fresh_agent_error(
                session_id,
                "INVALID_SESSION_ID",
                "Codex session is no longer available.",
            );
            return;
        };
        // Keep membership until the transport write succeeds; duplicate clicks cannot
        // answer twice and a failed write leaves the banner available for retry.
        let controls = self.session_controls(session_id).await;
        let mut pending = controls.lock().await;
        let Some(index) = pending
            .requests
            .iter()
            .position(|r| request_key(&r.id) == key && r.question == question)
        else {
            self.emit_fresh_agent_error(
                session_id,
                "REQUEST_UNAVAILABLE",
                "This Codex request is no longer waiting for an answer.",
            );
            return;
        };
        let request = &pending.requests[index];
        let result = match build(request) {
            Ok(value) => value,
            Err(message) => {
                self.emit_fresh_agent_error(session_id, "INVALID_ANSWER", message);
                return;
            }
        };
        if let Err(error) = client.respond(&request.id, result).await {
            tracing::warn!(provider = PROVIDER, session_id, error = %error, "freshagent.codex.respond_failed");
            self.emit_fresh_agent_error(
                session_id,
                "RESPONSE_FAILED",
                &format!("Could not send your answer to Codex: {error}"),
            );
            return;
        }
        let request = pending.requests.remove(index);
        self.cancelled_control(session_id, &request);
        tracing::info!(
            provider = PROVIDER,
            session_id,
            "freshagent.codex.request_answered"
        );
    }
}

#[cfg(test)]
mod tests;
