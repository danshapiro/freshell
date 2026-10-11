//! Captures `freshell_unit` events (level, `event` field, every other field
//! as text, and when each was logged) for assertions.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

/// One captured event: its level, its `event` name, every field as text, and
/// `at`, when it was logged (a layer sees each event synchronously, in the
/// logging thread, as it is logged).
#[derive(Clone, Debug)]
pub struct Event {
    pub level: tracing::Level,
    pub event: String,
    pub fields: BTreeMap<String, String>,
    pub at: Instant,
}

/// The captured events, and a wake-up for each one captured (see
/// [`Captured::wait_for`]).
#[derive(Clone, Default)]
pub struct Captured(pub Arc<Mutex<Vec<Event>>>, Arc<tokio::sync::Notify>);

#[derive(Default)]
struct Fields(BTreeMap<String, String>);
impl Visit for Fields {
    fn record_str(&mut self, f: &Field, v: &str) {
        self.0.insert(f.name().to_string(), v.to_string());
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        self.0.insert(
            f.name().to_string(),
            format!("{v:?}").trim_matches('"').to_string(),
        );
    }
}

impl<S: tracing::Subscriber> Layer<S> for Captured {
    fn on_event(&self, e: &tracing::Event<'_>, _: Context<'_, S>) {
        let at = Instant::now();
        let mut fields = Fields::default();
        e.record(&mut fields);
        if let Some(name) = fields.0.remove("event") {
            self.0.lock().unwrap().push(Event {
                level: *e.metadata().level(),
                event: name,
                fields: fields.0,
                at,
            });
            self.1.notify_waiters();
        }
    }
}

pub fn install() -> (Captured, tracing::subscriber::DefaultGuard) {
    ask_every_dispatcher();
    let cap = Captured::default();
    let guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(cap.clone()));
    (cap, guard)
}

impl Captured {
    pub fn has(&self, level: tracing::Level, event: &str) -> bool {
        self.has_with(level, event, &[])
    }

    /// An event of this level and name whose fields include every
    /// `(key, value)` pair given (values as text).
    pub fn has_with(&self, level: tracing::Level, event: &str, fields: &[(&str, &str)]) -> bool {
        self.first(level, event, fields).is_some()
    }

    /// The first such event (as [`Captured::has_with`] matches them), once
    /// it is captured: event-driven (woken by each captured event), giving
    /// up after `limit`.
    pub async fn wait_for(
        &self,
        level: tracing::Level,
        event: &str,
        fields: &[(&str, &str)],
        limit: std::time::Duration,
    ) -> Option<Event> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let captured = self.1.notified();
            tokio::pin!(captured);
            // Registered before the check, so an event captured between the
            // check and the wait still wakes it.
            captured.as_mut().enable();
            if let Some(found) = self.first(level, event, fields) {
                return Some(found);
            }
            tokio::time::timeout_at(deadline, captured).await.ok()?;
        }
    }

    /// The first such event (as [`Captured::has_with`] matches them).
    pub fn first(
        &self,
        level: tracing::Level,
        event: &str,
        fields: &[(&str, &str)],
    ) -> Option<Event> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|e| {
                e.level == level
                    && e.event == event
                    && fields
                        .iter()
                        .all(|(k, v)| e.fields.get(*k).map(String::as_str) == Some(*v))
            })
            .cloned()
    }
}

/// tracing-core caches each callsite's interest at the callsite's first use,
/// and while at most one dispatcher is registered it asks only the CURRENT
/// thread's default. A callsite first used on another test's thread (which
/// has no subscriber) is then cached as "never", and this thread's capture
/// misses that event for good: random missing events whenever tests that
/// emit the same events run in parallel. A second dispatcher that lives for
/// the whole process makes tracing ask every live dispatcher instead.
fn ask_every_dispatcher() {
    static SECOND: OnceLock<tracing::Dispatch> = OnceLock::new();
    SECOND.get_or_init(|| tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default()));
}
