//! P1.13 crate-boundary bridge: fresh-agent identity events flow OUT of this
//! crate through this trait; `freshell-server` implements it over the pane
//! ledger (this crate must not depend on `freshell-ws`, where the ledger
//! lives — the dependency edge runs the other way).

use std::sync::Arc;

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
    /// Task 3 semantics change: true iff a SETTINGS-BEARING record was
    /// persisted for this key — a lineage-only binding row (all-blank
    /// settings snapshot, recorded unconditionally at materialization so the
    /// create-requestId lineage survives) must NOT make this true. This is
    /// the SETTINGS_RESET alarm gate (V7/A10): the alarm arms only when a
    /// settings-bearing record provably existed yet no snapshot is
    /// recoverable; lineage-only rows (legitimately-default creates) resume
    /// silently with defaults, never a false alarm. `load_settings` is
    /// unchanged — it returns None for lineage-only rows.
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool;
    /// Task 3 lineage lookup: resolve a CREATE requestId to the durable
    /// session id recorded on the newest matching binding row (the pane-ledger
    /// `lookup_by_create_request_id` rule: Bound or GcExpired, newest by
    /// updated_at), regardless of whether the row carries a settings snapshot.
    /// Synchronous + memory-fast like `load_settings`/`was_recorded`; the REST
    /// resume path uses it to resolve `freshopencode-<createRequestId>`
    /// placeholders to their materialized `ses_*` session.
    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String>;
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
    /// Keys with a SETTINGS-BEARING record (Task 3 keying) plus anything
    /// seed_recorded_only marked — backs `was_recorded`. Blank-settings
    /// bindings never enter (and a blank rewrite removes the key, matching
    /// the ledger's full-snapshot replace).
    pub recorded: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
    /// When true, write futures resolve to Err — for failure-surfacing tests.
    pub fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl FakeIdentitySink {
    #[allow(dead_code)] // used by identity-event tasks (Tasks 4-10 tests)
    pub fn seed(&self, provider: &str, session_id: &str, s: FreshAgentSettings) {
        // A seed mirrors a real binding write: the lineage row lands on the
        // `bindings` log, and the key counts as "recorded" only when the
        // snapshot is settings-bearing (Task 3 keying).
        let settings_bearing = s != FreshAgentSettings::default();
        if settings_bearing {
            self.recorded
                .lock()
                .unwrap()
                .insert((provider.into(), session_id.into()));
            self.settings
                .lock()
                .unwrap()
                .insert((provider.into(), session_id.into()), s.clone());
        }
        self.bindings.lock().unwrap().push(FreshAgentBindingUpsert {
            provider: provider.into(),
            session_id: session_id.into(),
            mode: String::new(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            settings: s,
        });
    }
    /// Mark a key as previously recorded WITHOUT a recoverable snapshot —
    /// the SETTINGS_RESET-alarm-positive fixture (V7/A10 gating): the genuine
    /// "recorded but unrecoverable" anomaly. Stays alarm-positive under the
    /// Task 3 keying (`recorded` membership alone drives `was_recorded`).
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
            let key = (upsert.provider.clone(), upsert.session_id.clone());
            // Task 3 keying (mirrors `PaneLedger::fresh_agent_settings_recorded`
            // and the ledger sink's `load_settings` blank guard): settings are
            // a FULL snapshot (replace), so a blank snapshot REPLACES any prior
            // one — the key leaves `settings`/`recorded` again. A lineage-only
            // write therefore still lands on the `bindings` log but never
            // counts as a settings-bearing record.
            let settings_bearing = upsert.settings != FreshAgentSettings::default();
            if settings_bearing {
                self.recorded.lock().unwrap().insert(key.clone());
                self.settings
                    .lock()
                    .unwrap()
                    .insert(key, upsert.settings.clone());
            } else {
                self.recorded.lock().unwrap().remove(&key);
                self.settings.lock().unwrap().remove(&key);
            }
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
    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String> {
        // The bindings log is write-ordered; the LAST matching row is the
        // newest (the ledger's newest-by-updated_at rule, minus timestamps).
        self.bindings
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|b| {
                b.provider == provider && b.create_request_id.as_deref() == Some(create_request_id)
            })
            .map(|b| b.session_id.clone())
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

    /// Task 3 semantics: a lineage-only binding (all-blank settings snapshot —
    /// the shape the unconditional REST materialization write produces for a
    /// default create) records LINEAGE but is NOT a "recorded" session: it must
    /// not set `was_recorded` (that would arm a false SETTINGS_RESET on resume —
    /// exactly `was_recorded == true` with `load_settings == None`) and must not
    /// answer a settings snapshot, while the lineage columns themselves are
    /// preserved on the binding log.
    #[tokio::test]
    async fn fake_sink_blank_settings_binding_is_lineage_only() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_blank".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-blank".into()),
            resolves_pending: Some("freshopencode-cr-blank".into()),
            supersedes: None,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding write ok");

        // The lineage row was written...
        {
            let bindings = fake.bindings.lock().unwrap();
            let row = bindings
                .iter()
                .find(|b| b.session_id == "ses_blank")
                .expect("lineage row recorded even with blank settings");
            assert_eq!(row.create_request_id.as_deref(), Some("cr-blank"));
        }

        // ...but it is NOT a settings-bearing record: no snapshot answer, no
        // "recorded" flag (Task 3 `was_recorded` keying).
        assert!(
            fake.load_settings("opencode", "ses_blank").is_none(),
            "a lineage-only row must answer no settings snapshot"
        );
        assert!(
            !fake.was_recorded("opencode", "ses_blank"),
            "a lineage-only row must not count as recorded (false SETTINGS_RESET)"
        );
    }

    /// Task 3: the placeholder→durable lineage lookup the REST resume door
    /// needs — resolve a create requestId to the durable session id off the
    /// binding log. A lineage-only row (blank settings) still answers: lineage
    /// is independent of settings recordability.
    #[tokio::test]
    async fn fake_sink_lookup_by_create_request_id_resolves_lineage() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_abc".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-1".into()),
            resolves_pending: Some("freshopencode-cr-1".into()),
            supersedes: None,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding write ok");
        assert_eq!(
            fake.lookup_by_create_request_id("opencode", "cr-1")
                .as_deref(),
            Some("ses_abc")
        );
        // Unknown create requestId / other provider miss.
        assert_eq!(
            fake.lookup_by_create_request_id("opencode", "cr-nope"),
            None
        );
        assert_eq!(fake.lookup_by_create_request_id("codex", "cr-1"), None);
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
