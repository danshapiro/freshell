//! Windows ownership of one Codex app-server and its descendants.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_platform::process_job::{KillOnCloseJob, StrictJobMembers};

/// The job and its observation begin before the suspended root is assigned.
/// Holding the job also makes a dropped server close and terminate the tree.
pub(crate) struct CodexWindowsGuard {
    job: KillOnCloseJob,
    members: Mutex<StrictJobMembers>,
    observation_failed: AtomicBool,
}

impl CodexWindowsGuard {
    pub(crate) fn new() -> std::io::Result<Arc<Self>> {
        let job = KillOnCloseJob::new()?;
        let members = StrictJobMembers::subscribe(&job)?;
        Ok(Arc::new(Self {
            job,
            members: Mutex::new(members),
            observation_failed: AtomicBool::new(false),
        }))
    }

    pub(crate) fn assign(self: &Arc<Self>, pid: u32) -> std::io::Result<()> {
        self.job.assign_process(pid)?;
        self.members
            .lock()
            .expect("codex job members lock")
            .record_member(&self.job, pid)?;
        let weak = Arc::downgrade(self);
        // The completion port wakes the observer on each process join. A
        // bounded timeout also refreshes the job list if a report is lost.
        std::thread::Builder::new()
            .name("codex-job-observer".into())
            .spawn(move || loop {
                let Some(guard) = weak.upgrade() else { break };
                guard.observe_wait(Duration::from_millis(250));
                if guard.observation_failed.load(Ordering::Acquire) {
                    break;
                }
                drop(guard);
                std::thread::yield_now();
            })?;
        Ok(())
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn contains_process_handle(&self, handle: usize) -> bool {
        self.job.contains_process_handle(handle).unwrap_or(false)
    }

    fn observe(&self) {
        self.observe_wait(Duration::ZERO);
    }

    fn observe_wait(&self, timeout: Duration) {
        if self.observation_failed.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = self
            .members
            .lock()
            .expect("codex job members lock")
            .record_wait(&self.job, timeout)
        {
            self.observation_failed.store(true, Ordering::Release);
            tracing::warn!(target: "freshell_freshagent::codex", %error,
                "freshagent.codex.windows_job_observation_incomplete");
        }
    }

    pub(crate) fn terminate(&self) -> std::io::Result<()> {
        self.job.terminate()
    }

    /// Terminate the job and wait for a complete, independently observed
    /// process set to signal. Any unavailable evidence remains unconfirmed.
    pub(crate) async fn terminate_and_confirm(self: &Arc<Self>) -> bool {
        let guard = Arc::clone(self);
        tokio::task::spawn_blocking(move || guard.terminate_and_confirm_blocking())
            .await
            .unwrap_or(false)
    }

    fn terminate_and_confirm_blocking(&self) -> bool {
        // Take one last live snapshot before terminating; after termination
        // a member can disappear from the job list before it is signaled.
        self.observe();
        let closed = self.job.close_admission();
        if let Err(error) = self.terminate() {
            tracing::warn!(target: "freshell_freshagent::codex", %error,
                "freshagent.codex.windows_job_terminate_failed");
            return false;
        }
        if let Err(error) = closed {
            tracing::warn!(target: "freshell_freshagent::codex", %error,
                "freshagent.codex.windows_job_admission_close_failed");
            return false;
        }
        if self.observation_failed.load(Ordering::Acquire) {
            return false;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            self.observe();
            if self.observation_failed.load(Ordering::Acquire) {
                return false;
            }
            let confirmed = self
                .members
                .lock()
                .expect("codex job members lock")
                .confirmed_exited(&self.job);
            match confirmed {
                Ok(true) => return true,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(target: "freshell_freshagent::codex", %error,
                        "freshagent.codex.windows_job_confirmation_failed");
                    return false;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
