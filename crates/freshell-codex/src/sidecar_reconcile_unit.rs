//! The seeded reattach of [`super::ReattachedCodexAppServerRuntime`]: a
//! sidecar retained across a restart is reattached INSIDE its containment
//! unit, so every later stop of the pane goes through that unit (Stage 2:
//! LB-02, LB-25, LB-32). The unit is reopened from the boot unit record
//! (each recorded root re-pinned only while its pid still has its recorded
//! start time), or, for a legacy (v1) record without a unit, the sidecar is
//! adopted into a fresh unit by its pinned launcher (that unit's record
//! keeps the legacy tag, so the next restart reopens it with the same
//! members, and the rewritten sidecar record names it). The native main is
//! pinned (by its recorded pid and start time, or for a legacy record as the
//! listener among the unit's members), the recorded ws URL is probed once,
//! and the listener must be that pinned main. An unusable survivor's unit is
//! stopped through the seed and its record removed; the plan's retry then
//! starts fresh.

use std::sync::atomic::Ordering;

use freshell_containment::{ProcWatch, StopMode, StopReason, UnitLabel};

use super::{
    remove_pruned, unix_millis, write_record_loudly, ReattachedCodexAppServerRuntime,
    REATTACH_PROBE_BUDGET,
};
use crate::durability::CODEX_SIDECAR_OWNERSHIP_ENV;
use crate::launch_lifecycle::{listener_among_members, probe_app_server, CodexRuntimeReady};
use crate::launch_plan::UnitSeed;
use crate::sidecar_store::CodexSidecarRecord;

impl ReattachedCodexAppServerRuntime {
    /// Reattach a VERIFIED survivor inside its unit (see the module docs).
    pub(super) async fn reattach_in_unit(
        &self,
        record: CodexSidecarRecord,
    ) -> Result<CodexRuntimeReady, String> {
        let Some(seed) = self.seed.as_ref() else {
            return Err("codex sidecar reattach inside a unit needs a unit seed".to_string());
        };
        // One live unit per unit id: a runtime reopens its unit once.
        if self.unit.get().is_some() {
            return if self.verified_usable.load(Ordering::SeqCst) {
                let current = self.record.lock().unwrap().clone();
                Ok(CodexRuntimeReady {
                    ws_url: current.ws_url,
                    codex_home: current.codex_home,
                })
            } else {
                Err(
                    "this codex sidecar reattach already failed; a retry needs a new runtime"
                        .to_string(),
                )
            };
        }
        // 1. The unit.
        let label = reattach_label(seed, &record);
        let unit = match (record.unit_id.as_deref(), self.unit_record.as_ref()) {
            (Some(_), Some(unit_record)) => seed
                .services
                .containment
                .reopen_unit(unit_record, label)
                .map_err(|error| {
                    tracing::error!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        unit_id = %unit_record.unit_id,
                        error = %error,
                        "sidecar_reattach_unit_unopened: the recorded unit could not be \
                         reopened; record kept for the next boot"
                    );
                    format!("codex sidecar unit could not be reopened: {error}")
                })?,
            (None, _) => seed.services.containment.adopt_legacy(
                CODEX_SIDECAR_OWNERSHIP_ENV,
                &record.ownership_id,
                &[(record.pid, record.starttime)],
                label,
            ),
            // Never claimable: boot pruned rows whose unit has no record.
            (Some(unit_id), None) => {
                remove_pruned(&self.store, &record.ownership_id);
                return Err(format!(
                    "codex sidecar reattach refused: unit {unit_id} has no record; \
                     record removed, nothing signalled"
                ));
            }
        };
        let _ = self.unit.set(unit.clone());
        seed.services.lifecycle.attempt_started(&unit);

        // 2-3. The pinned native main, and one probe whose listener it is.
        let usable = match port_of(&record.ws_url) {
            Some(port) => self.usable_main(&record, &unit, port).await,
            None => Err(format!("unusable ws url {}", record.ws_url)),
        };
        match usable {
            Ok((main, codex_home)) => {
                unit.set_main(main.clone());
                self.verified_usable.store(true, Ordering::SeqCst);
                let (snapshot, changed) = {
                    let mut current = self.record.lock().unwrap();
                    let unit_id = Some(unit.id().to_string());
                    let main_pid = Some(main.pid());
                    let main_starttime = Some(main.identity().start);
                    let changed = current.unit_id != unit_id
                        || current.main_pid != main_pid
                        || current.main_starttime != main_starttime
                        || (current.codex_home.is_none() && codex_home.is_some());
                    if changed {
                        current.unit_id = unit_id;
                        current.main_pid = main_pid;
                        current.main_starttime = main_starttime;
                        if current.codex_home.is_none() {
                            current.codex_home = codex_home;
                        }
                        current.updated_at = unix_millis();
                    }
                    (current.clone(), changed)
                };
                if changed {
                    write_record_loudly(&self.store, &snapshot);
                }
                tracing::info!(
                    target: "freshell_codex::sidecar_reconcile",
                    ownership_id = %snapshot.ownership_id,
                    unit_id = %unit.id(),
                    main_pid = main.pid(),
                    ws_url = %snapshot.ws_url,
                    "sidecar_reattached: surviving app-server adopted inside its unit; no spawn"
                );
                Ok(CodexRuntimeReady {
                    ws_url: snapshot.ws_url,
                    codex_home: snapshot.codex_home,
                })
            }
            Err(reason) => {
                // Verified but unusable: its unit is stopped (the native and
                // everything it started), then the record goes. Killing it
                // releases Codex's thread locks, so the retry's fresh spawn
                // can resume the thread.
                seed.stop(
                    &unit,
                    StopMode::Force,
                    StopReason::StartCancelled,
                    "codex-reattach-unusable",
                )
                .wait()
                .await;
                remove_pruned(&self.store, &record.ownership_id);
                tracing::warn!(
                    target: "freshell_codex::sidecar_reconcile",
                    ownership_id = %record.ownership_id,
                    unit_id = %unit.id(),
                    reason = %reason,
                    "sidecar_reattach_reaped: verified survivor unusable; its unit was \
                     stopped, record removed"
                );
                Err(format!(
                    "codex sidecar reattach failed: verified survivor unusable ({reason}); \
                     its unit was stopped, record removed"
                ))
            }
        }
    }

    /// The pinned native main and the Codex home the probe reported, when
    /// the recorded ws URL answers and its listener is that main.
    async fn usable_main(
        &self,
        record: &CodexSidecarRecord,
        unit: &freshell_containment::AgentUnit,
        port: u16,
    ) -> Result<(ProcWatch, Option<String>), String> {
        let main = match (record.main_pid, record.main_starttime) {
            (Some(pid), Some(start)) => ProcWatch::open_expecting(pid, start)
                .map_err(|error| format!("native main {pid} not pinned: {error}"))?,
            _ => match listener_among_members(unit, port).await? {
                Some(pid) => ProcWatch::open(pid)
                    .map_err(|error| format!("native main {pid} not pinned: {error}"))?,
                None => {
                    return Err(format!(
                        "no member of the unit owns the listener on port {port}"
                    ))
                }
            },
        };
        let codex_home =
            match tokio::time::timeout(REATTACH_PROBE_BUDGET, probe_app_server(&record.ws_url))
                .await
            {
                Ok(Ok(codex_home)) => codex_home,
                Ok(Err(error)) => return Err(error),
                Err(_elapsed) => {
                    return Err("probe timed out awaiting the WS handshake or initialize".into())
                }
            };
        match listener_among_members(unit, port).await? {
            Some(owner) if owner == main.pid() => Ok((main, codex_home)),
            _ => Err(format!(
                "the listener on port {port} is not the pinned native main {}",
                main.pid()
            )),
        }
    }
}

/// Provider `codex` with the record's session and terminal ids.
fn reattach_label(seed: &UnitSeed, record: &CodexSidecarRecord) -> UnitLabel {
    UnitLabel {
        provider: "codex".to_string(),
        session_id: record
            .session_id
            .clone()
            .or_else(|| seed.label.session_id.clone()),
        terminal_id: record
            .terminal_id
            .clone()
            .or_else(|| seed.label.terminal_id.clone()),
        mode: if seed.label.mode.is_empty() {
            "codex".to_string()
        } else {
            seed.label.mode.clone()
        },
        create_request_id: seed.label.create_request_id.clone(),
    }
}

/// The port of a `ws://127.0.0.1:<port>` URL.
fn port_of(ws_url: &str) -> Option<u16> {
    ws_url.rsplit(':').next()?.parse().ok()
}
