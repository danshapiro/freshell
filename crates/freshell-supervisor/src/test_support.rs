/// Holds the paused test clock still while real socket/SQLite I/O runs: Tokio
/// never auto-advances a paused clock while a blocking task is running.
/// A budget expires only when the test advances the clock at the exact stall
/// it exercises, however loaded the machine is. The 60-second wall watchdog
/// matters only if the code under test wedges: the hold ends, the clock
/// auto-advances, and the test's own timeout fails instead of hanging.
pub(crate) struct FrozenClock {
    _release_on_drop: std::sync::mpsc::Sender<()>,
}

impl FrozenClock {
    pub(crate) fn hold() -> Self {
        let (release, held) = std::sync::mpsc::channel::<()>();
        drop(tokio::task::spawn_blocking(move || {
            let _ = held.recv_timeout(std::time::Duration::from_secs(60));
        }));
        Self {
            _release_on_drop: release,
        }
    }
}
