//! The seeded start attempt of [`super::SpawnedCodexAppServerRuntime`]: one
//! start attempt is one containment unit. The attempt mints its own unit
//! (whose Running record is written before anything spawns), starts the
//! `CODEX_CMD` launcher inside it, waits for the app-server to answer a
//! readiness probe, confirms the launcher's placement, and takes the member
//! of THIS unit that owns the listening socket as the unit's main: the native
//! `codex app-server` behind the Node launcher, which every stop signals
//! directly (Decision 2; Stage 2: LB-17, LB-30). There is no "main =
//! launcher" fallback: a probe answered by a listener outside the unit fails
//! the attempt. A failed attempt only returns its error; the planner stops
//! its unit through the lifecycle and waits for Gone before the next attempt.

use freshell_containment::events::{self, UnitLogKeys};
use freshell_containment::{listening_socket_owner, AgentUnit, MemberRole, ProcWatch};

use super::{NotListening, SpawnedCodexAppServerRuntime, SpawnedSidecar};
use crate::launch_plan::{UnitSeed, CODEX_START_CANCELLED_MESSAGE};

impl SpawnedCodexAppServerRuntime {
    /// One seeded start attempt (see the module docs).
    pub(super) async fn start_attempt_in_unit(
        &self,
        seed: &UnitSeed,
        cwd: Option<String>,
    ) -> Result<SpawnedSidecar, String> {
        if self.unit.get().is_some() {
            return Err(
                "this Codex start attempt already ran; a new attempt needs a new runtime"
                    .to_string(),
            );
        }
        // 1. This attempt's own unit.
        let unit = seed.mint_attempt()?;
        let _ = self.unit.set(unit.clone());
        let keys = unit_log_keys(&unit);
        let abandoned = || seed.start_cancelled() || seed.is_stopping(&unit);

        // 2. The command, placed in the unit.
        let spawn = self.plan_spawn()?;
        let mut cmd = unit
            .tokio_command(&spawn.program, &spawn.args, MemberRole::Agent)
            .map_err(|error| format!("containment placement failed: {error}"))?;
        spawn.configure(&mut cmd, cwd.as_deref());
        // 3. Retention across a restart stays Linux-only (Stage 2: LB-26).
        let detach = self.detaches();
        cmd.kill_on_drop(!detach);
        #[cfg(unix)]
        cmd.process_group(0);

        // 4. Spawn, and pin the spawned process as a root of the unit.
        let mut child = cmd.spawn().map_err(|error| {
            format!("codex app-server spawn failed ({}): {error}", spawn.command)
        })?;
        // The server's original open-file soft limit, not its raised one.
        freshell_platform::child_nofile::restore_after_spawn(child.id(), &spawn.program);
        super::drain_child_io(&mut child);
        let spawned_pid = child
            .id()
            .ok_or_else(|| "codex app-server exited as it was spawned".to_string())?;
        match ProcWatch::open(spawned_pid) {
            Ok(watch) => unit.add_root(watch),
            // The backend still counts the process as a member.
            Err(error) => tracing::warn!(
                target: "freshell_codex::launch",
                event = "codex_unit_root_unpinned",
                unit_id = %unit.id(),
                pid = spawned_pid,
                error = %error,
                "codex_unit_root_unpinned: the spawned app-server could not be pinned \
                 as a unit root"
            ),
        }

        // 5. Readiness.
        let codex_home = match self
            .wait_listening(&mut child, &spawn.ws_url, abandoned)
            .await
        {
            Ok(codex_home) => codex_home,
            Err(NotListening::Cancelled) => {
                return Err(CODEX_START_CANCELLED_MESSAGE.to_string());
            }
            // Killed during its start: a cancelled start, not a crash.
            Err(NotListening::Exited(_)) if abandoned() => {
                return Err(CODEX_START_CANCELLED_MESSAGE.to_string());
            }
            Err(NotListening::Exited(status)) => {
                events::placement_failed(
                    &keys,
                    "agent",
                    spawned_pid,
                    exit_code(status),
                    "exited before its placement was confirmed",
                );
                return Err(format!(
                    "codex app-server exited before listening: {status}"
                ));
            }
            Err(NotListening::TimedOut(probe_error)) => {
                return Err(format!("codex app-server WS never came up: {probe_error}"));
            }
        };

        // 6. Placement, confirmed once at the readiness probe.
        if let Err(error) = unit.confirm_placement(spawned_pid) {
            events::placement_failed(&keys, "agent", spawned_pid, None, &error.to_string());
            return Err(format!("codex app-server placement not confirmed: {error}"));
        }

        // 7. The main: the listener among THIS unit's members.
        let Some(main_pid) = listener_among_members(&unit, spawn.port).await? else {
            events::main_discovery_failed(&keys, spawn.port, spawned_pid);
            return Err(format!(
                "codex app-server listener on port {} is not a member of this unit",
                spawn.port
            ));
        };
        let main = ProcWatch::open(main_pid).map_err(|error| {
            format!("codex app-server main {main_pid} could not be pinned: {error}")
        })?;
        unit.set_main(main.clone());

        // 8. The durable record (detached spawns only, as before).
        let record = if detach {
            let row = self.sidecar_record(
                &spawn,
                spawned_pid,
                Some((&unit, &main)),
                codex_home.clone(),
            );
            if let Err(error) = self.store.write(&row) {
                tracing::error!(
                    target: "freshell_codex::launch",
                    ownership_id = %row.ownership_id,
                    unit_id = %unit.id(),
                    error = %error,
                    "sidecar_record_write_failed: the attempt fails and its unit is stopped"
                );
                return Err(format!(
                    "codex app-server ownership record write failed: {error}"
                ));
            }
            Some(row)
        } else {
            None
        };

        Ok(SpawnedSidecar {
            ws_url: spawn.ws_url,
            ownership_id: spawn.ownership_id,
            child,
            record,
            codex_home,
        })
    }
}

/// The member of `unit` (or a descendant of one) that owns the LISTEN socket
/// on `port`. A full member scan on the tag backend, so it runs on a
/// blocking thread.
pub(crate) async fn listener_among_members(
    unit: &AgentUnit,
    port: u16,
) -> Result<Option<u32>, String> {
    let unit = unit.clone();
    tokio::task::spawn_blocking(move || {
        let members = unit.members()?;
        let pids: Vec<u32> = members.iter().map(|member| member.pid).collect();
        Ok::<_, std::io::Error>(listening_socket_owner(port, &pids))
    })
    .await
    .map_err(|error| format!("codex unit member lookup failed: {error}"))?
    .map_err(|error| format!("codex unit members unreadable: {error}"))
}

/// The keys every `freshell_unit` event carries, from the unit's label.
fn unit_log_keys(unit: &AgentUnit) -> UnitLogKeys {
    let label = unit.label();
    UnitLogKeys {
        unit_id: unit.id().to_string(),
        provider: label.provider,
        session_id: label.session_id,
        terminal_id: label.terminal_id,
        operation_id: None,
    }
}

/// The exit code, or 128 + the signal number for a signal death (Unix).
fn exit_code(status: std::process::ExitStatus) -> Option<i64> {
    if let Some(code) = status.code() {
        return Some(i64::from(code));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| 128 + i64::from(signal))
    }
    #[cfg(not(unix))]
    {
        None
    }
}
