//! Captures `freshell_unit` events (level + `event` field) for assertions.
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

#[derive(Clone, Default)]
pub struct Captured(pub Arc<Mutex<Vec<(tracing::Level, String)>>>);

struct EventName(Option<String>);
impl Visit for EventName {
    fn record_str(&mut self, f: &Field, v: &str) {
        if f.name() == "event" {
            self.0 = Some(v.to_string());
        }
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        if f.name() == "event" {
            self.0 = Some(format!("{v:?}").trim_matches('"').to_string());
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for Captured {
    fn on_event(&self, e: &tracing::Event<'_>, _: Context<'_, S>) {
        let mut name = EventName(None);
        e.record(&mut name);
        if let Some(n) = name.0 {
            self.0.lock().unwrap().push((*e.metadata().level(), n));
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
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|(l, n)| *l == level && n == event)
    }
}
