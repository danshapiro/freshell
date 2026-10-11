//! A lost listen port: the one start failure the tests retry.
//!
//! When the product starts the app-server, it chooses the port and releases
//! it before the fake starts (`allocate_loopback_port`), so another socket on
//! the host can bind it first. The fake then exits with its own status, 98
//! (`fake-app-server.mjs` `listen()`). The product's planner retries such a
//! start (`plan_create_with_retry`); a test that starts the app-server with a
//! single attempt retries it through these helpers. Every other start failure
//! fails the test at once. (A test that spawns the fake itself lets the fake
//! choose its port instead: `FAKE_CODEX_APP_SERVER_PORT_FILE`.)
#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use freshell_codex::launch_lifecycle::{
    CodexLaunchRuntime, CodexRuntimeReady, CodexTerminalLaunch, CodexTerminalLaunchManager,
    LaunchClass, SpawnedCodexAppServerRuntime,
};
use freshell_codex::launch_plan::CodexLaunchPlanInput;
use freshell_containment::{StopMode, StopReason, StopRequest};

/// What a start of the fake app-server returns when the fake lost its port.
pub const LOST_PORT: &str = "exited before listening: exit status: 98";

/// Attempts per start. A lost port is rare (a few starts in ten thousand on a
/// busy host), so three in a row means something else is wrong.
pub const LOST_PORT_ATTEMPTS: u32 = 3;

/// How long a lost attempt's unit gets to reach Gone and be swept.
const LOST_ATTEMPT_STOP_LIMIT: Duration = Duration::from_secs(10);

/// Whether `error` says the fake lost its listen port.
pub fn lost_its_port(error: &impl std::fmt::Display) -> bool {
    error.to_string().contains(LOST_PORT)
}

/// Runs `attempt` until it succeeds, again only after a lost port and at most
/// [`LOST_PORT_ATTEMPTS`] times; any other failure (or a port lost on the
/// last attempt) panics with `what`, as `expect(what)` would. A failed attempt
/// leaves nothing of itself running: [`ready_attempt`] stops its unit, and a
/// planner stops a failed plan's attempt and confirms it Gone before it answers.
pub async fn retrying_a_lost_port<T, E, Fut>(what: &str, mut attempt: impl FnMut() -> Fut) -> T
where
    E: std::fmt::Debug + std::fmt::Display,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut attempts = 0;
    loop {
        attempts += 1;
        match attempt().await {
            Ok(value) => return value,
            Err(error) if lost_its_port(&error) && attempts < LOST_PORT_ATTEMPTS => {
                eprintln!(
                    "{what}: the fake app-server lost its listen port on attempt {attempts} \
                     (another socket bound it first); retrying on a new port"
                );
            }
            Err(error) => panic!("{what}: {error:?}"),
        }
    }
}

/// A start attempt's runtime as a test holds it.
pub trait AttemptRuntime {
    fn runtime(&self) -> &dyn CodexLaunchRuntime;
}

impl AttemptRuntime for SpawnedCodexAppServerRuntime {
    fn runtime(&self) -> &dyn CodexLaunchRuntime {
        self
    }
}

impl AttemptRuntime for Arc<dyn CodexLaunchRuntime> {
    fn runtime(&self) -> &dyn CodexLaunchRuntime {
        self.as_ref()
    }
}

/// One start of `runtime`. When the fake lost its port, the attempt is gone
/// before the error returns: a seeded attempt's unit is stopped (straight
/// through the unit, so a test's recording lifecycle sees only the test's own
/// stops) and confirmed Gone with its leftover members swept; a seedless
/// start has already killed its exact child and swept its ownership tag.
pub async fn ready_attempt<R: AttemptRuntime>(
    runtime: R,
) -> Result<(R, CodexRuntimeReady), String> {
    match runtime.runtime().ensure_ready(None).await {
        Ok(ready) => Ok((runtime, ready)),
        Err(error) => {
            if lost_its_port(&error) {
                if let Some(unit) = runtime.runtime().unit() {
                    let stop = unit.stop(StopRequest::new(
                        StopMode::Force,
                        StopReason::StartCancelled,
                        "test-lost-port",
                    ));
                    tokio::time::timeout(LOST_ATTEMPT_STOP_LIMIT, async {
                        stop.wait().await;
                        stop.wait_swept().await
                    })
                    .await
                    .expect("the lost-port attempt's unit is Gone and swept");
                }
            }
            Err(error)
        }
    }
}

/// Builds a runtime with `build` and starts it; after a lost port, a new
/// runtime (a new port; a seeded one also a new unit) tries again.
pub async fn ready_retrying_a_lost_port<R: AttemptRuntime>(
    what: &str,
    mut build: impl FnMut() -> R,
) -> (R, CodexRuntimeReady) {
    retrying_a_lost_port(what, || ready_attempt(build())).await
}

/// One Interactive plan of a single attempt, planned again only after a
/// lost port (the failed plan has stopped its attempt and confirmed it Gone).
pub async fn plan_retrying_a_lost_port(
    what: &str,
    manager: &CodexTerminalLaunchManager,
    input: &CodexLaunchPlanInput<'_>,
) -> CodexTerminalLaunch {
    retrying_a_lost_port(what, || {
        manager.plan_create_with_retry_uncancellable(input, 1, LaunchClass::Interactive)
    })
    .await
}
