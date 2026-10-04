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

/// One process-wide collector is shared by tests that need to inspect tracing
/// events. Keeping the subscriber and buffer here prevents modules from racing
/// to install separate global subscribers with disconnected event buffers.
pub(crate) fn captured_trace_events() -> CapturedTraceEvents {
    use tracing_subscriber::prelude::*;

    static GLOBAL_EVENTS: OnceLock<CapturedTraceEvents> = OnceLock::new();
    GLOBAL_EVENTS
        .get_or_init(|| {
            let events = CapturedTraceEvents::default();
            let subscriber = tracing_subscriber::registry().with(CaptureTraceLayer {
                events: events.clone(),
            });
            tracing::subscriber::set_global_default(subscriber)
                .expect("test trace capture must install the sole test subscriber");
            events
        })
        .clone()
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
        self.fields.insert(field.name().to_string(), value.to_string());
    }
}

impl<S> tracing_subscriber::Layer<S> for CaptureTraceLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let metadata = event.metadata();
        let level = *metadata.level();
        let target = metadata.target();
        let is_extension_warning =
            target == "freshell_server::extensions" && level == tracing::Level::WARN;
        let is_session_directory_error =
            target == "freshell_server::session_directory" && level == tracing::Level::ERROR;
        if !is_extension_warning && !is_session_directory_error {
            return;
        }

        let mut visitor = TraceFieldVisitor::default();
        event.record(&mut visitor);
        if is_session_directory_error
            && !visitor
                .message
                .contains("session_directory_identity_collision")
        {
            return;
        }

        self.events.0.lock().unwrap().push(CapturedTraceEvent {
            level,
            message: visitor.message,
            fields: visitor.fields,
        });
    }
}
