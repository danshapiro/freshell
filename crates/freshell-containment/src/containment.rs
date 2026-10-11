//! `Containment`: the backend this server uses, its unit-record store, and
//! the process-global handle. Units are found after a restart ONLY through
//! this server's own records: nothing enumerates slices, tags, jobs or
//! processes beyond a recorded unit id (Stage 2: LB-01), and every recorded
//! root is pinned by pid AND start time before anything can signal it
//! (Stage 2: LB-02).

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use crate::backend::{Backend, BackendKind, Capability, UnitBackend};
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
    /// self-placement, macOS `--setsid`): the server passes its own exe +
    /// `__unit-exec`; tests pass the `freshell-unit-exec` bin.
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
            legacy_tag: None,
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
    /// `unit.root.not_pinned`. A legacy unit (`record.legacy_tag`) finds its
    /// members by that tag again, with the capability of that finder, as its
    /// adoption did.
    pub fn reopen_unit(&self, record: &UnitRecord, label: UnitLabel) -> std::io::Result<AgentUnit> {
        let (backend, capability) = match &record.legacy_tag {
            Some((key, value)) => legacy_backend(key, value, &record.unit_id),
            None => (self.backend.reopen(&record.unit_id)?, self.capability()),
        };
        let unit = AgentUnit::new(
            record.unit_id.clone(),
            backend,
            capability,
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
    /// Running record holding the roots that could be pinned and the legacy
    /// tag, so a later reopen finds the same members. Its capability is the
    /// legacy finder's (never full), whatever this server's backend is.
    pub fn adopt_legacy(
        &self,
        tag_key: &str,
        tag_value: &str,
        roots: &[(u32, u64)],
        label: UnitLabel,
    ) -> AgentUnit {
        let id = UnitId::mint();
        let (backend, capability) = legacy_backend(tag_key, tag_value, &id);
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
            legacy_tag: Some((tag_key.to_string(), tag_value.to_string())),
        };
        let unit = AgentUnit::new(id, backend, capability, self.store.clone(), label, None);
        let mut pinned = Vec::new();
        for (pid, start) in roots {
            match ProcWatch::open_expecting(*pid, *start) {
                // Never pinned, so never signalled (as `pin_recorded_roots`).
                Ok(watch) if crate::process::in_codex_daemon_family(*pid) => {
                    events::spared(&unit.log_keys(None), &[watch.identity().clone()]);
                }
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

/// A legacy unit's member finder and its capability. The finder is never a
/// kernel container (full: false), whatever this server's backend is, so
/// the unit's stop pins every member before the soft signal: a member that
/// carries no tag and whose parent root exits during the grace is still
/// killed.
#[cfg(unix)]
fn legacy_backend(
    tag_key: &str,
    tag_value: &str,
    id: &UnitId,
) -> (Arc<dyn UnitBackend>, Capability) {
    let kind = if cfg!(target_os = "macos") {
        BackendKind::MacosTag
    } else {
        BackendKind::LinuxTag
    };
    (
        Arc::new(crate::backend::tag::TagUnit::legacy(tag_key, tag_value, id)),
        Capability {
            kind,
            full: false,
            reason: Some("legacy sidecar: found by its tag, roots and their descendants".into()),
        },
    )
}

/// Windows never retains a sidecar across a restart, so a legacy unit has
/// no job: its stop reaches its identity-verified roots and their
/// descendants by handle.
#[cfg(windows)]
fn legacy_backend(
    _tag_key: &str,
    _tag_value: &str,
    _id: &UnitId,
) -> (Arc<dyn UnitBackend>, Capability) {
    (
        Arc::new(crate::backend::windows_job::RecordedUnit),
        Capability {
            kind: BackendKind::WindowsJob,
            full: false,
            reason: Some("legacy sidecar: no job; found by its roots and their descendants".into()),
        },
    )
}

static GLOBAL: OnceLock<Containment> = OnceLock::new();

/// Install the process-global containment (freshell-server main, once).
pub fn set_global_containment(c: Containment) -> bool {
    GLOBAL.set(c).is_ok()
}

pub fn global_containment() -> Option<Containment> {
    GLOBAL.get().cloned()
}

/// The containment [`global_or_fallback_containment`] made for a process
/// that installed none, with what its exit handler needs.
struct Fallback {
    containment: Containment,
    /// Its per-process state root (unit records live in `<root>/units/`).
    root: PathBuf,
    /// The process that made it. A child forked without exec inherits this
    /// memory and the exit handler, and must touch neither its parent's
    /// units nor their records.
    pid: u32,
    /// The records its store took over when it opened (a directory an
    /// earlier process with the same pid left behind): units this process
    /// never created, which its exit never stops. (Windows stops none at
    /// exit: see [`Fallback::kill_own_units`].)
    #[cfg_attr(windows, allow(dead_code))]
    inherited: BTreeSet<UnitId>,
}

static FALLBACK: OnceLock<Fallback> = OnceLock::new();

impl Fallback {
    /// The fallback containment of process `pid` on the state root `root`:
    /// the tag backend, whose store takes over, as it opens, the records
    /// whose locks are free there (a directory an earlier process with the
    /// same pid left behind). Those are noted as inherited.
    fn open(pid: u32, root: PathBuf) -> Self {
        let containment = Containment::tag_backend(SelectOptions {
            shim: None,
            state_root: root.clone(),
        });
        let inherited = containment
            .recorded_units()
            .unwrap_or_default()
            .into_iter()
            .map(|record| record.unit_id)
            .collect();
        Self {
            containment,
            root,
            pid,
            inherited,
        }
    }

    /// Kills every unit this process created that is still recorded (it
    /// never reached Gone: a test that ended early), one after another on
    /// this thread, each as `TagUnit::kill_recorded_now` finds its members:
    /// its live roots (pid and start time) and their descendants, plus the
    /// carriers of the unit tag this process minted; never a host-wide
    /// search for an adopted sidecar's legacy tag, which processes this one
    /// did not create can carry. Codex's daemon family is spared.
    ///
    /// Windows needs none: the fallback has no shim, so no member can be
    /// placed in its units, and a job kills its members when this process's
    /// handles close at exit.
    #[cfg(unix)]
    fn kill_own_units(&self) {
        for record in self.containment.recorded_units().unwrap_or_default() {
            if !self.inherited.contains(&record.unit_id) {
                let _ = crate::backend::tag::TagUnit::kill_recorded_now(&record);
            }
        }
    }
}

/// Runs when a process with the fallback containment exits. Nothing can
/// reach its units afterwards (no server ever reads its state root: only a
/// server's own state root is reconciled at boot), so the units it created
/// that are still recorded are killed first, then the root is removed.
/// Synchronous and bounded (one sweep per such unit); a panic is contained
/// here, never unwound into the C runtime. A server's own containment never
/// registers it: its running units outlive it by design.
extern "C" fn stop_fallback_units_and_remove_root() {
    let Some(fallback) = FALLBACK.get() else {
        return;
    };
    if fallback.pid != std::process::id() {
        return;
    }
    // Unwind-safe: nothing observes the state after a panic but this
    // handler, which goes on to the root's removal.
    #[cfg(unix)]
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fallback.kill_own_units()));
    let _ = std::fs::remove_dir_all(&fallback.root);
}

/// The process-global containment; where none was installed (tests, tools
/// that never boot a server), one per-process tag-backend containment whose
/// unit records live in a per-process directory under the system temp
/// directory (never a relative path: creating a unit writes its record
/// there). When the process exits, the units it created there that never
/// reached Gone are killed and that directory is removed.
pub fn global_or_fallback_containment() -> Containment {
    if let Some(global) = global_containment() {
        return global;
    }
    FALLBACK
        .get_or_init(|| {
            let pid = std::process::id();
            let fallback = Fallback::open(
                pid,
                std::env::temp_dir().join(format!("freshell-units-{pid}")),
            );
            // SAFETY: `atexit` only stores the pointer. The handler is a
            // plain `extern "C"` function with no arguments that lives as
            // long as the process, and it never unwinds into the C runtime
            // (its sweep runs under `catch_unwind`).
            unsafe { libc::atexit(stop_fallback_units_and_remove_root) };
            fallback
        })
        .containment
        .clone()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::proc_watch::Sig;
    use std::time::Duration;

    /// A child of the test (a plain `sleep 600` unless spawned from another
    /// command), pinned while it is our own unreaped child, killed through
    /// that pin and reaped on drop.
    struct Sleep {
        child: std::process::Child,
        watch: ProcWatch,
    }

    impl Sleep {
        fn start() -> Self {
            Self::spawn(std::process::Command::new("sleep").arg("600"))
        }

        fn spawn(command: &mut std::process::Command) -> Self {
            let child = command.spawn().unwrap();
            let watch = ProcWatch::open(child.id()).unwrap();
            Self { child, watch }
        }

        fn root(&self) -> (u32, u64) {
            (self.watch.pid(), self.watch.identity().start)
        }

        /// Not killed: no exit within a bounded wait that ends at once on
        /// an exit.
        fn still_running(&self) -> bool {
            !self
                .watch
                .wait_exited_blocking(Duration::from_millis(300))
                .unwrap()
        }
    }

    impl Drop for Sleep {
        fn drop(&mut self) {
            let _ = self.watch.signal(Sig::Kill);
            let _ = self.child.wait();
        }
    }

    fn record_with_roots(roots: Vec<(u32, u64)>) -> UnitRecord {
        UnitRecord {
            unit_id: UnitId::mint(),
            provider: "codex".into(),
            mode: "codex".into(),
            terminal_id: None,
            create_request_id: None,
            conversation_keys: Vec::new(),
            roots,
            state: UnitRecordState::Running,
            legacy_tag: None,
        }
    }

    /// The exit sweep reaches only units this process created, and in each
    /// only the roots whose pid still names the recorded incarnation: a
    /// root recorded with another start time (its process exited and the
    /// pid was reused) and a unit the store took over at open are never
    /// signalled; the unit's own live root is killed.
    #[test]
    fn the_exit_sweep_kills_only_its_own_units_live_roots() {
        let state = tempfile::tempdir().unwrap();
        let containment = Containment::tag_backend(SelectOptions {
            shim: None,
            state_root: state.path().to_path_buf(),
        });
        let (stale, inherited_root, mut own) = (Sleep::start(), Sleep::start(), Sleep::start());
        let (pid, start) = stale.root();
        let inherited = record_with_roots(vec![inherited_root.root()]);
        for record in [
            record_with_roots(vec![(pid, start + 1)]),
            inherited.clone(),
            record_with_roots(vec![own.root()]),
        ] {
            containment.store.write(&record).unwrap();
        }
        let fallback = Fallback {
            containment,
            root: state.path().to_path_buf(),
            pid: std::process::id(),
            inherited: BTreeSet::from([inherited.unit_id]),
        };

        fallback.kill_own_units();

        use std::os::unix::process::ExitStatusExt;
        assert_eq!(own.child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert!(
            stale.still_running(),
            "a root with another start time was killed"
        );
        assert!(
            inherited_root.still_running(),
            "a unit this process did not create was killed"
        );
    }

    /// The fallback opens its store on a directory an earlier process with
    /// the same pid may have left behind: the records it takes over there
    /// (their locks are free) are inherited, so its exit never stops them;
    /// a unit it creates afterwards is its own.
    #[test]
    fn the_fallback_inherits_only_the_records_it_finds_at_open() {
        let state = tempfile::tempdir().unwrap();
        let left_behind = record_with_roots(Vec::new());
        // The earlier process's store, closed: its locks are released.
        RecordStore::open(state.path()).write(&left_behind).unwrap();

        let fallback = Fallback::open(std::process::id(), state.path().to_path_buf());
        let created = fallback
            .containment
            .create_unit(
                UnitId::mint(),
                UnitLabel {
                    provider: "codex".into(),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(fallback.root, state.path());
        assert_eq!(fallback.inherited, BTreeSet::from([left_behind.unit_id]));
        let recorded: Vec<UnitId> = fallback
            .containment
            .recorded_units()
            .unwrap()
            .into_iter()
            .map(|record| record.unit_id)
            .collect();
        assert!(recorded.contains(created.id()), "{recorded:?}");
        assert!(!fallback.inherited.contains(created.id()));
    }

    /// A pinned process that is not the test's own child, killed through
    /// its pin on drop.
    struct Pinned(ProcWatch);

    impl Drop for Pinned {
        fn drop(&mut self) {
            let _ = self.0.signal(Sig::Kill);
        }
    }

    /// A legacy unit's tag was not minted by this process: another process
    /// (a concurrent copy of the same test, adopting a sidecar with the same
    /// fixed id) can carry it. So the exit sweep reaches a legacy unit only
    /// through its recorded roots, each verified by pid and start time, and
    /// their descendants: the root and its child are killed, and a process
    /// that carries the same tag but is neither a recorded root nor below
    /// one is never signalled.
    #[test]
    fn the_exit_sweep_reaches_a_legacy_unit_only_through_its_roots() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};

        let state = tempfile::tempdir().unwrap();
        let containment = Containment::tag_backend(SelectOptions {
            shim: None,
            state_root: state.path().to_path_buf(),
        });
        // Unique to this run: this test can reach no other run's process.
        let tag = (
            crate::LEGACY_CODEX_TAG_ENV.to_string(),
            format!("codex-sidecar-{}", UnitId::mint().as_str()),
        );
        let tagged = |program: &str, args: &[&str]| {
            let mut command = Command::new(program);
            command.args(args).env(&tag.0, &tag.1);
            command
        };
        // The adopted sidecar: a recorded root with a child of its own,
        // which it names once it has started it.
        let mut root =
            Sleep::spawn(tagged("sh", &["-c", "sleep 600 & echo $!; wait"]).stdout(Stdio::piped()));
        let mut line = String::new();
        std::io::BufReader::new(root.child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let child = Pinned(ProcWatch::open(line.trim().parse().unwrap()).unwrap());
        // Another run's sidecar: the same tag, never recorded here.
        let decoy = Sleep::spawn(&mut tagged("sleep", &["600"]));
        containment
            .store
            .write(&UnitRecord {
                legacy_tag: Some(tag.clone()),
                ..record_with_roots(vec![root.root()])
            })
            .unwrap();
        let fallback = Fallback {
            containment,
            root: state.path().to_path_buf(),
            pid: std::process::id(),
            inherited: BTreeSet::new(),
        };

        fallback.kill_own_units();

        assert!(
            decoy.still_running(),
            "a process carrying the legacy tag outside the unit's roots was killed"
        );
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(root.child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert!(
            child
                .0
                .wait_exited_blocking(Duration::from_secs(10))
                .unwrap(),
            "the root's child outlived the sweep"
        );
    }
}
