#![cfg(unix)]

mod support;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::time::Duration;

use freshell_deploy::{
    DeployError, DeployPort, ListenerIdentity, PidfdBackend, ProcessIdentity, Signal, StopPolicy,
    VerifiedProcess,
};

use support::{process_identity, PRIOR_ID};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FakePidfd(u64);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Event {
    Open(u32, u64),
    Snapshot(u64),
    Listener,
    Signal(u64, Signal),
    Wait(u64),
}

struct FakePidfdBackend {
    next_pin: u64,
    current: ProcessIdentity,
    listener: RefCell<ListenerIdentity>,
    listener_observations: RefCell<VecDeque<ListenerIdentity>>,
    listener_failures: RefCell<VecDeque<bool>>,
    snapshots: RefCell<VecDeque<ProcessIdentity>>,
    snapshot_failures: RefCell<VecDeque<bool>>,
    waits: RefCell<VecDeque<bool>>,
    wait_failures: RefCell<VecDeque<bool>>,
    events: RefCell<Vec<Event>>,
    open_error: bool,
    term_signal_error: bool,
    kill_signal_error: bool,
}

impl FakePidfdBackend {
    fn exact(expected: ProcessIdentity) -> Self {
        Self {
            next_pin: 7,
            listener: RefCell::new(expected.listener.clone()),
            current: expected,
            listener_observations: RefCell::new(VecDeque::new()),
            listener_failures: RefCell::new(VecDeque::new()),
            snapshots: RefCell::new(VecDeque::new()),
            snapshot_failures: RefCell::new(VecDeque::new()),
            waits: RefCell::new(VecDeque::new()),
            wait_failures: RefCell::new(VecDeque::new()),
            events: RefCell::new(Vec::new()),
            open_error: false,
            term_signal_error: false,
            kill_signal_error: false,
        }
    }

    fn opens(&self) -> Vec<(u32, u64)> {
        self.events
            .borrow()
            .iter()
            .filter_map(|event| match event {
                Event::Open(pid, pin) => Some((*pid, *pin)),
                _ => None,
            })
            .collect()
    }

    fn signals(&self) -> Vec<(u64, Signal)> {
        self.events
            .borrow()
            .iter()
            .filter_map(|event| match event {
                Event::Signal(pin, signal) => Some((*pin, *signal)),
                _ => None,
            })
            .collect()
    }
}

impl PidfdBackend for FakePidfdBackend {
    type Pidfd = FakePidfd;

    fn resolve_listener(&self, _port: DeployPort) -> freshell_deploy::Result<ListenerIdentity> {
        self.events.borrow_mut().push(Event::Listener);
        if self
            .listener_failures
            .borrow_mut()
            .pop_front()
            .unwrap_or(false)
        {
            return Err(DeployError::ProcessControl(
                "injected listener resolution failure".to_string(),
            ));
        }
        Ok(self
            .listener_observations
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| self.listener.borrow().clone()))
    }

    fn open_pidfd(&self, pid: u32) -> freshell_deploy::Result<Self::Pidfd> {
        self.events
            .borrow_mut()
            .push(Event::Open(pid, self.next_pin));
        if self.open_error {
            return Err(DeployError::ProcessControl(
                "injected pidfd open failure".to_string(),
            ));
        }
        Ok(FakePidfd(self.next_pin))
    }

    fn snapshot(
        &self,
        pidfd: &Self::Pidfd,
        _listener: &ListenerIdentity,
    ) -> freshell_deploy::Result<ProcessIdentity> {
        self.events.borrow_mut().push(Event::Snapshot(pidfd.0));
        if self
            .snapshot_failures
            .borrow_mut()
            .pop_front()
            .unwrap_or(false)
        {
            return Err(DeployError::ProcessControl(
                "injected pidfd snapshot failure".to_string(),
            ));
        }
        Ok(self
            .snapshots
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| self.current.clone()))
    }

    fn signal_pidfd(&self, pidfd: &Self::Pidfd, signal: Signal) -> freshell_deploy::Result<()> {
        self.events
            .borrow_mut()
            .push(Event::Signal(pidfd.0, signal));
        let fail = match signal {
            Signal::Term => self.term_signal_error,
            Signal::Kill => self.kill_signal_error,
        };
        if fail {
            return Err(DeployError::ProcessControl(
                "injected pidfd signal failure".to_string(),
            ));
        }
        Ok(())
    }

    fn wait_exited(
        &self,
        pidfd: &Self::Pidfd,
        _timeout: Duration,
    ) -> freshell_deploy::Result<bool> {
        self.events.borrow_mut().push(Event::Wait(pidfd.0));
        if self.wait_failures.borrow_mut().pop_front().unwrap_or(false) {
            return Err(DeployError::ProcessControl(
                "injected pidfd wait failure".to_string(),
            ));
        }
        Ok(self.waits.borrow_mut().pop_front().unwrap_or(true))
    }
}

fn assert_only_retained_pidfd(
    backend: &FakePidfdBackend,
    expected_pid: u32,
    expected_signals: &[(u64, Signal)],
) {
    assert_eq!(
        backend.opens(),
        vec![(expected_pid, 7)],
        "process control must open exactly one pidfd for the receipt PID"
    );
    assert_eq!(
        backend.signals(),
        expected_signals,
        "every signal must use the retained pidfd; there is no numeric-PID fallback"
    );
}

#[test]
fn exact_receipt_signals_only_the_retained_pidfd() {
    let expected = process_identity(PRIOR_ID, 4101, 3411);
    let backend = FakePidfdBackend::exact(expected.clone());
    let verified = VerifiedProcess::bind(&backend, &expected).expect("exact process proof");

    verified
        .terminate(StopPolicy::new(
            Duration::from_millis(5),
            Duration::from_millis(5),
        ))
        .expect("bounded termination");

    assert_eq!(backend.signals(), vec![(7, Signal::Term)]);
}

#[test]
fn identity_ambiguities_fail_before_any_signal() {
    let expected = process_identity(PRIOR_ID, 4102, 3412);
    for mutate in [
        "start_time",
        "boot",
        "listener",
        "executable",
        "cwd",
        "runtime",
    ] {
        let mut actual = expected.clone();
        match mutate {
            "start_time" => actual.start_time_ticks = "999999".to_string(),
            "boot" => actual.kernel_boot_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_string(),
            "listener" => actual.listener.socket_inode = "555555".to_string(),
            "executable" => actual.executable.sha256 = "f".repeat(64),
            "cwd" => actual.cwd = "/foreign/cwd".to_string(),
            "runtime" => actual.runtime.client_dir = "/foreign/client".to_string(),
            _ => unreachable!(),
        }
        let backend = FakePidfdBackend::exact(actual.clone());
        *backend.listener.borrow_mut() = actual.listener.clone();

        let result = VerifiedProcess::bind(&backend, &expected);

        assert!(result.is_err(), "{mutate} ambiguity must fail closed");
        assert!(
            backend.signals().is_empty(),
            "{mutate} ambiguity must not signal"
        );
    }
}

#[test]
fn backend_errors_while_binding_fail_before_any_signal() {
    let expected = process_identity(PRIOR_ID, 4107, 3417);

    let resolve_backend = FakePidfdBackend::exact(expected.clone());
    resolve_backend
        .listener_failures
        .borrow_mut()
        .push_back(true);
    assert!(VerifiedProcess::bind(&resolve_backend, &expected).is_err());
    assert!(resolve_backend.opens().is_empty());
    assert!(resolve_backend.signals().is_empty());

    let mut open_backend = FakePidfdBackend::exact(expected.clone());
    open_backend.open_error = true;
    assert!(VerifiedProcess::bind(&open_backend, &expected).is_err());
    assert_eq!(open_backend.opens(), vec![(expected.pid, 7)]);
    assert!(open_backend.signals().is_empty());

    let snapshot_backend = FakePidfdBackend::exact(expected.clone());
    snapshot_backend
        .snapshot_failures
        .borrow_mut()
        .push_back(true);
    assert!(VerifiedProcess::bind(&snapshot_backend, &expected).is_err());
    assert_only_retained_pidfd(&snapshot_backend, expected.pid, &[]);

    let post_pin_resolve_backend = FakePidfdBackend::exact(expected.clone());
    post_pin_resolve_backend
        .listener_failures
        .borrow_mut()
        .extend([false, true]);
    assert!(VerifiedProcess::bind(&post_pin_resolve_backend, &expected).is_err());
    assert_only_retained_pidfd(&post_pin_resolve_backend, expected.pid, &[]);
}

#[test]
fn listener_transfer_after_pin_is_rejected_before_term() {
    let expected = process_identity(PRIOR_ID, 4103, 3413);
    let backend = FakePidfdBackend::exact(expected.clone());
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();
    backend.listener.borrow_mut().owner_pid = 9999;
    backend.listener.borrow_mut().socket_inode = "888888".to_string();

    let result = verified.terminate(StopPolicy::default());

    assert!(result.is_err());
    assert!(backend.signals().is_empty());
}

#[test]
fn wait_error_after_term_never_escalates_or_reopens_by_pid() {
    let expected = process_identity(PRIOR_ID, 4108, 3418);
    let backend = FakePidfdBackend::exact(expected.clone());
    backend.wait_failures.borrow_mut().push_back(true);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    let error = verified.terminate(StopPolicy::default()).unwrap_err();

    assert!(error.to_string().contains("wait"));
    assert_only_retained_pidfd(&backend, expected.pid, &[(7, Signal::Term)]);
}

#[test]
fn identity_drift_after_term_timeout_prevents_kill() {
    let expected = process_identity(PRIOR_ID, 4109, 3419);
    let backend = FakePidfdBackend::exact(expected.clone());
    let mut drifted = expected.clone();
    drifted.start_time_ticks = "999999".to_string();
    backend
        .snapshots
        .borrow_mut()
        .extend([expected.clone(), expected.clone(), drifted]);
    backend.waits.borrow_mut().push_back(false);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    let result = verified.terminate(StopPolicy::default());

    assert!(result.is_err());
    assert_only_retained_pidfd(&backend, expected.pid, &[(7, Signal::Term)]);
}

#[test]
fn listener_disappearance_after_term_timeout_still_kills_retained_process() {
    let expected = process_identity(PRIOR_ID, 4110, 3420);
    let backend = FakePidfdBackend::exact(expected.clone());
    backend
        .listener_failures
        .borrow_mut()
        .extend([false, false, false, true]);
    backend.waits.borrow_mut().extend([false, true]);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    verified.terminate(StopPolicy::default()).unwrap();

    assert_only_retained_pidfd(
        &backend,
        expected.pid,
        &[(7, Signal::Term), (7, Signal::Kill)],
    );
}

#[test]
fn term_timeout_revalidates_and_kills_through_the_same_pidfd() {
    let expected = process_identity(PRIOR_ID, 4104, 3414);
    let backend = FakePidfdBackend::exact(expected.clone());
    backend.waits.borrow_mut().extend([false, true]);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    verified.terminate(StopPolicy::default()).unwrap();

    assert_eq!(
        backend.signals(),
        vec![(7, Signal::Term), (7, Signal::Kill)]
    );
    let events = backend.events.borrow();
    let kill = events
        .iter()
        .position(|event| *event == Event::Signal(7, Signal::Kill))
        .unwrap();
    assert!(
        events[..kill]
            .iter()
            .rev()
            .take(3)
            .any(|event| *event == Event::Snapshot(7)),
        "the exact process must be revalidated immediately before SIGKILL"
    );
}

#[test]
fn exit_after_term_never_sends_kill() {
    let expected = process_identity(PRIOR_ID, 4105, 3415);
    let backend = FakePidfdBackend::exact(expected.clone());
    backend.waits.borrow_mut().push_back(true);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    verified.terminate(StopPolicy::default()).unwrap();

    assert_eq!(backend.signals(), vec![(7, Signal::Term)]);
}

#[test]
fn pidfd_signal_failure_has_no_pid_based_fallback() {
    let expected = process_identity(PRIOR_ID, 4106, 3416);
    let mut backend = FakePidfdBackend::exact(expected.clone());
    backend.term_signal_error = true;
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    let error = verified.terminate(StopPolicy::default()).unwrap_err();

    assert!(error.to_string().contains("pidfd"));
    assert_only_retained_pidfd(&backend, expected.pid, &[(7, Signal::Term)]);
}

#[test]
fn pidfd_kill_signal_failure_has_no_pid_based_fallback() {
    let expected = process_identity(PRIOR_ID, 4111, 3421);
    let mut backend = FakePidfdBackend::exact(expected.clone());
    backend.kill_signal_error = true;
    backend.waits.borrow_mut().push_back(false);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    let error = verified.terminate(StopPolicy::default()).unwrap_err();

    assert!(error.to_string().contains("pidfd"));
    assert_only_retained_pidfd(
        &backend,
        expected.pid,
        &[(7, Signal::Term), (7, Signal::Kill)],
    );
}

#[test]
fn wait_error_after_kill_fails_closed_on_the_retained_pidfd() {
    let expected = process_identity(PRIOR_ID, 4112, 3422);
    let backend = FakePidfdBackend::exact(expected.clone());
    backend.waits.borrow_mut().push_back(false);
    backend.wait_failures.borrow_mut().extend([false, true]);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    let error = verified.terminate(StopPolicy::default()).unwrap_err();

    assert!(error.to_string().contains("wait"));
    assert_only_retained_pidfd(
        &backend,
        expected.pid,
        &[(7, Signal::Term), (7, Signal::Kill)],
    );
}

#[test]
fn kill_timeout_fails_closed_on_the_retained_pidfd() {
    let expected = process_identity(PRIOR_ID, 4113, 3423);
    let backend = FakePidfdBackend::exact(expected.clone());
    backend.waits.borrow_mut().extend([false, false]);
    let verified = VerifiedProcess::bind(&backend, &expected).unwrap();

    let error = verified.terminate(StopPolicy::default()).unwrap_err();

    assert!(error.to_string().contains("remained alive"));
    assert_only_retained_pidfd(
        &backend,
        expected.pid,
        &[(7, Signal::Term), (7, Signal::Kill)],
    );
}
