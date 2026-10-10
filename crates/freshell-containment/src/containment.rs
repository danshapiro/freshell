//! `Containment`: the backend this server uses, its unit-record store, and
//! the process-global handle. Units are found after a restart ONLY through
//! this server's own records: nothing enumerates slices, tags, jobs or
//! processes beyond a recorded unit id (Stage 2: LB-01), and every recorded
//! root is pinned by pid AND start time before anything can signal it
//! (Stage 2: LB-02).

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

#[cfg(unix)]
use crate::backend::BackendKind;
use crate::backend::{Backend, Capability, UnitBackend};
use crate::proc_watch::ProcWatch;
use crate::record::{RecordStore, UnitRecord, UnitRecordState};
use crate::unit::{AgentUnit, UnitLabel};
use crate::{events, UnitId};

#[derive(Debug, Clone)]
pub struct ShimCommand {
    pub exe: PathBuf,
    pub leading_args: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SelectOptions {
    /// The member exec shim (the Linux fallback's `--reaper`, Windows job
    /// self-placement): the server passes its own exe + `__unit-exec`; tests
    /// pass the `freshell-unit-exec` bin.
    pub shim: Option<ShimCommand>,
    /// The server's state directory (`<FRESHELL_HOME or HOME>/.freshell`);
    /// unit records live in `<state_root>/units/`. Empty: records are kept
    /// in memory (tests only).
    pub state_root: PathBuf,
}

#[derive(Clone)]
pub struct Containment {
    backend: Arc<dyn Backend>,
    store: Arc<RecordStore>,
}

impl Containment {
    /// Picks the best backend this process can use and logs the choice once
    /// (`event=containment.backend`). A degraded choice never blocks a kill.
    pub fn select(opts: SelectOptions) -> Self {
        let chosen = Self::probe(&opts);
        let cap = chosen.capability();
        tracing::info!(target: "freshell_unit",
            event = "containment.backend",
            backend = cap.kind.as_str(),
            full = cap.full,
            reason = %cap.reason.clone().unwrap_or_default(),
            "containment backend selected");
        chosen
    }

    fn probe(opts: &SelectOptions) -> Self {
        #[cfg(target_os = "linux")]
        {
            // The store opens first: the probe hashes the canonical state
            // root, which opening the store creates.
            let store = Arc::new(RecordStore::open(&opts.state_root));
            match crate::backend::systemd::SystemdBackend::probe(opts) {
                Ok(backend) => Self {
                    backend: Arc::new(backend),
                    store,
                },
                Err(reason) => Self::tag_on(
                    BackendKind::LinuxTag,
                    &format!("systemd backend unavailable: {reason}"),
                    opts,
                    store,
                ),
            }
        }
        #[cfg(target_os = "macos")]
        {
            Self::tag_with(
                BackendKind::MacosTag,
                "macOS has no kernel process containment",
                opts,
            )
        }
        #[cfg(windows)]
        {
            Self::job_backend(opts)
        }
    }

    /// The degraded tag backend, forced (tests; the sandbox). Windows has no
    /// tag backend: its Job Object backend is used.
    pub fn tag_backend(opts: SelectOptions) -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::tag_with(BackendKind::MacosTag, "forced tag backend", &opts)
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Self::tag_with(BackendKind::LinuxTag, "forced tag backend", &opts)
        }
        #[cfg(windows)]
        {
            Self::job_backend(&opts)
        }
    }

    #[cfg(unix)]
    fn tag_with(kind: BackendKind, reason: &str, opts: &SelectOptions) -> Self {
        Self::tag_on(
            kind,
            reason,
            opts,
            Arc::new(RecordStore::open(&opts.state_root)),
        )
    }

    #[cfg(unix)]
    fn tag_on(
        kind: BackendKind,
        reason: &str,
        opts: &SelectOptions,
        store: Arc<RecordStore>,
    ) -> Self {
        Self {
            backend: Arc::new(crate::backend::tag::TagBackend::new(
                kind,
                reason,
                opts.shim.as_ref(),
            )),
            store,
        }
    }

    #[cfg(windows)]
    fn job_backend(opts: &SelectOptions) -> Self {
        Self {
            backend: Arc::new(crate::backend::windows_job::JobBackend::new(
                opts.shim.as_ref(),
            )),
            store: Arc::new(RecordStore::open(&opts.state_root)),
        }
    }

    pub fn capability(&self) -> Capability {
        self.backend.capability()
    }

    /// Creates a unit and records it (Running) BEFORE returning, so nothing
    /// can spawn into a unit whose Stopping could not be saved. A write
    /// failure, or a store that is not open, is returned (a typed start
    /// failure for the caller).
    pub fn create_unit(&self, id: UnitId, label: UnitLabel) -> std::io::Result<AgentUnit> {
        let backend = self.backend.create(&id)?;
        let record = UnitRecord {
            unit_id: id.clone(),
            provider: label.provider.clone(),
            mode: label.mode.clone(),
            terminal_id: label.terminal_id.clone(),
            create_request_id: label.create_request_id.clone(),
            conversation_keys: label
                .session_id
                .iter()
                .map(|s| (label.provider.clone(), s.clone()))
                .collect(),
            roots: Vec::new(),
            state: UnitRecordState::Running,
        };
        self.store.write(&record)?;
        Ok(AgentUnit::new(
            id,
            backend,
            self.capability(),
            self.store.clone(),
            label,
            Some(record),
        ))
    }

    /// The records this server owns: at boot, exactly those no running
    /// server holds (the only way units are found after a restart); later
    /// also the units created since, until their Gone.
    pub fn recorded_units(&self) -> std::io::Result<Vec<UnitRecord>> {
        self.store.owned_records()
    }

    /// A unit continuing `record` (not rewritten), logging with `label`'s
    /// keys. Every recorded root still alive with its recorded start time is
    /// pinned; any other is never signalled and is logged at WARN
    /// `unit.root.not_pinned`.
    pub fn reopen_unit(&self, record: &UnitRecord, label: UnitLabel) -> std::io::Result<AgentUnit> {
        let backend = self.backend.reopen(&record.unit_id)?;
        let unit = AgentUnit::new(
            record.unit_id.clone(),
            backend,
            self.capability(),
            self.store.clone(),
            label,
            Some(record.clone()),
        );
        unit.pin_recorded_roots(&record.roots);
        Ok(unit)
    }

    /// A pre-containment (v1 record) Codex sidecar: members are found by its
    /// legacy tag, its pinned roots and their descendants (it was started
    /// without a reaper shim). It gets a freshly minted unit id with a
    /// Running record holding the roots that could be pinned.
    pub fn adopt_legacy(
        &self,
        tag_key: &str,
        tag_value: &str,
        roots: &[(u32, u64)],
        label: UnitLabel,
    ) -> AgentUnit {
        let id = UnitId::mint();
        let backend = legacy_backend(tag_key, tag_value, &id);
        let record = UnitRecord {
            unit_id: id.clone(),
            provider: label.provider.clone(),
            mode: label.mode.clone(),
            terminal_id: label.terminal_id.clone(),
            create_request_id: label.create_request_id.clone(),
            conversation_keys: label
                .session_id
                .iter()
                .map(|s| (label.provider.clone(), s.clone()))
                .collect(),
            roots: Vec::new(),
            state: UnitRecordState::Running,
        };
        let unit = AgentUnit::new(
            id,
            backend,
            self.capability(),
            self.store.clone(),
            label,
            None,
        );
        let mut pinned = Vec::new();
        for (pid, start) in roots {
            match ProcWatch::open_expecting(*pid, *start) {
                Ok(watch) => pinned.push(watch),
                Err(err) => {
                    events::root_not_pinned(&unit.log_keys(None), *pid, *start, &err.to_string())
                }
            }
        }
        let record = UnitRecord {
            roots: pinned
                .iter()
                .map(|w| (w.pid(), w.identity().start))
                .collect(),
            ..record
        };
        if let Err(err) = self.store.write(&record) {
            events::record_write_failed(&unit.log_keys(None), "create", &err.to_string());
        }
        unit.adopt_record(record, pinned);
        unit
    }
}

#[cfg(unix)]
fn legacy_backend(tag_key: &str, tag_value: &str, id: &UnitId) -> Arc<dyn UnitBackend> {
    Arc::new(crate::backend::tag::TagUnit::new(
        tag_key, tag_value, id, None,
    ))
}

/// Windows never retains a sidecar across a restart, so a legacy unit has
/// no job: its stop reaches its identity-verified roots and their
/// descendants by handle.
#[cfg(windows)]
fn legacy_backend(_tag_key: &str, _tag_value: &str, _id: &UnitId) -> Arc<dyn UnitBackend> {
    Arc::new(crate::backend::windows_job::RecordedUnit)
}

static GLOBAL: OnceLock<Containment> = OnceLock::new();

/// Install the process-global containment (freshell-server main, once).
pub fn set_global_containment(c: Containment) -> bool {
    GLOBAL.set(c).is_ok()
}

pub fn global_containment() -> Option<Containment> {
    GLOBAL.get().cloned()
}
