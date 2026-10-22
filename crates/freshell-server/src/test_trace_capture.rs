//! The test binary's one process-wide tracing subscriber.
//!
//! tracing-core caches each callsite's `Interest` process-wide the first time
//! the callsite fires, computed from the dispatchers registered at that
//! moment, and two windows cache `Interest::never` for the rest of the
//! process (every later event from that callsite is dropped before any
//! subscriber sees it):
//!
//! * a callsite first fired by any thread while the global subscriber is
//!   being installed — registered (so the level filter already admits the
//!   event) but not yet the default the interest is computed from. A capture
//!   installed lazily by the first test that asks for it can therefore lose a
//!   callsite that another test's thread happens to fire at that moment.
//! * a callsite first fired by a thread outside a test's scoped
//!   (`with_subscriber` / `set_default`) subscriber while that scoped
//!   subscriber is the only registered dispatcher: the interest is computed
//!   from the firing thread's own default, which is no subscriber at all.
//!
//! Installing the capture subscriber before `main` — before any test thread
//! exists — closes both windows: every callsite's interest is computed with
//! this subscriber present (it is interested in every event), and a scoped
//! subscriber is never the only registered dispatcher.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug)]
pub(crate) struct CapturedTraceEvent {
    pub(crate) level: tracing::Level,
    pub(crate) message: String,
    pub(crate) fields: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
pub(crate) struct CapturedTraceEvents(Arc<Mutex<Vec<CapturedTraceEvent>>>);

impl CapturedTraceEvents {
    pub(crate) fn snapshot(&self) -> Vec<CapturedTraceEvent> {
        self.0.lock().unwrap().clone()
    }
}

/// Install the process-wide capture subscriber at program load, before the
/// test harness starts any test thread (see the module docs for why it must
/// precede every callsite's first event).
// SAFETY: runs before `main` on the loading thread, with no other thread in
// existence. It only allocates and installs the tracing global default; it
// touches no stdio, thread-locals or runtime state.
#[ctor::ctor]
unsafe fn install_process_trace_capture() {
    process_capture();
}

/// The shared collector of the process-wide capture subscriber. Tests that
/// inspect tracing events read it and filter by values unique to their own
/// fixture, because every test in the binary feeds the same buffer.
pub(crate) fn captured_trace_events() -> CapturedTraceEvents {
    let events = process_capture().clone();
    // Recompute interest after the process-wide subscriber is installed.
    tracing::callsite::rebuild_interest_cache();
    events
}

fn process_capture() -> &'static CapturedTraceEvents {
    use tracing_subscriber::prelude::*;

    static GLOBAL_EVENTS: OnceLock<CapturedTraceEvents> = OnceLock::new();
    GLOBAL_EVENTS.get_or_init(|| {
        let events = CapturedTraceEvents::default();
        let subscriber = tracing_subscriber::registry().with(CaptureTraceLayer {
            events: events.clone(),
        });
        tracing::subscriber::set_global_default(subscriber)
            .expect("test trace capture must install the sole test subscriber");
        events
    })
}

/// A test that must see events this collector does not keep registers an
/// observer instead of installing a second global subscriber (which the
/// already-installed capture makes impossible). Observers run for every
/// event, from whichever thread emits it, and must not emit events
/// themselves.
#[cfg(feature = "managed-provider-qualification")]
pub(crate) fn observe_all_events(observer: impl Fn(&tracing::Event<'_>) + Send + Sync + 'static) {
    event_observers().lock().unwrap().push(Box::new(observer));
}

#[cfg(feature = "managed-provider-qualification")]
type EventObserver = Box<dyn Fn(&tracing::Event<'_>) + Send + Sync>;

#[cfg(feature = "managed-provider-qualification")]
fn event_observers() -> &'static Mutex<Vec<EventObserver>> {
    static OBSERVERS: OnceLock<Mutex<Vec<EventObserver>>> = OnceLock::new();
    OBSERVERS.get_or_init(|| Mutex::new(Vec::new()))
}

struct CaptureTraceLayer {
    events: CapturedTraceEvents,
}

#[derive(Default)]
struct TraceFieldVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl tracing::field::Visit for TraceFieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let value = format!("{value:?}");
        if field.name() == "message" {
            self.message = value.clone();
        }
        self.fields.insert(field.name().to_string(), value);
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        }
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }
}

/// The events this collector keeps.
fn is_captured(metadata: &tracing::Metadata<'_>) -> bool {
    let level = *metadata.level();
    match metadata.target() {
        "freshell_server::extensions" => level == tracing::Level::WARN,
        "freshell_server::session_directory" => level == tracing::Level::ERROR,
        "freshell_server::session_names" => {
            level == tracing::Level::WARN || level == tracing::Level::INFO
        }
        // Only first-message lookup failures are retained in on_event.
        "freshell_server::auto_title_sweep" => level == tracing::Level::WARN,
        _ => false,
    }
}

/// Every event an observer may need to see (`observe_all_events`).
#[cfg(feature = "managed-provider-qualification")]
fn is_observed(_metadata: &tracing::Metadata<'_>) -> bool {
    true
}

#[cfg(not(feature = "managed-provider-qualification"))]
fn is_observed(metadata: &tracing::Metadata<'_>) -> bool {
    is_captured(metadata)
}

impl<S> tracing_subscriber::Layer<S> for CaptureTraceLayer
where
    S: tracing::Subscriber,
{
    /// Never `never`: a callsite this subscriber does not keep answers
    /// `sometimes`, so the decision is made per event against whichever
    /// subscriber is current — a test's scoped subscriber still receives
    /// the events it is waiting for, whichever thread fired the callsite
    /// first — while this subscriber rejects them cheaply in `enabled`
    /// instead of every event in the process being built and dispatched.
    fn register_callsite(
        &self,
        metadata: &'static tracing::Metadata<'static>,
    ) -> tracing::subscriber::Interest {
        if is_observed(metadata) {
            tracing::subscriber::Interest::always()
        } else {
            tracing::subscriber::Interest::sometimes()
        }
    }

    fn enabled(
        &self,
        metadata: &tracing::Metadata<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) -> bool {
        is_observed(metadata)
    }

    /// The kept events are INFO and above, so while no scoped subscriber
    /// asks for more, `debug!`/`trace!` callsites stay off entirely.
    #[cfg(not(feature = "managed-provider-qualification"))]
    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::INFO)
    }

    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        #[cfg(feature = "managed-provider-qualification")]
        for observer in event_observers().lock().unwrap().iter() {
            observer(event);
        }

        let metadata = event.metadata();
        if !is_captured(metadata) {
            return;
        }
        let is_session_directory_error = metadata.target() == "freshell_server::session_directory";

        let mut visitor = TraceFieldVisitor::default();
        event.record(&mut visitor);
        if is_session_directory_error
            && !visitor
                .message
                .contains("session_directory_identity_collision")
        {
            return;
        }

        if metadata.target() == "freshell_server::auto_title_sweep"
            && visitor.message.split(':').next() != Some("session_names.first_message_lookup_failed")
        {
            return;
        }

        self.events.0.lock().unwrap().push(CapturedTraceEvent {
            level: *metadata.level(),
            message: visitor.message,
            fields: visitor.fields,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const PROBE_TARGET: &str = "freshell_server::test_trace_capture::scoped_probe";

    /// The callsite under test: one `warn!` that two threads fire.
    fn fire_probe() {
        tracing::warn!(target: PROBE_TARGET, "scoped capture probe");
    }

    struct CountProbe(Arc<AtomicUsize>);

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CountProbe {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _context: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if event.metadata().target() == PROBE_TARGET {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// A test's scoped subscriber receives a callsite's event even though
    /// another thread, outside any scoped subscriber, fired that callsite
    /// first while the scoped subscriber was registered. Without a
    /// process-wide subscriber in place, that first firing caches the
    /// callsite as uninterested for the whole process and the scoped
    /// subscriber never sees it (`review_r6_automatic_checkpoint_cooldown_is_logged`
    /// captured nothing this way).
    #[test]
    fn a_scoped_subscriber_sees_a_callsite_another_thread_fired_first() {
        use tracing_subscriber::prelude::*;

        let seen = Arc::new(AtomicUsize::new(0));
        let scoped =
            tracing::Dispatch::new(tracing_subscriber::registry().with(CountProbe(seen.clone())));
        std::thread::spawn(fire_probe)
            .join()
            .expect("the unscoped thread fires the callsite first");
        tracing::dispatcher::with_default(&scoped, fire_probe);
        assert_eq!(
            seen.load(Ordering::SeqCst),
            1,
            "the scoped subscriber receives the event fired under it"
        );
    }
}
