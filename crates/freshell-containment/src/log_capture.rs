//! Test-only `tracing` subscriber that records every event's level, target
//! and fields with their recorded types, so tests can assert the log
//! contract (numbers recorded as numbers, absent values rendered as empty
//! strings) without a formatter.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};

#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    /// A string, or a value rendered through `Display` (`%value`) or `Debug`
    /// (`?value`) — exactly the text a JSONL formatter writes.
    Text(String),
    U64(u64),
    I64(i64),
    Bool(bool),
}

#[derive(Debug, Clone)]
pub struct CapturedEvent {
    pub level: Level,
    pub target: String,
    pub fields: BTreeMap<String, FieldValue>,
}

impl CapturedEvent {
    /// A text field, exactly as a formatter would render it.
    pub fn str(&self, key: &str) -> &str {
        match self.fields.get(key) {
            Some(FieldValue::Text(s)) => s,
            other => panic!("field {key} is not a string: {other:?} in {self:?}"),
        }
    }

    pub fn u64(&self, key: &str) -> u64 {
        match self.fields.get(key) {
            Some(FieldValue::U64(v)) => *v,
            other => panic!("field {key} is not a u64: {other:?} in {self:?}"),
        }
    }
}

#[derive(Default)]
struct Visitor(BTreeMap<String, FieldValue>);

impl Visit for Visitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), FieldValue::Text(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0
            .insert(field.name().into(), FieldValue::Text(value.into()));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), FieldValue::U64(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), FieldValue::I64(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), FieldValue::Bool(value));
    }
}

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<CapturedEvent>>>);

impl Subscriber for Capture {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut visitor = Visitor::default();
        event.record(&mut visitor);
        // The message is prose, not part of the key contract.
        visitor.0.remove("message");
        self.0.lock().unwrap().push(CapturedEvent {
            level: *event.metadata().level(),
            target: event.metadata().target().to_string(),
            fields: visitor.0,
        });
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

/// Every event `f` emits on this thread.
pub fn capture(f: impl FnOnce()) -> Vec<CapturedEvent> {
    ask_every_dispatcher();
    let capture = Capture::default();
    tracing::subscriber::with_default(capture.clone(), f);
    let events = capture.0.lock().unwrap().clone();
    events
}

/// tracing-core caches each callsite's interest at the callsite's first use,
/// and while at most one dispatcher is registered it asks only the CURRENT
/// thread's default. A callsite first used on another test's thread (which
/// has no subscriber) is then cached as "never", and a capture running at the
/// same time misses that event for good. A second dispatcher that lives for
/// the whole process makes tracing ask every live dispatcher instead.
fn ask_every_dispatcher() {
    static SECOND: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
    SECOND.get_or_init(|| tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default()));
}
