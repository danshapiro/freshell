//! Native naming uses the current host's existing client and the shared worker.
use super::*;
use crate::session_name_native::{
    classify_codex_error, NativeCallResult, NativeClassified, NativeFuture, NativeNameAttempt,
    NativeNameBackend, NativeNameReadback, NativeNameTarget, NativeProbeFuture,
};
use freshell_protocol::native_location::NativeLocation;
use freshell_runtime_protocol::{
    FreshAgentNativeNameError as NameError, FreshAgentNativeNameOperation as Operation,
    FreshAgentNativeNameReply as Reply, FreshAgentNativeNameRequest, FreshAgentNativeNameSource,
};

#[derive(Clone)]
struct HostedCodexNameBackend {
    client: RuntimeClient,
    ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
}

impl HostedFreshAgentProxy {
    pub(crate) fn native_name_backend(&self) -> Arc<dyn NativeNameBackend> {
        Arc::new(HostedCodexNameBackend {
            client: self.client.clone(),
            ownership: self.ownership.get().cloned(),
        })
    }
}

impl HostedCodexNameBackend {
    async fn invoke(
        &self,
        target: NativeNameTarget,
        operation: Operation,
    ) -> Result<Reply, NativeClassified> {
        let NativeLocation::Codex {
            codex_home,
            native_thread_id: Some(native_id),
            ..
        } = &target.location
        else {
            return Err(NativeClassified::Unsupported(
                "no exact Codex native naming target".into(),
            ));
        };
        if codex_home.is_empty() || native_id.is_empty() {
            return Err(NativeClassified::Unsupported(
                "no initialized Codex naming root or thread".into(),
            ));
        }
        let owner = || {
            self.ownership.as_ref().map(|registry| {
                let canonical = registry.resolve_canonical("codex", native_id);
                let observed = registry.observe("codex", &canonical);
                (observed.epoch, observed.generation, observed.state)
            })
        };
        let before_owner = owner();
        let inventory = self
            .client
            .inventory()
            .await
            .map_err(|error| NativeClassified::Undelivered(error.to_string()))?;
        let view = inventory
            .iter()
            .rev()
            .find(|view| {
                view.provider.as_deref() == Some("codex")
                    && view.fresh_agent_session_type.as_deref() == Some("freshcodex")
                    && view.native_session_id.as_deref() == Some(native_id)
                    && view.launch_state == freshell_runtime_protocol::LaunchState::Running
                    && view.recovery_state == freshell_runtime_protocol::RecoveryState::Live
                    && view.desired_state == DesiredState::Running
            })
            .ok_or_else(|| {
                NativeClassified::Undelivered("no live managed Codex naming authority".into())
            })?;
        let source = FreshAgentNativeNameSource {
            incarnation_id: view.incarnation_id.clone(),
            host_boot_id: view.host_boot_id.clone().ok_or_else(|| {
                NativeClassified::Undelivered("Codex host has no authenticated boot".into())
            })?,
            execution_generation: view.execution_generation,
            intent_revision: view.intent_revision,
            native_session_id: native_id.clone(),
        };
        if owner() != before_owner {
            return Err(NativeClassified::Undelivered(
                "Codex naming owner changed before dispatch".into(),
            ));
        }
        let reply = self
            .client
            .fresh_agent_native_name(FreshAgentNativeNameRequest {
                soul_id: view.soul_id.clone(),
                source,
                codex_home: codex_home.clone(),
                operation,
                expected_control_epoch: None,
            })
            .await
            .map_err(|error| {
                NativeClassified::Ambiguous(format!(
                    "managed Codex naming request did not settle: {error}"
                ))
            })?;
        let inventory = self
            .client
            .inventory()
            .await
            .map_err(|error| NativeClassified::Ambiguous(error.to_string()))?;
        let current = inventory
            .iter()
            .rev()
            .find(|row| row.soul_id == view.soul_id);
        if owner() != before_owner
            || !current.is_some_and(|current| rest::same_snapshot_source(view, current))
        {
            return Err(NativeClassified::Ambiguous(
                "Codex naming source changed during dispatch".into(),
            ));
        }
        Ok(reply)
    }
}

fn classify_name_error(error: NameError, method: &str) -> NativeClassified {
    use freshell_codex::app_server::CodexAppServerError as Error;
    let method = method.to_string();
    let error = match error {
        NameError::Unavailable { message } => return NativeClassified::Undelivered(message),
        NameError::Rpc { code, message } => Error::Rpc {
            method,
            error: Box::new(freshell_codex::protocol::RpcError {
                code,
                message,
                data: None,
            }),
        },
        NameError::Timeout { timeout_ms } => Error::Timeout { method, timeout_ms },
        NameError::Closed => Error::Closed { method },
        NameError::Transport { message } => Error::Transport { method, message },
        NameError::InvalidResponse { detail } => Error::InvalidResponse { method, detail },
    };
    classify_codex_error(error, "native metadata")
}

impl NativeNameBackend for HostedCodexNameBackend {
    fn read(&self, target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
        let backend = self.clone();
        Box::pin(async move {
            match backend.invoke(target, Operation::Read).await {
                Ok(Reply::Title(title)) => {
                    NativeCallResult::Confirmed(NativeNameReadback { title })
                }
                Ok(Reply::Failed(error)) => classify_name_error(error, "thread/read").into_call(),
                Err(error) => error.into_call(),
                _ => NativeCallResult::Ambiguous("unexpected native name read reply".into()),
            }
        })
    }

    fn write(&self, attempt: NativeNameAttempt) -> NativeFuture<()> {
        let backend = self.clone();
        Box::pin(async move {
            match backend
                .invoke(
                    attempt.target,
                    Operation::Write {
                        title: attempt.title,
                    },
                )
                .await
            {
                Ok(Reply::Renamed) => NativeCallResult::Confirmed(()),
                Ok(Reply::Failed(error)) => {
                    classify_name_error(error, "thread/name/set").into_call()
                }
                Err(error) => error.into_call(),
                _ => NativeCallResult::Ambiguous("unexpected native name write reply".into()),
            }
        })
    }

    fn route_available(&self, target: NativeNameTarget) -> NativeProbeFuture {
        let backend = self.clone();
        Box::pin(async move {
            matches!(
                backend.invoke(target, Operation::Probe).await,
                Ok(Reply::Available)
            )
        })
    }
}
