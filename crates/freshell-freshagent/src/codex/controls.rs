//! Translate Codex's bidirectional requests into the shared approval/question UI.
use super::*;
use freshell_codex::protocol::RequestId;
use freshell_protocol::{
    FreshAgentApprovalRespond, FreshAgentElicitationRespond, FreshAgentQuestionRespond,
    StringOrNumber,
};
use std::collections::HashSet;

pub(super) type ControlRegistry = Arc<StdMutex<HashMap<String, Arc<SessionControls>>>>;
type ControlSource = StdMutex<projection::CodexProjection>;

#[derive(Default)]
pub(super) struct SessionControls {
    pending: TokioMutex<PendingControls>,
    child_turns: StdMutex<HashMap<String, ChildControlTurn>>,
    /// Actual unresolved reply-bearing native RPCs, independent of UI metadata.
    awaited_control_count: std::sync::atomic::AtomicUsize,
    last_waiting_at: std::sync::atomic::AtomicI64,
    last_question_available_at: std::sync::atomic::AtomicI64,
}
struct ChildControlTurn {
    turn_id: String,
    native_client: Arc<CodexAppServerClient>,
    source: std::sync::Weak<ControlSource>,
}
impl SessionControls {
    async fn lock(&self) -> tokio::sync::MutexGuard<'_, PendingControls> {
        self.pending.lock().await
    }
}

#[derive(Default)]
pub(super) struct PendingControls {
    requests: Vec<PendingRequest>,
    /// The session's waiting-edge clock: each 0→≥1 pending transition rings
    /// `freshAgent.turn.waiting` at a strictly-monotonic `at`.
    waiting_clock: crate::attention::AttentionClock,
    async_question_turn: Option<String>,
    async_question_ids: HashSet<String>,
    async_actions: HashMap<(String, String), i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ControlKind {
    Approval,
    Question,
    Elicitation,
}

struct PendingRequest {
    id: RequestId,
    method: String,
    params: Value,
    public: Value,
    kind: ControlKind,
    native_client: Arc<CodexAppServerClient>,
    source: std::sync::Weak<ControlSource>,
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

fn normalize_request(
    id: RequestId,
    method: &str,
    params: &Value,
    native_client: Arc<CodexAppServerClient>,
    source: &Arc<ControlSource>,
) -> Option<PendingRequest> {
    // Native IDs can be reused after resolution or a sidecar restart. The public
    // key identifies this operation; the original typed ID stays on its client.
    let key = json!([id.to_json(), uuid::Uuid::new_v4().to_string()]).to_string();
    let question = method == "item/tool/requestUserInput";
    if method != "mcpServer/elicitation/request"
        && !question
        && params
            .get("availableDecisions")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                !choices.iter().any(|choice| {
                    choice.as_str().is_some_and(|value| {
                        matches!(value, "accept" | "acceptForSession" | "decline" | "cancel")
                    })
                })
            })
    {
        return None;
    }
    let public = if method == "mcpServer/elicitation/request" {
        let mut value = elicitation::normalize(params)?;
        value["requestId"] = json!(key);
        value
    } else if question {
        let questions = params.get("questions")?.as_array()?.iter().filter_map(|entry| {
            let mut value = json!({ "id": entry.get("id")?.as_str()?, "question": entry.get("question")?.as_str()? });
            value["isOther"] = json!(entry.get("isOther").and_then(Value::as_bool).unwrap_or(false));
            value["isSecret"] = json!(entry.get("isSecret").and_then(Value::as_bool).unwrap_or(false));
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
        let mut value = json!({ "requestId": key, "questions": questions });
        if let Some(blocking) = params.get("isBlocking").and_then(Value::as_bool) {
            value["isBlocking"] = json!(blocking);
        }
        value
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
        let mut value = json!({ "requestId": key, "toolName": tool, "input": input, "native": params, "providerRequest": {"id": id.to_json(), "method": method} });
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
    let mut public = public;
    let mut identity = json!({"id":id.to_json(),"method":method});
    for locator in [
        "threadId",
        "turnId",
        "itemId",
        "approvalId",
        "serverName",
        "elicitationId",
    ] {
        if let Some(value) = params.get(locator) {
            identity[locator] = value.clone();
        }
    }
    public["providerRequest"] = identity;
    Some(PendingRequest {
        id,
        method: method.to_string(),
        params: params.clone(),
        public,
        native_client,
        source: Arc::downgrade(source),
        kind: if question {
            ControlKind::Question
        } else if method == "mcpServer/elicitation/request" {
            ControlKind::Elicitation
        } else {
            ControlKind::Approval
        },
    })
}

fn control_request_event(session_id: &str, request: &PendingRequest) -> Value {
    let mut event = request.public.clone();
    event["type"] = json!(match request.kind {
        ControlKind::Approval => "freshAgent.permission.request",
        ControlKind::Question => "freshAgent.question.request",
        ControlKind::Elicitation => "freshAgent.elicitation.request",
    });
    event["sessionId"] = json!(session_id);
    if request.kind == ControlKind::Approval {
        event["tool"] = json!({"name":request.public["toolName"],"input":request.public["input"]});
    }
    event
}

impl FreshCodexState {
    async fn session_controls(&self, session_id: &str) -> Arc<SessionControls> {
        self.controls
            .lock()
            .expect("codex controls registry")
            .entry(session_id.into())
            .or_default()
            .clone()
    }
    pub(super) fn awaited_control_count(&self, session_id: &str) -> usize {
        self.controls
            .lock()
            .expect("codex controls registry")
            .get(session_id)
            .map_or(0, |controls| {
                controls.awaited_control_count.load(Ordering::SeqCst)
            })
    }

    async fn publish_control_membership(
        &self,
        session_id: &str,
        controls: &SessionControls,
        pending: &PendingControls,
    ) {
        controls
            .awaited_control_count
            .store(pending.requests.len(), Ordering::SeqCst);
        if pending.requests.is_empty() {
            controls.last_waiting_at.store(0, Ordering::SeqCst);
            self.attention.clear_waiting(session_id);
        }
        if let Some((_, quiet, in_flight, _, _)) = self.quiet_handles(session_id).await {
            note_codex_activity(self, session_id, &in_flight, &quiet);
        }
    }

    pub(super) async fn contextual_answer_targets(
        &self,
        session_id: &str,
        text: &str,
    ) -> HashMap<(String, String), i64> {
        let keys = text
            .lines()
            .filter_map(|line| {
                let value: Value =
                    serde_json::from_str(line.strip_prefix("Answer to Codex question: ")?).ok()?;
                value["question"].as_str()?;
                value["answer"].as_str()?;
                Some((
                    value["itemId"].as_str()?.to_owned(),
                    value["questionId"].as_str()?.to_owned(),
                ))
            })
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return HashMap::new();
        }
        let controls = self
            .controls
            .lock()
            .expect("codex controls registry")
            .get(session_id)
            .cloned();
        let Some(controls) = controls else {
            return HashMap::new();
        };
        let pending = controls.lock().await;
        keys.into_iter()
            .filter_map(|key| pending.async_actions.get(&key).map(|at| (key, *at)))
            .collect()
    }

    pub(super) async fn acknowledge_contextual_answers(
        &self,
        session_id: &str,
        targets: HashMap<(String, String), i64>,
    ) {
        if targets.is_empty() {
            return;
        }
        let controls = self.session_controls(session_id).await;
        let mut pending = controls.lock().await;
        pending
            .async_actions
            .retain(|key, at| targets.get(key) != Some(at));
        let available = pending.async_actions.values().copied().max().unwrap_or(0);
        controls
            .last_question_available_at
            .store(available, Ordering::SeqCst);
        self.notify_retained();
    }

    /// Ready-frame marks read retained runtime state only. They never hydrate or resume native history.
    pub async fn attention_marks(&self) -> Vec<freshell_protocol::FreshAgentAttentionMark> {
        let sessions = self
            .sessions
            .lock()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), session.last_turn_complete_at.clone()))
            .collect::<Vec<_>>();
        let controls = self.controls.lock().expect("codex controls registry");
        let mut marks: std::collections::BTreeMap<
            String,
            freshell_protocol::FreshAgentAttentionMark,
        > = self
            .attention
            .snapshot()
            .into_iter()
            .map(|mark| {
                let id = mark.session_id.clone();
                (
                    id,
                    freshell_protocol::FreshAgentAttentionMark {
                        provider: PROVIDER.into(),
                        session_type: mark.session_type,
                        session_id: mark.session_id,
                        last_turn_complete_at: mark.last_turn_complete_at,
                        last_waiting_at: mark.last_waiting_at,
                        last_question_available_at: None,
                    },
                )
            })
            .collect();
        for (id, complete) in sessions {
            let mark = marks.entry(id.clone()).or_insert_with(|| {
                freshell_protocol::FreshAgentAttentionMark {
                    provider: PROVIDER.into(),
                    session_type: SESSION_TYPE.into(),
                    session_id: id,
                    last_turn_complete_at: None,
                    last_waiting_at: None,
                    last_question_available_at: None,
                }
            });
            mark.last_turn_complete_at = mark
                .last_turn_complete_at
                .max(*complete.lock().expect("attention complete clock"));
        }
        for (id, mark) in &mut marks {
            if let Some(retained) = controls.get(id) {
                let waiting = retained.last_waiting_at.load(Ordering::SeqCst);
                let available = retained.last_question_available_at.load(Ordering::SeqCst);
                mark.last_waiting_at = (waiting > 0).then_some(waiting);
                mark.last_question_available_at = (available > 0).then_some(available);
            }
        }
        marks.into_values().collect()
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
            "type": match request.kind { ControlKind::Question => "freshAgent.question.cancelled", ControlKind::Approval => "freshAgent.permission.cancelled", ControlKind::Elicitation => "freshAgent.elicitation.cancelled" },
            "sessionId": session_id, "requestId": request.public["requestId"],
        }));
    }

    pub(super) async fn clear_controls(&self, session_id: &str) {
        let controls = self.session_controls(session_id).await;
        let mut pending = controls.lock().await;
        for request in pending.requests.drain(..) {
            self.cancelled_control(session_id, &request);
        }
        controls
            .child_turns
            .lock()
            .expect("child control turns")
            .clear();
        self.publish_control_membership(session_id, &controls, &pending)
            .await;
    }

    /// Retire only operations owned by this exact source. A late old consumer
    /// cannot cancel a replacement incarnation's controls with reused IDs.
    pub(super) async fn clear_source_controls(
        &self,
        session_id: &str,
        source: &Arc<ControlSource>,
    ) {
        let controls = self.session_controls(session_id).await;
        let mut pending = controls.lock().await;
        let source = Arc::downgrade(source);
        pending.requests.retain(|request| {
            if std::sync::Weak::ptr_eq(&request.source, &source) {
                self.cancelled_control(session_id, request);
                false
            } else {
                true
            }
        });
        controls
            .child_turns
            .lock()
            .expect("child control turns")
            .retain(|_, child| !std::sync::Weak::ptr_eq(&child.source, &source));
        self.publish_control_membership(session_id, &controls, &pending)
            .await;
        self.notify_retained();
    }

    pub(super) async fn overlay_controls(&self, session_id: &str, snapshot: &mut Value) {
        snapshot["capabilities"]["approvals"] = json!(true);
        snapshot["capabilities"]["questions"] = json!(true);
        let controls = self.session_controls(session_id).await;
        let pending = controls.lock().await;
        snapshot["pendingElicitations"] = json!(pending
            .requests
            .iter()
            .filter(|r| r.kind == ControlKind::Elicitation)
            .map(|r| &r.public)
            .collect::<Vec<_>>());
        snapshot["pendingApprovals"] = json!(pending
            .requests
            .iter()
            .filter(|r| r.kind == ControlKind::Approval)
            .map(|r| &r.public)
            .collect::<Vec<_>>());
        snapshot["pendingQuestions"] = json!(pending
            .requests
            .iter()
            .filter(|r| r.kind == ControlKind::Question)
            .map(|r| &r.public)
            .collect::<Vec<_>>());
    }

    /// Authoritative retained controls for bridge loss reconciliation; never reads/resumes native history.
    pub async fn retained_control_events(&self, session_id: &str) -> Vec<Value> {
        let controls = self
            .controls
            .lock()
            .expect("codex controls registry")
            .get(session_id)
            .cloned();
        let Some(controls) = controls else {
            return Vec::new();
        };
        let pending = controls.lock().await;
        pending
            .requests
            .iter()
            .map(|request| control_request_event(session_id, request))
            .collect()
    }

    pub(super) async fn consume_control_notification(
        &self,
        session_id: &str,
        notification: &CodexNotification,
        source: &Arc<StdMutex<projection::CodexProjection>>,
    ) -> bool {
        let client = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .filter(|session| Arc::ptr_eq(&session.projection, source))
            .map(|session| session.client.clone());
        let Some(client) = client else {
            return matches!(notification, CodexNotification::ServerRequest { .. });
        };
        match notification {
            CodexNotification::ServerRequest { id, method, params } => {
                let scope_matches = self
                    .control_scope_matches(session_id, params, &client, source, false)
                    .await;
                if !scope_matches {
                    let _ = client.reject_request(id, "Request does not belong to this native conversation or active child turn").await;
                    self.emit_fresh_agent_error(
                        session_id,
                        "REQUEST_UNAVAILABLE",
                        "This Codex request no longer belongs to the active native conversation or child turn.",
                    );
                    return true;
                }
                let Some(mut request) =
                    normalize_request(id.clone(), method, params, client.clone(), source)
                else {
                    tracing::warn!(
                        provider = PROVIDER,
                        session_id,
                        method,
                        request_id = %request_key(id),
                        native_turn_id = params.get("turnId").and_then(|value| value.as_str()),
                        native_item_id = params.get("itemId").and_then(|value| value.as_str()),
                        "freshagent.codex.unsupported_request"
                    );
                    if method == "mcpServer/elicitation/request" {
                        let _ = client
                            .respond(id, json!({"action":"decline","content":null}))
                            .await;
                    } else {
                        let _ = client
                            .reject_request(id, "This Codex request is not supported by Freshell")
                            .await;
                    }
                    self.emit_fresh_agent_error(
                        session_id,
                        if method == "mcpServer/elicitation/request" {"UNSUPPORTED_ELICITATION"} else {"UNSUPPORTED_CAPABILITY"},
                        &format!("Codex requested an unsupported action ({}). Freshell supports flat primitive and enum forms; nested forms and verification actions must be completed outside this form. Try continuing with a message.", params.get("mode").and_then(Value::as_str).unwrap_or(method)),
                    );
                    return true;
                };
                let controls = self.session_controls(session_id).await;
                let mut pending = controls.lock().await;
                let was_empty = pending.requests.is_empty();
                if let Some(index) = pending.requests.iter().position(|r| r.id == request.id) {
                    let previous = pending.requests.remove(index);
                    if previous.method == request.method
                        && previous.params == request.params
                        && Arc::ptr_eq(&previous.native_client, &request.native_client)
                        && std::sync::Weak::ptr_eq(&previous.source, &request.source)
                    {
                        // Repeated native delivery and snapshot replay refer to
                        // the same unresolved operation, including its public key.
                        request.public["requestId"] = previous.public["requestId"].clone();
                    } else {
                        self.cancelled_control(session_id, &previous);
                    }
                }
                let event = control_request_event(session_id, &request);
                pending.requests.push(request);
                self.publish_control_membership(session_id, &controls, &pending)
                    .await;
                self.control_event(session_id, event);
                if was_empty {
                    let at = pending.waiting_clock.mint();
                    controls.last_waiting_at.store(at, Ordering::SeqCst);
                    self.attention.record_waiting(session_id, SESSION_TYPE, at);
                    self.control_event(session_id, json!({ "type": "freshAgent.turn.waiting", "sessionId": session_id, "at": at }));
                }
                tracing::info!(
                    provider = PROVIDER,
                    session_id,
                    method,
                    request_id = %request_key(id),
                    native_turn_id = params.get("turnId").and_then(|value| value.as_str()),
                    native_item_id = params.get("itemId").and_then(|value| value.as_str()),
                    awaited_control_count = pending.requests.len(),
                    "freshagent.codex.request_pending"
                );
                true
            }
            CodexNotification::Other {
                method,
                params: Some(params),
            } if method == "item/completed"
                && params["threadId"] == session_id
                && params["item"]["type"] == "agentMessage"
                && params["item"]["delivery"] == "async" =>
            {
                let item = &params["item"];
                let (Some(item_id), Some(turn_id), Some(questions)) = (
                    item["id"].as_str(),
                    params["turnId"].as_str(),
                    item["questions"].as_array(),
                ) else {
                    return false;
                };
                if questions.is_empty()
                    || !self
                        .control_scope_matches(session_id, params, &client, source, true)
                        .await
                {
                    return false;
                }
                let controls = self.session_controls(session_id).await;
                let mut pending = controls.lock().await;
                if pending.async_question_turn.as_deref() != Some(turn_id) {
                    pending.async_question_ids.clear();
                    pending.async_question_turn = Some(turn_id.into());
                }
                if pending.async_question_ids.insert(item_id.into()) {
                    let at = pending.waiting_clock.mint();
                    for (index, question) in questions.iter().enumerate() {
                        if question["title"].is_string() {
                            let id = question["id"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| index.to_string());
                            pending.async_actions.insert((item_id.to_owned(), id), at);
                        }
                    }
                    controls
                        .last_question_available_at
                        .store(at, Ordering::SeqCst);
                    self.control_event(session_id,json!({"type":"freshAgent.question.available","sessionId":session_id,"itemId":item_id,"turnId":turn_id,"awaited":false,"at":at}));
                }
                false
            }
            CodexNotification::Other { method, params } if method == "serverRequest/resolved" => {
                if let Some(params) = params {
                    if self
                        .control_scope_matches(session_id, params, &client, source, false)
                        .await
                    {
                        let controls = self.session_controls(session_id).await;
                        let mut pending = controls.lock().await;
                        let id = params.get("requestId");
                        pending.requests.retain(|request| {
                            if id == Some(&request.id.to_json())
                                && params["threadId"] == request.params["threadId"]
                            {
                                self.cancelled_control(session_id, request);
                                false
                            } else {
                                true
                            }
                        });
                        self.publish_control_membership(session_id, &controls, &pending)
                            .await;
                    }
                }
                true
            }
            CodexNotification::TurnCompleted(event)
                if (event.thread_id == session_id
                    || self
                        .control_scope_matches(
                            session_id,
                            &json!({"threadId":event.thread_id,"turnId":event.turn_id}),
                            &client,
                            source,
                            false,
                        )
                        .await)
                    && event
                        .params
                        .get("status")
                        .or_else(|| event.params.get("turn").and_then(|turn| turn.get("status")))
                        .and_then(Value::as_str)
                        != Some("inProgress") =>
            {
                let controls = self.session_controls(session_id).await;
                let mut pending = controls.lock().await;
                pending.requests.retain(|request| {
                    if request.params["threadId"] == event.thread_id
                        && event.turn_id.as_deref().is_none_or(|id| {
                            request.params.get("turnId").and_then(Value::as_str) == Some(id)
                        })
                    {
                        self.cancelled_control(session_id, request);
                        false
                    } else {
                        true
                    }
                });
                if event.thread_id != session_id {
                    controls
                        .child_turns
                        .lock()
                        .expect("child control turns")
                        .remove(&event.thread_id);
                }
                self.publish_control_membership(session_id, &controls, &pending)
                    .await;
                false
            }
            CodexNotification::ThreadClosed { thread_id } if thread_id == session_id => {
                self.clear_controls(session_id).await;
                false
            }
            CodexNotification::ThreadClosed { thread_id }
                if self
                    .control_scope_matches(
                        session_id,
                        &json!({"threadId":thread_id}),
                        &client,
                        source,
                        false,
                    )
                    .await =>
            {
                let controls = self.session_controls(session_id).await;
                let mut pending = controls.lock().await;
                pending.requests.retain(|request| {
                    if request.params["threadId"] == *thread_id {
                        self.cancelled_control(session_id, request);
                        false
                    } else {
                        true
                    }
                });
                controls
                    .child_turns
                    .lock()
                    .expect("child control turns")
                    .remove(thread_id);
                self.publish_control_membership(session_id, &controls, &pending)
                    .await;
                false
            }
            _ => false,
        }
    }

    /// Observe child lifecycle before the consumer's turn/started fast path.
    /// Its native spawn, current source/client and actual child turn are required.
    pub(super) async fn observe_child_control_turn(
        &self,
        session_id: &str,
        source: &Arc<StdMutex<projection::CodexProjection>>,
        notification: &CodexNotification,
    ) {
        let CodexNotification::TurnStarted(event) = notification else {
            return;
        };
        if event.thread_id == session_id {
            return;
        }
        let Some(turn_id) = &event.turn_id else {
            return;
        };
        let client = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .filter(|session| Arc::ptr_eq(&session.projection, source))
            .map(|session| session.client.clone());
        let Some(client) = client else {
            return;
        };
        if !source
            .lock()
            .expect("codex projection lock")
            .knows_child_thread(&event.thread_id)
        {
            return;
        }
        let controls = self.session_controls(session_id).await;
        controls
            .child_turns
            .lock()
            .expect("child control turns")
            .insert(
                event.thread_id.clone(),
                ChildControlTurn {
                    turn_id: turn_id.clone(),
                    native_client: client,
                    source: Arc::downgrade(source),
                },
            );
    }

    async fn control_scope_matches(
        &self,
        session_id: &str,
        params: &Value,
        native_client: &Arc<CodexAppServerClient>,
        source: &Arc<ControlSource>,
        allow_retired: bool,
    ) -> bool {
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(session_id) else {
            return false;
        };
        if session.exited.load(Ordering::SeqCst)
            || source
                .lock()
                .expect("codex projection lock")
                .source_retired()
            || !Arc::ptr_eq(&session.client, native_client)
            || !Arc::ptr_eq(&session.projection, source)
        {
            return false;
        }
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return false;
        };
        let turn_id = params.get("turnId").and_then(Value::as_str);
        if thread_id != session_id {
            let controls = self
                .controls
                .lock()
                .expect("codex controls registry")
                .get(session_id)
                .cloned();
            return controls.is_some_and(|controls| {
                controls
                    .child_turns
                    .lock()
                    .expect("child control turns")
                    .get(thread_id)
                    .is_some_and(|child| {
                        Arc::ptr_eq(&child.native_client, native_client)
                            // The native relationship was proved at child start.
                            // Display eviction must not erase that proof, and a
                            // weak reference must not retain old display payloads.
                            && child.source.upgrade().is_some_and(|proof| Arc::ptr_eq(&proof, source))
                            && turn_id.is_none_or(|id| child.turn_id == id)
                    })
            });
        }
        let Some(turn_id) = turn_id else {
            return true;
        };
        let active_matches =
            session.active_turn.lock().expect("active turn").as_deref() == Some(turn_id);
        if active_matches {
            return true;
        }
        // Drop the active-turn guard before consulting the retired slot. Async
        // content can remain actionable there; awaited RPCs require a live turn.
        allow_retired
            && session
                .retired_turn_id
                .lock()
                .expect("retired turn")
                .as_deref()
                == Some(turn_id)
    }

    pub async fn handle_approval_respond(&self, msg: FreshAgentApprovalRespond) {
        self.try_handle_approval_respond(msg).await;
    }

    pub async fn try_handle_approval_respond(&self, msg: FreshAgentApprovalRespond) -> bool {
        self.respond_control(&msg.session_id, &response_key(&msg.request_id), ControlKind::Approval, |request| {
            let decision = msg.decision.get("nativeDecision").and_then(Value::as_str).or_else(|| {
                match msg.decision.get("behavior").and_then(Value::as_str) {
                    Some("allow") => Some("accept"), Some("deny") => Some("decline"), _ => None,
                }
            }).ok_or("Choose an offered decision for this Codex request.")?;
            if request.method == "item/permissions/requestApproval" {
                return match decision {
                    "accept" => Ok(json!({"permissions":request.params["permissions"], "scope":"turn"})),
                    "decline" => Ok(json!({"permissions":{}, "scope":"turn"})),
                    _ => Err("This permission request supports allowing or declining the requested permissions."),
                };
            }
            if !matches!(decision, "accept" | "acceptForSession" | "decline" | "cancel") {
                return Err("This native approval decision is not supported.");
            }
            if let Some(offered) = request.params.get("availableDecisions").and_then(Value::as_array) {
                if !offered.iter().any(|value| value.as_str() == Some(decision)) {
                    return Err("Codex did not offer this approval decision.");
                }
            } else if decision == "acceptForSession" {
                return Err("Codex did not offer session approval.");
            }
            Ok(json!({"decision":decision}))
        }).await
    }

    pub async fn handle_question_respond(&self, msg: FreshAgentQuestionRespond) {
        self.try_handle_question_respond(msg).await;
    }

    pub async fn try_handle_question_respond(&self, msg: FreshAgentQuestionRespond) -> bool {
        self.respond_control(
            &msg.session_id,
            &response_key(&msg.request_id),
            ControlKind::Question,
            |request| {
                let mut answers = Map::new();
                for question in request.public["questions"]
                    .as_array()
                    .expect("normalized questions")
                {
                    let id = question["id"].as_str().expect("normalized id");
                    let Some(answer) = msg.answers.get(id) else {
                        return Err("Answer every question before submitting.");
                    };
                    if question["isOther"] == false
                        && question["options"].as_array().is_some_and(|options| {
                            !options.is_empty()
                                && !options
                                    .iter()
                                    .any(|option| option["label"].as_str() == Some(answer))
                        })
                    {
                        return Err("Choose one of the options Codex offered.");
                    }
                    answers.insert(id.into(), json!({ "answers": [answer] }));
                }
                Ok(json!({ "answers": answers }))
            },
        )
        .await
    }

    pub async fn handle_elicitation_respond(&self, msg: FreshAgentElicitationRespond) {
        self.try_handle_elicitation_respond(msg).await;
    }

    pub async fn try_handle_elicitation_respond(&self, msg: FreshAgentElicitationRespond) -> bool {
        self.respond_control(
            &msg.session_id,
            &response_key(&msg.request_id),
            ControlKind::Elicitation,
            |request| elicitation::response(&request.params, &msg.action, &msg.content),
        )
        .await
    }

    async fn respond_control(
        &self,
        session_id: &str,
        key: &str,
        kind: ControlKind,
        build: impl FnOnce(&PendingRequest) -> Result<Value, &'static str>,
    ) -> bool {
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
            return false;
        };
        // Keep membership until the transport write succeeds; duplicate clicks cannot
        // answer twice and a failed write leaves the banner available for retry.
        let controls = self.session_controls(session_id).await;
        let mut pending = controls.lock().await;
        let Some(index) = pending
            .requests
            .iter()
            .position(|r| r.public["requestId"].as_str() == Some(key) && r.kind == kind)
        else {
            self.emit_fresh_agent_error(
                session_id,
                "REQUEST_UNAVAILABLE",
                "This Codex request is no longer waiting for an answer.",
            );
            return false;
        };
        let request = &pending.requests[index];
        let Some(source) = request.source.upgrade() else {
            self.emit_fresh_agent_error(
                session_id,
                "REQUEST_UNAVAILABLE",
                "This Codex request belongs to an earlier native source.",
            );
            return false;
        };
        if !Arc::ptr_eq(&client, &request.native_client)
            || !self
                .control_scope_matches(
                    session_id,
                    &request.params,
                    &request.native_client,
                    &source,
                    false,
                )
                .await
        {
            self.emit_fresh_agent_error(
                session_id,
                "REQUEST_UNAVAILABLE",
                "This Codex request belongs to an earlier native session or turn.",
            );
            return false;
        }
        let result = match build(request) {
            Ok(value) => value,
            Err(message) => {
                tracing::warn!(provider=PROVIDER,session_id,request_id=%key,method=%request.method,native_turn_id=request.params.get("turnId").and_then(|value| value.as_str()),native_item_id=request.params.get("itemId").and_then(|value| value.as_str()),"freshagent.codex.invalid_control_answer");
                self.emit_fresh_agent_error(session_id, "INVALID_ANSWER", message);
                return false;
            }
        };
        if let Err(error) = request.native_client.respond(&request.id, result).await {
            tracing::warn!(provider = PROVIDER, session_id, request_id = %key, error = %error, "freshagent.codex.respond_failed");
            self.emit_fresh_agent_error(
                session_id,
                "RESPONSE_FAILED",
                &format!("Could not send your answer to Codex: {error}"),
            );
            return false;
        }
        let request = pending.requests.remove(index);
        self.publish_control_membership(session_id, &controls, &pending)
            .await;
        self.cancelled_control(session_id, &request);
        tracing::info!(
            provider = PROVIDER,
            session_id,
            request_id = %key,
            "freshagent.codex.request_answered"
        );
        true
    }
}

#[cfg(test)]
mod tests;
