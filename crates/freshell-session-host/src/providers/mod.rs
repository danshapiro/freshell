//! Provider-specific recovery probes executed inside the soul enclosure.
//!
//! The trusted host delegates store reads to a short-lived helper running as
//! the same unprivileged uid/gid as the provider. This avoids granting the host
//! DAC override while keeping all provider-state inspection inside the runtime.

mod claude;
mod cli;
mod codex;
#[cfg(feature = "fresh-agent-fixtures")]
mod deterministic_fresh_agent;
mod fresh_agent;
mod opencode;

#[cfg(feature = "fresh-agent-fixtures")]
pub(crate) use deterministic_fresh_agent::run_worker as run_fresh_agent_fixture_worker;
pub(crate) use fresh_agent::open_hosted_fresh_agent;

pub(crate) use codex::PreparedCodexLaunch;

use freshell_agent_runtime::ProviderStoreProbe;
use freshell_runtime_protocol::{
    CheckpointReference, RecoveryBlockReason, RecoveryPath, RecoveryProbe, ResumeSpec, RetryHint,
};

pub struct PreparedTerminal {
    pub terminal: freshell_runtime_protocol::TerminalLaunchSpec,
    pub codex: Option<codex::PreparedCodexLaunch>,
}

pub fn prepare_provider_state_before_bootstrap(
    terminal: &mut freshell_runtime_protocol::TerminalLaunchSpec,
) -> Result<(), String> {
    if terminal.mode != "amplifier" {
        return Ok(());
    }
    let session_id = terminal
        .resume_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "managed Amplifier launch requires one exact launcher-assigned session id".to_string()
        })?;
    let provider_home = std::path::Path::new("/home/freshell/provider/.amplifier");
    let ensured = freshell_sessions::amplifier_stub::ensure_session(
        provider_home,
        session_id,
        &terminal.cwd,
        &terminal.terminal_id,
    )
    .map_err(|error| format!("prepare Amplifier session stub: {error}"))?;
    if let Some(recorded_cwd) = ensured.working_dir_of_existing {
        terminal.cwd = recorded_cwd;
    }
    Ok(())
}

pub async fn prepare_terminal(
    mut terminal: freshell_runtime_protocol::TerminalLaunchSpec,
) -> Result<PreparedTerminal, String> {
    if terminal.mode == "codex" {
        let prepared = codex::prepare(&terminal).await?;
        let mut args = prepared.remote_args.to_vec();
        args.extend(terminal.args);
        terminal.args = args;
        return Ok(PreparedTerminal {
            terminal,
            codex: Some(prepared),
        });
    }
    Ok(PreparedTerminal {
        terminal,
        codex: None,
    })
}

pub async fn probe_resume(
    mut resume_spec: ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> RecoveryProbe {
    let provider = resume_spec.provider_session.provider.clone();
    let result = match resume_spec.fixture_transport {
        Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic) => {
            deterministic_resume_probe(&resume_spec)
        }
        None => match provider.as_str() {
            "claude" | "kilroy" => claude::probe(&resume_spec, run_as_uid, run_as_gid).await,
            "codex" => codex::probe(&resume_spec, run_as_uid, run_as_gid).await,
            "opencode" => opencode::probe(&resume_spec, run_as_uid, run_as_gid).await,
            "amplifier" | "phase1-fixture" | "native-session-fixture" => {
                cli::probe_as_provider(&resume_spec, run_as_uid, run_as_gid).await
            }
            other => Err(format!(
                "managed recovery probe is not implemented for provider {other}"
            )),
        },
    };
    match result {
        Ok(ProviderStoreProbe::Ready { evidence }) => {
            if matches!(
                provider.as_str(),
                "phase1-fixture" | "native-session-fixture"
            ) {
                if let Some(revision) = evidence.iter().find_map(|item| {
                    item.strip_prefix("checkpointRevision=")
                        .and_then(|value| value.parse::<u64>().ok())
                }) {
                    resume_spec.checkpoint_revision = revision;
                    resume_spec.checkpoint_references = if revision == 0 {
                        Vec::new()
                    } else {
                        vec![CheckpointReference {
                            kind: "native_session_fixture".into(),
                            reference: format!(
                                "provider://.freshell/checkpoints/native-session/{revision}.json"
                            ),
                            revision,
                            verified: true,
                        }]
                    };
                }
            }
            RecoveryProbe::ResumeReady {
                evidence_revision: resume_spec.evidence_revision,
                resume_spec: Box::new(resume_spec),
            }
        }
        Ok(ProviderStoreProbe::DefinitivelyUnavailable {
            reason,
            evidence,
            store_state,
        }) => RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::NativeResume,
            reason,
            evidence,
            store_state,
        },
        Ok(ProviderStoreProbe::Blocked {
            reason,
            retry_hint,
            evidence,
        }) => RecoveryProbe::Blocked {
            path: RecoveryPath::NativeResume,
            reason,
            retry_hint,
            evidence,
        },
        Err(message) => RecoveryProbe::Blocked {
            path: RecoveryPath::NativeResume,
            reason: RecoveryBlockReason::ImplementationUnavailable,
            retry_hint: RetryHint {
                automatic_after_ms: None,
                manual_retry: true,
                repair: Some(message.clone()),
            },
            evidence: vec![message],
        },
    }
}

#[cfg(feature = "fresh-agent-fixtures")]
fn deterministic_resume_probe(spec: &ResumeSpec) -> Result<ProviderStoreProbe, String> {
    deterministic_fresh_agent::probe_resume(
        spec,
        std::path::Path::new(&spec.provider_home)
            .join(".freshell-fixture")
            .as_path(),
    )
}

#[cfg(not(feature = "fresh-agent-fixtures"))]
fn deterministic_resume_probe(_spec: &ResumeSpec) -> Result<ProviderStoreProbe, String> {
    Err("deterministic fresh-agent recovery is absent from this session-host build".into())
}

pub fn run_probe_worker(args: &[String]) -> Result<(), String> {
    cli::run_probe_worker(args)
}
