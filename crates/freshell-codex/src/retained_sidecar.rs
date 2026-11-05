//! A prior terminal's native process remains borrowed until the new create
//! wins its final ownership commit. Failure owns only the new proxy/TUI.

use std::sync::Arc;
use std::time::Duration;

use crate::app_server::BoxFuture;
use crate::launch_lifecycle::{CodexLaunchRuntime, CodexRuntimeReady};
use crate::sidecar_reconcile::{ReattachedCodexAppServerRuntime, SidecarReconciler};
use crate::sidecar_store::{
    verify_sidecar_identity, CodexSidecarRecord, CodexSidecarStore, IdentityVerdict,
};

enum Custody {
    Pending { terminal: Option<(String, u64)> },
    Committed(Box<ReattachedCodexAppServerRuntime>),
    Returned,
}

pub(crate) struct RetainedSidecarRuntime {
    original: CodexSidecarRecord,
    store: Arc<CodexSidecarStore>,
    reconciler: Arc<SidecarReconciler>,
    custody: tokio::sync::Mutex<Custody>,
}

impl RetainedSidecarRuntime {
    pub(crate) fn new(
        original: CodexSidecarRecord,
        store: Arc<CodexSidecarStore>,
        reconciler: Arc<SidecarReconciler>,
    ) -> Self {
        Self {
            original,
            store,
            reconciler,
            custody: tokio::sync::Mutex::new(Custody::Pending { terminal: None }),
        }
    }

    fn verify(&self) -> Result<(), String> {
        let verdict = verify_sidecar_identity(&self.original);
        if verdict == IdentityVerdict::Verified {
            Ok(())
        } else {
            tracing::warn!(event = "codex.retained_sidecar_identity_refused", ownership_id = %self.original.ownership_id, verdict = ?verdict, "Retained owner changed; no process was signalled or replaced");
            Err(
                "The existing Codex agent's process identity changed. No replacement was started."
                    .into(),
            )
        }
    }

    fn return_claim(&self) {
        self.reconciler
            .return_uncommitted_claim(self.original.clone());
    }

    async fn release(&self, retention_reason: Option<String>) -> Result<(), String> {
        let mut custody = self.custody.lock().await;
        match &*custody {
            Custody::Pending { .. } => self.return_claim(),
            Custody::Committed(runtime) => match retention_reason {
                Some(reason) => runtime.prepare_retention(reason).await?,
                None => runtime.shutdown().await?,
            },
            Custody::Returned => return Ok(()),
        }
        *custody = Custody::Returned;
        Ok(())
    }
}

impl CodexLaunchRuntime for RetainedSidecarRuntime {
    fn ensure_ready(&self, _: Option<String>) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async {
            let custody = self.custody.lock().await;
            if !matches!(*custody, Custody::Pending { .. }) {
                return Err("The retained Codex claim is no longer available.".into());
            }
            self.verify()?;
            let probe = tokio::time::timeout(
                Duration::from_secs(3),
                tokio_tungstenite::connect_async_with_config(
                    &self.original.ws_url,
                    Some(crate::ws_config::lane_ws_config()),
                    false,
                ),
            )
            .await;
            match probe {
                Ok(Ok((socket, _))) => {
                    drop(socket);
                    Ok(CodexRuntimeReady {
                        ws_url: self.original.ws_url.clone(),
                    })
                }
                _ => {
                    tracing::warn!(event = "codex.retained_sidecar_unavailable", ownership_id = %self.original.ownership_id, "Retained owner is unavailable; process and original record were preserved");
                    Err("The existing Codex agent is temporarily unavailable. Its process was preserved; no replacement was started.".into())
                }
            }
        })
    }

    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            match &mut *self.custody.lock().await {
                Custody::Pending { terminal } => {
                    *terminal = Some((terminal_id, generation));
                    Ok(())
                }
                _ => Err("The retained Codex claim is no longer pending.".into()),
            }
        })
    }

    fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            match &*self.custody.lock().await {
                Custody::Pending { .. } => {
                    if self.original.session_id.as_deref() == Some(session_id.as_str()) {
                        Ok(())
                    } else {
                        Err("A pending retained Codex owner cannot change its native session identity.".into())
                    }
                }
                Custody::Committed(runtime) => runtime.note_session_id(session_id).await,
                Custody::Returned => Err("The retained Codex claim is no longer available.".into()),
            }
        })
    }

    fn commit_ownership(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async {
            let mut custody = self.custody.lock().await;
            let Custody::Pending {
                terminal: Some((terminal_id, generation)),
            } = &*custody
            else {
                return Err("The retained Codex create no longer owns a pending claim.".into());
            };
            self.verify()?;
            let runtime = ReattachedCodexAppServerRuntime::from_committed_claim(
                self.original.clone(),
                self.store.clone(),
            );
            runtime
                .update_ownership_metadata(terminal_id.clone(), *generation)
                .await?;
            *custody = Custody::Committed(Box::new(runtime));
            Ok(())
        })
    }

    fn prepare_retention(&self, reason: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(self.release(Some(reason)))
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(self.release(None))
    }
}

impl Drop for RetainedSidecarRuntime {
    fn drop(&mut self) {
        if matches!(self.custody.get_mut(), Custody::Pending { .. }) {
            self.return_claim();
        }
    }
}
