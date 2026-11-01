//! Antigravity home-resolution tests (whole-delta review round 7, Major
//! 2). Sibling child of provider_layout.rs (the `codex_locator_tests_warn.rs`
//! top-level `#[path]`-include convention: the parent file sits against
//! the 1K-line cap). The resolution under test lives at
//! `crate::provider_layout::antigravity_home`.
//!
//! The snap facts (probed READ-ONLY on this machine's real snap install,
//! 2026-11-01; receipts in the plan's Provider Contract Record): the
//! on-PATH `agy` is the snap build (antigravity-cli 1.4.12 via a
//! `~/.local/bin/agy` wrapper), snap confinement pins the CLI's `HOME`
//! to `~/snap/antigravity-cli/common`, and the store lives at
//! `~/snap/antigravity-cli/common/.gemini/antigravity-cli/brain/<id>/
//! .system_generated/logs/transcript.jsonl` (three real conversations) —
//! while `~/.gemini/antigravity-cli` exists with an EMPTY `brain/`. Pre
//! round 7, `antigravity_home` resolved only the default root, so on
//! that machine history/search/identity/activity silently found nothing.

use std::path::Path;

use super::antigravity_home;

/// Save-and-restore guard for one env var; restores on drop, panic
/// included. Local twin of the parent tests module's `EnvVarGuard` (kept
/// local per the crate's existing per-module test-guard precedent).
struct EnvVarGuard {
    name: &'static str,
    saved: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let saved = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, saved }
    }

    fn unset(name: &'static str) -> Self {
        let saved = std::env::var_os(name);
        std::env::remove_var(name);
        Self { name, saved }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match self.saved.take() {
            Some(v) => std::env::set_var(self.name, v),
            None => std::env::remove_var(self.name),
        }
    }
}

/// A unique empty dir for a fake HOME (the parent tests module has no
/// dir helper; this file's tests need real disk shapes).
fn unique_home(label: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "freshell-agy-home-resolution-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The snap install's store root under a fake HOME (the probed layout:
/// the snap pins the CLI's HOME to `~/snap/antigravity-cli/common`, and
/// the CLI writes its usual `.gemini/antigravity-cli` store under it).
fn snap_root(home: &Path) -> std::path::PathBuf {
    home.join("snap")
        .join("antigravity-cli")
        .join("common")
        .join(".gemini")
        .join("antigravity-cli")
}

fn default_root(home: &Path) -> std::path::PathBuf {
    home.join(".gemini").join("antigravity-cli")
}

/// Plant one conversation dir under `root`'s brain tree (the smallest
/// shape a conversation-bearing store accepts).
fn plant_conversation(root: &Path, conv: &str) {
    std::fs::create_dir_all(root.join("brain").join(conv)).unwrap();
}

/// Round 7, Major 2: the snap store root is chosen whenever the default
/// root is absent or holds no conversations, the default wins when it
/// holds conversations, both-absent resolves the default honestly, and
/// the env override wins as-is (never broken by the fallback). Mutates
/// process env (`FRESHELL_ANTIGRAVITY_HOME` must be unset for the
/// default/snap arms) — serialized on the crate-wide HOME_ENV_TEST_LOCK.
#[test]
fn snap_store_root_resolves_when_the_default_root_is_absent_or_conversation_less() {
    let _lock = crate::HOME_ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _guard = EnvVarGuard::unset("FRESHELL_ANTIGRAVITY_HOME");

    let home = unique_home("snap-defaults");

    // (1) Default root ABSENT, snap root holds a conversation → the
    // snap root is chosen (pre-round-7 this resolved the default and the
    // snap store was invisible to every feature).
    plant_conversation(&snap_root(&home), "conv-snap-one");
    assert_eq!(
        antigravity_home(&home),
        snap_root(&home),
        "an absent default root falls back to the snap store root"
    );

    // (2) The observed dev-machine shape: the default root EXISTS (a
    // raw-binary run created its subtree) but its brain holds NO
    // conversations, while the snap store has the real ones → the snap
    // root still wins (a conversation-less default cannot shadow the
    // user's real store).
    std::fs::create_dir_all(default_root(&home).join("brain")).unwrap();
    assert_eq!(
        antigravity_home(&home),
        snap_root(&home),
        "a conversation-less default root does not shadow the snap store"
    );

    // (3) The default root holds a conversation → the default wins
    // (resolution order: env > default > snap).
    plant_conversation(&default_root(&home), "conv-default-one");
    assert_eq!(
        antigravity_home(&home),
        default_root(&home),
        "a conversation-bearing default root wins over the snap root"
    );

    // (4) BOTH roots absent → the default path resolves honestly (the
    // place a non-snap CLI will write).
    let bare = unique_home("snap-both-absent");
    assert_eq!(
        antigravity_home(&bare),
        default_root(&bare),
        "both roots absent resolves the default path"
    );

    // (5) The env override is used AS-IS, snap present or not (the
    // amplifier_home precedent — never broken by the fallback).
    let _env = EnvVarGuard::set("FRESHELL_ANTIGRAVITY_HOME", "/custom/antigravity-home");
    assert_eq!(
        antigravity_home(&home),
        std::path::Path::new("/custom/antigravity-home")
    );
    drop(_env);
    assert_eq!(
        antigravity_home(&home),
        default_root(&home),
        "restoring the env returns to the disk-based resolution"
    );

    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&bare);
}

/// Round 7, Major 2, Global Constraint 7: the chosen root is announced
/// (`antigravity_store_root_resolved`, naming the root and its source)
/// and a machine where NEITHER root exists logs the absence loudly
/// (`antigravity_store_root_missing`) — on such a host every history,
/// locator, and existence feature is a silent no-op without that line.
///
/// The tracing callsite interest cache is process-wide and this crate's
/// other tests call `antigravity_home` without a subscriber, so the
/// capture is isolated in a child process exactly like
/// `antigravity::tests::parse_failures_emit_antigravity_parse_failed_events`.
#[test]
fn store_root_resolution_logs_the_chosen_root_and_total_absence() {
    const CHILD_ENV: &str = "FRESHELL_ANTIGRAVITY_HOME_LOG_CAPTURE_CHILD";
    if std::env::var_os(CHILD_ENV).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider_layout::antigravity_home_tests::store_root_resolution_logs_the_chosen_root_and_total_absence",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated store-root log capture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    // Serialize env mutation inside the child too (the child runs the
    // whole test-binary harness).
    let _lock = crate::HOME_ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _guard = EnvVarGuard::unset("FRESHELL_ANTIGRAVITY_HOME");

    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use tracing_subscriber::layer::SubscriberExt;
    #[derive(Clone)]
    struct Capture(Arc<StdMutex<Vec<BTreeMap<String, String>>>>);
    impl<S: tracing::Subscriber> tracing_subscriber::layer::Layer<S> for Capture {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct Fields(BTreeMap<String, String>);
            impl tracing::field::Visit for Fields {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    self.0.insert(field.name().into(), format!("{value:?}"));
                }
                fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                    self.0.insert(field.name().into(), value.into());
                }
            }
            let mut fields = Fields(BTreeMap::new());
            event.record(&mut fields);
            let event_name = fields.0.get("event").cloned();
            if matches!(
                event_name.as_deref(),
                Some("antigravity_store_root_resolved") | Some("antigravity_store_root_missing")
            ) {
                self.0.lock().unwrap().push(fields.0);
            }
        }
    }
    let events = Arc::new(StdMutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry().with(Capture(events.clone()));
    let _guard_sub = tracing::subscriber::set_default(subscriber);

    // (1) Total absence: the missing-store WARN fires, naming BOTH
    // candidate roots, beside the resolved-root INFO naming the default.
    let bare = unique_home("logs-both-absent");
    let resolved = antigravity_home(&bare);
    assert_eq!(resolved, default_root(&bare));
    {
        let captured = events.lock().unwrap();
        let missing: Vec<_> = captured
            .iter()
            .filter(|e| {
                e.get("event").map(String::as_str) == Some("antigravity_store_root_missing")
            })
            .collect();
        assert_eq!(
            missing.len(),
            1,
            "exactly one antigravity_store_root_missing warn on total absence: {captured:?}"
        );
        let warn = &missing[0];
        let default_field = warn.get("default_root").cloned().unwrap_or_default();
        let snap_field = warn.get("snap_root").cloned().unwrap_or_default();
        assert!(
            default_field.contains("logs-both-absent") && default_field.contains(".gemini"),
            "the warn names the default candidate: {warn:?}"
        );
        assert!(
            snap_field.contains("snap/antigravity-cli/common"),
            "the warn names the snap candidate: {warn:?}"
        );
        let resolved_info: Vec<_> = captured
            .iter()
            .filter(|e| {
                e.get("event").map(String::as_str) == Some("antigravity_store_root_resolved")
            })
            .collect();
        assert_eq!(
            resolved_info.len(),
            1,
            "the chosen root is announced: {captured:?}"
        );
        assert_eq!(
            resolved_info[0].get("source").map(String::as_str),
            Some("default"),
            "both-absent resolves and announces the default root: {captured:?}"
        );
        assert!(
            resolved_info[0]
                .get("root")
                .cloned()
                .unwrap_or_default()
                .contains("logs-both-absent"),
            "the announcement names the chosen root: {captured:?}"
        );
    }

    // (2) A snap-only store resolves the snap root and announces it with
    // source=snap_fallback (a DIFFERENT resolved path, so the once-per-
    // root announcement lane logs it).
    let snap_home = unique_home("logs-snap-only");
    plant_conversation(&snap_root(&snap_home), "conv-snap-logs");
    let resolved = antigravity_home(&snap_home);
    assert_eq!(resolved, snap_root(&snap_home));
    {
        let captured = events.lock().unwrap();
        let resolved_info: Vec<_> = captured
            .iter()
            .filter(|e| {
                e.get("event").map(String::as_str) == Some("antigravity_store_root_resolved")
                    && e.get("root")
                        .map(|r| r.contains("snap/antigravity-cli/common"))
                        .unwrap_or(false)
            })
            .collect();
        assert_eq!(
            resolved_info.len(),
            1,
            "the snap fallback is announced naming the snap root: {captured:?}"
        );
        assert_eq!(
            resolved_info[0].get("source").map(String::as_str),
            Some("snap_fallback"),
            "the announcement carries the snap_fallback source: {captured:?}"
        );
        assert!(
            !captured.iter().any(|e| {
                e.get("event").map(String::as_str) == Some("antigravity_store_root_missing")
                    && e.get("root")
                        .map(|r| r.contains("snap/antigravity-cli/common"))
                        .unwrap_or(false)
            }),
            "a present snap root never logs absence: {captured:?}"
        );
    }

    // (3) Repeated resolutions of the SAME root do not re-announce (the
    // wiring seams all call antigravity_home at boot — one line per
    // root, never one per seam).
    let before = events.lock().unwrap().len();
    for _ in 0..3 {
        assert_eq!(antigravity_home(&snap_home), snap_root(&snap_home));
    }
    assert_eq!(
        events.lock().unwrap().len(),
        before,
        "the announcement is once per resolved root, not per call"
    );

    let _ = std::fs::remove_dir_all(&bare);
    let _ = std::fs::remove_dir_all(&snap_home);
}
