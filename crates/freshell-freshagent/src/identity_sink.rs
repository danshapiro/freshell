//! P1.13 crate-boundary bridge: fresh-agent identity events flow OUT of this
//! crate through this trait; `freshell-server` implements it over the pane
//! ledger (this crate must not depend on `freshell-ws`, where the ledger
//! lives — the dependency edge runs the other way).

use std::sync::Arc;

use freshell_recovery::MaterializationState;

/// Resume-invocation record (campaign plan §4.2): exactly what the
/// provider-native resume command needs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FreshAgentSettings {
    pub model: Option<String>,
    pub sandbox: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
}

/// One fresh-agent identity event. Settings are a FULL snapshot (replace,
/// not merge). `resolves_pending` names a pending marker (placeholder id)
/// this binding supersedes.
#[derive(Debug, Clone, PartialEq)]
pub struct FreshAgentBindingUpsert {
    pub provider: String,
    pub session_id: String,
    pub provider_scope: Option<String>,
    pub materialization: MaterializationState,
    pub mode: String,
    pub create_request_id: Option<String>,
    pub resolves_pending: Option<String>,
    /// G3 supersession (V8/A14): OLD session id this binding replaces
    /// (codex crash-respawn passes the old thread id; everyone else None).
    pub supersedes: Option<String>,
    pub settings: FreshAgentSettings,
}

/// Write-completion future (see Interfaces block for the style citation:
/// BoxFuture aliases at freshell-opencode/src/serve.rs:44 /
/// freshell-codex/src/app_server.rs:62; no async-trait dep in the workspace).
pub type SinkWrite =
    std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + 'static>>;

/// AWAITED writes (wave-A durable-before-answer policy, V8/A11): callers
/// `.await` the returned future before replying/broadcasting/proceeding.
/// Implementations run fsync work on `spawn_blocking` and propagate failures
/// as `Err` — call sites surface them user-visibly, then proceed (a write
/// failure never blocks the identity event). Reads are memory-fast + sync.
pub trait PaneIdentitySink: Send + Sync {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite;
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite;
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings>;
    /// True iff a fresh-agent binding row was EVER recorded for this key —
    /// the SETTINGS_RESET alarm gate (V7/A10): alarm only when the ledger
    /// proves prior recording; never for never-recorded sessions.
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool;
}

pub type SharedPaneIdentitySink = Arc<dyn PaneIdentitySink>;

/// In-memory sink for tests, crate-wide. Mutations happen synchronously
/// before the (already-completed) future is returned, so tests can assert
/// immediately after `.await`.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeIdentitySink {
    pub pendings: std::sync::Mutex<Vec<(String, String, Option<String>)>>,
    pub bindings: std::sync::Mutex<Vec<FreshAgentBindingUpsert>>,
    pub settings: std::sync::Mutex<std::collections::HashMap<(String, String), FreshAgentSettings>>,
    /// Keys ever recorded (or seeded) — backs `was_recorded`.
    pub recorded: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
    /// When true, write futures resolve to Err — for failure-surfacing tests.
    pub fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl FakeIdentitySink {
    #[allow(dead_code)] // used by identity-event tasks (Tasks 4-10 tests)
    pub fn seed(&self, provider: &str, session_id: &str, s: FreshAgentSettings) {
        self.recorded
            .lock()
            .unwrap()
            .insert((provider.into(), session_id.into()));
        self.settings
            .lock()
            .unwrap()
            .insert((provider.into(), session_id.into()), s);
    }
    /// Mark a key as previously recorded WITHOUT a recoverable snapshot —
    /// the SETTINGS_RESET-alarm-positive fixture (V7/A10 gating).
    #[allow(dead_code)] // used by identity-event tasks (Tasks 4-10 tests)
    pub fn seed_recorded_only(&self, provider: &str, session_id: &str) {
        self.recorded
            .lock()
            .unwrap()
            .insert((provider.into(), session_id.into()));
    }
    fn write_result(&self) -> SinkWrite {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            Box::pin(std::future::ready(Err(std::io::Error::other(
                "fake write failure",
            ))))
        } else {
            Box::pin(std::future::ready(Ok(())))
        }
    }
}

#[cfg(test)]
impl PaneIdentitySink for FakeIdentitySink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.pendings.lock().unwrap().push((
                placeholder_id.into(),
                mode.into(),
                cwd.map(Into::into),
            ));
        }
        self.write_result()
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.recorded
                .lock()
                .unwrap()
                .insert((upsert.provider.clone(), upsert.session_id.clone()));
            self.settings.lock().unwrap().insert(
                (upsert.provider.clone(), upsert.session_id.clone()),
                upsert.settings.clone(),
            );
            self.bindings.lock().unwrap().push(upsert);
        }
        self.write_result()
    }
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        self.settings
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            .cloned()
    }
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.recorded
            .lock()
            .unwrap()
            .contains(&(provider.into(), session_id.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn fake_sink_records_and_serves_settings() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_pending("freshopencode-r1", "freshopencode", Some("/w"))
            .await
            .expect("pending write ok");
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_1".into(),
            provider_scope: None,
            materialization: MaterializationState::Observed,
            mode: "freshopencode".into(),
            create_request_id: Some("r1".into()),
            resolves_pending: Some("freshopencode-r1".into()),
            supersedes: None,
            settings: FreshAgentSettings {
                model: Some("m".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("low".into()),
                cwd: Some("/w".into()),
            },
        })
        .await
        .expect("binding write ok");
        let s = fake.load_settings("opencode", "ses_1").expect("settings");
        assert_eq!(s.model.as_deref(), Some("m"));
        assert_eq!(s.effort.as_deref(), Some("low"));
        assert_eq!(fake.pendings.lock().unwrap().len(), 1);
        assert_eq!(fake.bindings.lock().unwrap().len(), 1);
        assert!(fake.load_settings("opencode", "nope").is_none());
        assert!(fake.was_recorded("opencode", "ses_1"));
        assert!(!fake.was_recorded("opencode", "nope"));
    }

    #[tokio::test]
    async fn fake_sink_failure_knob_returns_err() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.fail_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            fake.record_pending("p", "freshopencode", None)
                .await
                .is_err(),
            "failure must surface as Err, never be swallowed"
        );
    }
}
