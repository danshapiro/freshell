//! Captures `freshell_unit` events (level, `event` field and every other
//! field as text) for assertions.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

/// One captured event: its level, its `event` name and every field as text.
#[derive(Clone, Debug)]
pub struct Event {
    pub level: tracing::Level,
    pub event: String,
    pub fields: BTreeMap<String, String>,
}

#[derive(Clone, Default)]
pub struct Captured(pub Arc<Mutex<Vec<Event>>>);

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
        let mut fields = Fields::default();
        e.record(&mut fields);
        if let Some(name) = fields.0.remove("event") {
            self.0.lock().unwrap().push(Event {
                level: *e.metadata().level(),
                event: name,
                fields: fields.0,
            });
        }
    }
}

pub fn install() -> (Captured, tracing::subscriber::DefaultGuard) {
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
        self.0.lock().unwrap().iter().any(|e| {
            e.level == level
                && e.event == event
                && fields
                    .iter()
                    .all(|(k, v)| e.fields.get(*k).map(String::as_str) == Some(*v))
        })
    }
}
