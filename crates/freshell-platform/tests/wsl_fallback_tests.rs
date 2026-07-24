//! The win32-only `wsl.exe`/`reg.exe` path fallback (`convertWslPathToWindows`,
//! `path-utils.ts:176-206`, `platform-glue.md §1.5`), exercised through the injected
//! [`WslPathResolver`] trait — testable **without invoking `wsl.exe`** (and on Linux,
//! since the `process.platform==='win32'` gate is injected via `HostOs`).

use std::cell::RefCell;

use freshell_platform::path::{convert_wsl_path_to_windows, WslPathCache, WslPathResolver};
use freshell_platform::{HostOs, MapEnv};

/// Records how many times each fallback probe fires, and lets a test dictate
/// the `reg.exe` result and the `wsl.exe wslpath -w` output.
struct MockResolver {
    has_distros: bool,
    wslpath_out: Option<String>,
    reg_calls: RefCell<usize>,
    wslpath_calls: RefCell<usize>,
}

impl MockResolver {
    fn new(has_distros: bool, wslpath_out: Option<&str>) -> Self {
        Self {
            has_distros,
            wslpath_out: wslpath_out.map(str::to_string),
            reg_calls: RefCell::new(0),
            wslpath_calls: RefCell::new(0),
        }
    }
}

impl WslPathResolver for MockResolver {
    fn has_wsl_distributions(&self) -> bool {
        *self.reg_calls.borrow_mut() += 1;
        self.has_distros
    }
    fn wslpath_to_windows(&self, _posix_path: &str) -> Option<String> {
        *self.wslpath_calls.borrow_mut() += 1;
        self.wslpath_out.clone()
    }
}

#[test]
fn returns_none_off_win32_and_for_non_posix_input() {
    let env = MapEnv::new();
    let resolver = MockResolver::new(true, Some("C:\\whatever"));
    let mut cache = WslPathCache::new();

    // process.platform !== 'win32' -> None, and the resolver is never consulted.
    assert_eq!(
        convert_wsl_path_to_windows("/mnt/z/x", HostOs::Linux, &env, &resolver, &mut cache),
        None
    );
    // Non-absolute input -> None on win32 too.
    assert_eq!(
        convert_wsl_path_to_windows("relative", HostOs::Windows, &env, &resolver, &mut cache),
        None
    );
    assert_eq!(*resolver.reg_calls.borrow(), 0);
    assert_eq!(*resolver.wslpath_calls.borrow(), 0);
}

#[test]
fn mount_mapped_short_circuits_before_touching_wsl_exe() {
    let env = MapEnv::new();
    let resolver = MockResolver::new(true, Some("SHOULD-NOT-BE-USED"));
    let mut cache = WslPathCache::new();

    // `/mnt/c/proj` is mount-mappable synchronously -> `C:\proj`, no reg/wsl probe.
    assert_eq!(
        convert_wsl_path_to_windows("/mnt/c/proj", HostOs::Windows, &env, &resolver, &mut cache)
            .as_deref(),
        Some("C:\\proj")
    );
    assert_eq!(*resolver.reg_calls.borrow(), 0);
    assert_eq!(*resolver.wslpath_calls.borrow(), 0);
}

#[test]
fn reg_guard_blocks_wsl_exe_when_no_distributions() {
    let env = MapEnv::new();
    let resolver = MockResolver::new(false, Some("C:\\should-not-run"));
    let mut cache = WslPathCache::new();

    // Non-mount path + no WSL distros -> None (Store-dialog avoidance), wsl.exe never called.
    assert_eq!(
        convert_wsl_path_to_windows("/home/dan", HostOs::Windows, &env, &resolver, &mut cache),
        None
    );
    assert_eq!(*resolver.reg_calls.borrow(), 1); // reg probe fired
    assert_eq!(*resolver.wslpath_calls.borrow(), 0); // but wsl.exe was guarded off
}

#[test]
fn falls_through_to_wslpath_and_caches_the_result() {
    let env = MapEnv::new();
    let resolver = MockResolver::new(true, Some("\\\\wsl.localhost\\Ubuntu\\home\\dan"));
    let mut cache = WslPathCache::new();

    let first =
        convert_wsl_path_to_windows("/home/dan", HostOs::Windows, &env, &resolver, &mut cache);
    assert_eq!(
        first.as_deref(),
        Some("\\\\wsl.localhost\\Ubuntu\\home\\dan")
    );
    assert_eq!(*resolver.wslpath_calls.borrow(), 1);
    assert_eq!(cache.len(), 1);

    // Second call for the same path is served from cache (wsl.exe not called again).
    let second =
        convert_wsl_path_to_windows("/home/dan", HostOs::Windows, &env, &resolver, &mut cache);
    assert_eq!(
        second.as_deref(),
        Some("\\\\wsl.localhost\\Ubuntu\\home\\dan")
    );
    assert_eq!(*resolver.wslpath_calls.borrow(), 1); // still 1 -> cache hit
}

#[test]
fn caches_negative_results_too() {
    let env = MapEnv::new();
    let resolver = MockResolver::new(true, None); // wsl.exe fails/empty -> None
    let mut cache = WslPathCache::new();

    assert_eq!(
        convert_wsl_path_to_windows("/home/dan", HostOs::Windows, &env, &resolver, &mut cache),
        None
    );
    assert_eq!(*resolver.wslpath_calls.borrow(), 1);
    // The None result is memoized (mirrors the reference caching the pending promise).
    assert_eq!(
        convert_wsl_path_to_windows("/home/dan", HostOs::Windows, &env, &resolver, &mut cache),
        None
    );
    assert_eq!(*resolver.wslpath_calls.borrow(), 1);
    assert_eq!(cache.len(), 1);
}
