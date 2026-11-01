//! Catalog reads use an existing initialized app-server. They never create a thread.
use crate::{CodexAppServerClient, CodexAppServerError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub display_name: String,
    pub supported_effort_levels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
}

fn invalid(detail: &str) -> CodexAppServerError {
    CodexAppServerError::InvalidResponse {
        method: "model/list".into(),
        detail: detail.into(),
    }
}

fn opaque(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.trim().is_empty())
}

/// `id` is catalog metadata; `model` is the actual runnable provider model ID.
pub fn parse_page(page: &Value) -> Result<(Vec<CodexModel>, Option<String>), CodexAppServerError> {
    let data = page
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("missing model data"))?;
    let mut models = Vec::with_capacity(data.len());
    for row in data {
        let id = row
            .get("model")
            .and_then(opaque)
            .ok_or_else(|| invalid("missing runnable model ID"))?;
        let display = row
            .get("displayName")
            .and_then(opaque)
            .ok_or_else(|| invalid("missing model display name"))?;
        let efforts = row
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("invalid reasoning efforts"))?;
        let mut levels = Vec::new();
        for effort in efforts {
            let effort = effort
                .get("reasoningEffort")
                .and_then(opaque)
                .ok_or_else(|| invalid("invalid reasoning effort"))?;
            if !levels.iter().any(|level| level == effort) {
                levels.push(effort.to_string());
            }
        }
        let default_effort = match row.get("defaultReasoningEffort") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                opaque(value)
                    .ok_or_else(|| invalid("invalid default effort"))?
                    .to_string(),
            ),
        };
        let input_modalities = match row.get("inputModalities") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_array()
                    .ok_or_else(|| invalid("invalid input modalities"))?
                    .iter()
                    .map(|value| {
                        opaque(value)
                            .map(str::to_string)
                            .ok_or_else(|| invalid("invalid input modality"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        };
        models.push(CodexModel {
            id: id.into(),
            display_name: display.into(),
            supported_effort_levels: levels,
            default_effort,
            input_modalities,
        });
    }
    let cursor = match page.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            opaque(value)
                .ok_or_else(|| invalid("invalid next cursor"))?
                .to_string(),
        ),
    };
    Ok((models, cursor))
}

pub async fn read_models(
    client: &CodexAppServerClient,
) -> Result<Vec<CodexModel>, CodexAppServerError> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut cursor = None;
        let mut cursors = HashSet::new();
        let mut ids = HashSet::new();
        let mut models = Vec::new();
        loop {
            let page = client.list_models(cursor.as_deref()).await?;
            let (rows, next) = parse_page(&page)?;
            for row in rows {
                if ids.insert(row.id.clone()) {
                    models.push(row);
                }
            }
            match next {
                None => return Ok(models),
                Some(next) if cursors.insert(next.clone()) => cursor = Some(next),
                Some(_) => return Err(invalid("model pagination cursor repeated")),
            }
        }
    })
    .await
    .map_err(|_| CodexAppServerError::Timeout {
        method: "model/list".into(),
        timeout_ms: 20_000,
    })?
}

pub fn resolve_legacy_effort(model: &str, effort: &str, catalog: &[CodexModel]) -> String {
    if effort == "max"
        && catalog.iter().any(|row| {
            row.id == model
                && row.supported_effort_levels.iter().any(|s| s == "xhigh")
                && !row.supported_effort_levels.iter().any(|s| s == "max")
        })
    {
        "xhigh".into()
    } else {
        effort.into()
    }
}

#[cfg(all(test, feature = "native-policy-qualification"))]
mod native_tests {
    use super::*;
    use crate::{
        app_server::{BoxFuture, WsTransport},
        CodexNotification, HistoryMode, StartThreadParams, StartTurnParams, ThreadForkParams,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// The existing owned release-contract runner supplies this live endpoint.
    /// This feature is the established explicit native qualification lane.
    #[tokio::test]
    async fn native_catalog_and_opaque_effort_use_initialized_client() {
        struct Recorded {
            transport: crate::transport::TungsteniteTransport,
            frames: Arc<Mutex<Vec<Value>>>,
        }
        impl WsTransport for Recorded {
            fn send(&self, text: String) -> BoxFuture<'_, Result<(), String>> {
                Box::pin(async move {
                    self.frames.lock().unwrap().push(json!({"direction":"controller","frame":serde_json::from_str::<Value>(&text).unwrap()}));
                    self.transport.send(text).await
                })
            }
            fn recv(&self) -> BoxFuture<'_, Option<String>> {
                Box::pin(async move {
                    let text = self.transport.recv().await?;
                    self.frames.lock().unwrap().push(json!({"direction":"native","frame":serde_json::from_str::<Value>(&text).unwrap()}));
                    Some(text)
                })
            }
            fn close(&self) -> BoxFuture<'_, ()> {
                self.transport.close()
            }
        }
        let endpoint = std::env::var("FRESHELL_CODEX_CATALOG_PROBE_URL")
            .expect("owned native endpoint required");
        assert!(endpoint.starts_with("ws://127.0.0.1:"));
        let receipt =
            std::env::var("FRESHELL_CODEX_CATALOG_PROBE_RECEIPT").expect("owned receipt required");
        let frames = Arc::new(Mutex::new(Vec::new()));
        let transport = Recorded {
            transport: crate::transport::TungsteniteTransport::connect(&endpoint)
                .await
                .unwrap(),
            frames: frames.clone(),
        };
        let (client, mut notifications) = CodexAppServerClient::connect(Arc::new(transport));
        client.initialize().await.unwrap();
        let models = read_models(&client).await.unwrap();
        assert!(!models.is_empty());
        assert!(models
            .iter()
            .all(|m| !m.id.is_empty() && !m.display_name.is_empty()));
        assert!(
            !models.iter().any(|model| model.id == "provider-current"),
            "qualification requires an exact model omitted by discovery"
        );
        let params = StartThreadParams {
            model: Some(crate::normalize_freshcodex_model(Some("provider-current"))),
            approval_policy: Some("never".into()),
            sandbox: Some("read-only".into()),
            history_mode: Some(HistoryMode::Paginated),
            ..Default::default()
        };
        let parent = client.start_thread(params.clone()).await.unwrap().thread_id;
        async fn send_exact(
            client: &CodexAppServerClient,
            notifications: &mut tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
            thread: &str,
            model: &str,
            effort: &str,
        ) -> String {
            let turn=client.start_turn(StartTurnParams {thread_id:thread.into(),input:vec![json!({"type":"text","text":"Controlled exact model and effort qualification"})],model:Some(crate::normalize_freshcodex_model(Some(model))),effort:crate::to_codex_reasoning_effort(Some(effort)).unwrap(),approval_policy:Some(json!("never")),..Default::default()}).await.unwrap();
            tokio::time::timeout(Duration::from_secs(30), async {
                while let Some(notification) = notifications.recv().await {
                    if let CodexNotification::TurnCompleted(event) = notification {
                        if event.thread_id == thread
                            && event.turn_id.as_deref() == Some(&turn.turn_id)
                        {
                            assert_eq!(event.params["turn"]["status"], "completed");
                            return;
                        }
                    }
                }
                panic!("native notifications closed before completion")
            })
            .await
            .unwrap();
            turn.turn_id
        }
        let mut completed = vec![
            send_exact(
                &client,
                &mut notifications,
                &parent,
                "provider-current",
                "ultra",
            )
            .await,
        ];
        // A second turn checks that the configured native default cannot
        // overwrite the exact explicit pair. Adapter configure itself is
        // exercised through the full registered-state lifecycle test.
        completed.push(
            send_exact(
                &client,
                &mut notifications,
                &parent,
                "provider-current",
                "ultra",
            )
            .await,
        );
        assert_eq!(
            client
                .resume_thread(&parent, params)
                .await
                .unwrap()
                .thread_id,
            parent
        );
        completed.push(
            send_exact(
                &client,
                &mut notifications,
                &parent,
                "provider-current",
                "ultra",
            )
            .await,
        );
        let fork = client
            .fork_thread(ThreadForkParams {
                thread_id: parent.clone(),
                model: Some("provider-current".into()),
                approval_policy: Some("never".into()),
                sandbox: Some("read-only".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        let child = fork["thread"]["id"].as_str().unwrap();
        completed.push(
            send_exact(
                &client,
                &mut notifications,
                child,
                "provider-current",
                "ultra",
            )
            .await,
        );
        // 0.164 accepts this opaque value even though discovery omits it.
        // The owned release diagnostic proves its exact native/HTTP forwarding.
        let future_turn = send_exact(
            &client,
            &mut notifications,
            child,
            "provider-current",
            "future-unadvertised-native-effort",
        )
        .await;
        let advertised_model = models
            .iter()
            .find(|model| {
                ["ultra", "xhigh"].iter().all(|effort| {
                    model
                        .supported_effort_levels
                        .iter()
                        .any(|supported| supported == effort)
                })
            })
            .expect("installed catalog advertises ultra and xhigh");
        let advertised_thread = client
            .start_thread(StartThreadParams {
                model: Some(advertised_model.id.clone()),
                approval_policy: Some("never".into()),
                sandbox: Some("read-only".into()),
                history_mode: Some(HistoryMode::Paginated),
                ..Default::default()
            })
            .await
            .unwrap()
            .thread_id;
        let mut advertised_turns = Vec::new();
        for effort in ["ultra", "xhigh"] {
            let turn_id = send_exact(
                &client,
                &mut notifications,
                &advertised_thread,
                &advertised_model.id,
                effort,
            )
            .await;
            advertised_turns.push(json!({"turnId":turn_id,"effort":effort}));
        }
        let advertised_selection =
            json!({"model":advertised_model,"threadId":advertised_thread,"turns":advertised_turns});
        client.close().await;
        let frames = frames.lock().unwrap();
        let requests = frames
            .iter()
            .filter(|f| f["direction"] == "controller" && f["frame"].get("id").is_some())
            .map(|f| &f["frame"])
            .collect::<Vec<_>>();
        assert_eq!(
            requests
                .iter()
                .filter(|f| f["method"] == "initialize")
                .count(),
            1
        );
        let first_work = requests
            .iter()
            .position(|frame| frame["method"] == "thread/start")
            .unwrap();
        assert!(
            requests[..first_work]
                .iter()
                .all(|frame| frame["method"] == "initialize" || frame["method"] == "model/list"),
            "catalog discovery must create no native conversation"
        );
        for method in ["thread/start", "thread/resume", "thread/fork"] {
            let request = requests
                .iter()
                .find(|frame| frame["method"] == method)
                .unwrap();
            assert_eq!(request["params"]["model"], "provider-current");
        }
        let turns = requests
            .iter()
            .filter(|frame| frame["method"] == "turn/start")
            .collect::<Vec<_>>();
        assert_eq!(turns.len(), 7);
        for request in &turns[..4] {
            assert_eq!(request["params"]["model"], "provider-current");
            assert_eq!(request["params"]["effort"], "ultra");
        }
        assert_eq!(
            turns[4]["params"]["effort"],
            "future-unadvertised-native-effort"
        );
        for (request, effort) in turns[5..].iter().zip(["ultra", "xhigh"]) {
            assert_eq!(request["params"]["model"], advertised_model.id);
            assert_eq!(request["params"]["effort"], effort);
            assert_eq!(request["params"]["approvalPolicy"], "never");
        }
        std::fs::write(
            receipt,
            serde_json::to_vec(
                &json!({"models":models,"frames":*frames,"advertisedSelection":advertised_selection,"nativeAcceptedFutureEffort":true,"futureEffortCompletedTurn":future_turn,"nativeExactLifecycleAccepted":true,"completedTurns":completed}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
