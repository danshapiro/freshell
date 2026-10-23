//! Test-only: the ONE owner of the process environment in the
//! `--bin freshell-server` test binary.
//!
//! Cargo runs a binary's tests as parallel threads of one process, and the
//! environment is process-global. Production code resolves provider homes
//! and feature switches from it (`HOME`/`USERPROFILE`, `CLAUDE_HOME`,
//! `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `KILROY_ENABLED`, the
//! `FRESHELL_*` knobs, ...), and some of those resolvers let a process-global
//! value WIN over a test's explicit home — production override parity. So a
//! test that points `HOME` or `CLAUDE_CONFIG_DIR` at its own temp home
//! changes what every concurrently running test resolves, and two tests
//! mutating overlapping variables under DIFFERENT locks (the old
//! `HOME_ENV_TEST_LOCK` / `CLAUDE_ENV_TEST_LOCK` / per-module locks) still
//! interleave. Observed: `claude_unreadable_projects_root_defers` flipping to
//! "definitively absent" under a concurrent discovery test's `CLAUDE_HOME`,
//! and the managed-runtime snapshot-outage test (`HOME`, `CODEX_HOME`,
//! `CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME` under a module-local lock) colliding
//! with the `HOME` and `CLAUDE_*` mutators.
//!
//! The discipline:
//!
//! * every test that changes the environment does so ONLY through a
//!   [`TestEnv`], which holds the single crate-wide lock for its whole life
//!   and restores every variable it touched when dropped — also while a
//!   failing assertion unwinds;
//! * every test whose production path READS a variable another test may
//!   change (and that cannot pin its inputs explicitly) holds a [`TestEnv`]
//!   too, without changing anything;
//! * async tests acquire with [`TestEnv::lock`], plain `#[test]` fns with
//!   [`TestEnv::lock_blocking`] (never from inside a runtime — it panics);
//! * a test takes ONE `TestEnv` and passes it down; helpers never lock again
//!   (the lock is not re-entrant).
//!
//! Tests that need a different environment for long-lived child state run
//! the scenario in a child process instead (for example the managed-runtime
//! re-plan tests), which isolates it without any lock.

use std::ffi::{OsStr, OsString};

/// The crate-wide process-environment lock. A `tokio::sync::Mutex` so async
/// tests can hold it across `.await` points and sync tests can take it with
/// `blocking_lock`; it has no poisoning, so a failed test never wedges the
/// others (its [`TestEnv`] restores the variables while unwinding).
static PROCESS_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Exclusive use of the process environment for one test. Every variable
/// changed through it is restored to its value from before the first change
/// when the guard drops (in reverse order), and only then is the lock
/// released.
#[must_use = "the environment is only owned while the TestEnv is alive"]
pub(crate) struct TestEnv {
    saved: Vec<(OsString, Option<OsString>)>,
    _lock: tokio::sync::MutexGuard<'static, ()>,
}

impl TestEnv {
    /// Take the environment from an async test.
    pub(crate) async fn lock() -> Self {
        Self::holding(PROCESS_ENV_LOCK.lock().await)
    }

    /// Take the environment from a plain `#[test]` fn (never from inside a
    /// tokio runtime).
    pub(crate) fn lock_blocking() -> Self {
        Self::holding(PROCESS_ENV_LOCK.blocking_lock())
    }

    fn holding(lock: tokio::sync::MutexGuard<'static, ()>) -> Self {
        Self {
            saved: Vec::new(),
            _lock: lock,
        }
    }

    /// Set `key` for the rest of this test.
    pub(crate) fn set(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
        let key = key.as_ref();
        self.remember(key);
        std::env::set_var(key, value);
    }

    /// Unset `key` for the rest of this test.
    pub(crate) fn remove(&mut self, key: impl AsRef<OsStr>) {
        let key = key.as_ref();
        self.remember(key);
        std::env::remove_var(key);
    }

    fn remember(&mut self, key: &OsStr) {
        if !self.saved.iter().any(|(saved, _)| saved == key) {
            self.saved.push((key.to_os_string(), std::env::var_os(key)));
        }
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..).rev() {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TestEnv;

    // One variable per test: the tests run concurrently, and each spans
    // several guard lifetimes.
    const RESTORE_PROBE: &str = "FRESHELL_TEST_ENV_RESTORE_PROBE";
    const UNWIND_PROBE: &str = "FRESHELL_TEST_ENV_UNWIND_PROBE";

    #[test]
    fn a_test_env_restores_the_value_from_before_its_first_change() {
        // An ambient value the next guard finds already present (set
        // directly, so no guard owns restoring it).
        let ambient = TestEnv::lock_blocking();
        std::env::set_var(RESTORE_PROBE, "ambient");
        drop(ambient);

        let mut env = TestEnv::lock_blocking();
        env.set(RESTORE_PROBE, "first");
        env.set(RESTORE_PROBE, "second");
        env.remove(RESTORE_PROBE);
        assert_eq!(std::env::var_os(RESTORE_PROBE), None);
        drop(env);

        let check = TestEnv::lock_blocking();
        let restored = std::env::var(RESTORE_PROBE);
        std::env::remove_var(RESTORE_PROBE);
        drop(check);
        assert_eq!(
            restored.as_deref(),
            Ok("ambient"),
            "every change is undone back to the value from before the first one"
        );
    }

    #[test]
    fn a_failing_test_still_restores_its_environment() {
        let before = {
            let _env = TestEnv::lock_blocking();
            std::env::var_os(UNWIND_PROBE)
        };
        let result = std::panic::catch_unwind(|| {
            let mut env = TestEnv::lock_blocking();
            env.set(UNWIND_PROBE, "set by a test that then fails");
            panic!("the test fails while it owns the environment");
        });
        assert!(result.is_err());
        let _env = TestEnv::lock_blocking();
        assert_eq!(
            std::env::var_os(UNWIND_PROBE),
            before,
            "the unwinding guard restored the variable"
        );
    }
}
