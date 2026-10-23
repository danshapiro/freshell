//! A process-wide `tracing` capture for integration tests that assert on the
//! server's log events. Server work runs on tasks polled by any runtime
//! thread, so a thread-local subscriber would miss events; this installs one
//! global subscriber per test binary (the first [`install`] wins) that keeps
//! every event. A capture sees the events emitted after it was taken; tests
//! running in parallel share them, so a test finds its own events by an id it
//! owns (a session id, an ownership id).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

#[derive(Clone, Debug)]
pub struct CapturedEvent {
    pub level: Level,
    pub target: String,
    pub message: String,
    pub fields: BTreeMap<String, String>,
}

impl CapturedEvent {
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }
}

#[derive(Default)]
struct Visitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl Visit for Visitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = rendered;
        } else {
            self.fields.insert(field.name().to_string(), rendered);
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }
}

struct CaptureLayer(Arc<Mutex<Vec<CapturedEvent>>>);

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = Visitor::default();
        event.record(&mut visitor);
        self.0.lock().expect("capture lock").push(CapturedEvent {
            level: *event.metadata().level(),
            target: event.metadata().target().to_string(),
            message: visitor.message,
            fields: visitor.fields,
        });
    }
}

static EVENTS: OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> = OnceLock::new();

/// A capture of the events emitted from now on (installing the binary's
/// subscriber on first use).
pub fn install() -> LogCapture {
    let events = EVENTS
        .get_or_init(|| {
            let events = Arc::new(Mutex::new(Vec::new()));
            let subscriber = tracing_subscriber::registry().with(CaptureLayer(Arc::clone(&events)));
            tracing::subscriber::set_global_default(subscriber)
                .expect("a test binary using log_capture installs no other global subscriber");
            events
        })
        .clone();
    let start = events.lock().expect("capture lock").len();
    LogCapture { events, start }
}

#[derive(Clone)]
pub struct LogCapture {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
    /// Events before this index predate the capture.
    start: usize,
}

impl LogCapture {
    /// Every event since the capture matching `predicate`, in emission order.
    pub fn matching(&self, predicate: impl Fn(&CapturedEvent) -> bool) -> Vec<CapturedEvent> {
        self.events
            .lock()
            .expect("capture lock")
            .iter()
            .skip(self.start)
            .filter(|event| predicate(event))
            .cloned()
            .collect()
    }

    /// The first event matching `predicate`, waiting up to 60 s for it.
    pub async fn wait_for(
        &self,
        what: &str,
        predicate: impl Fn(&CapturedEvent) -> bool,
    ) -> CapturedEvent {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(hit) = self.matching(&predicate).into_iter().next() {
                return hit;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no log event: {what}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
