//! WSL <-> Windows path conversion + user-path flavor detection + launch-cwd.
//!
//! Identical port of `server/path-utils.ts` (WSL<->Windows conversion) and
//! `server/launch-cwd.ts` (`resolveLaunchCwd`), documented in `platform-glue.md §1`.
//!
//! **CD-2:** the mount-prefix + conversion rules are ported from `path-utils.ts`
//! (the live copy), **not** the dead `platform-utils.ts` whose `getWslMountPrefix`
//! uses a looser regex (`^(.*)/[a-zA-Z]/`).
//!
//! ### `path.win32.resolve` and the deterministic-core boundary
//!
//! The reference calls Node's `path.win32.resolve` in a few places. That builtin
//! is deterministic **only for absolute inputs**; for a relative / drive-relative
//! input it prepends `process.cwd()` (which, on a POSIX host, is itself a Linux
//! path — an odd, host-dependent value). [`win32_resolve`] therefore returns
//! `Some(normalized)` for absolute Windows inputs (drive-absolute `X:\`/`X:/` and
//! full UNC) and `None` for cwd-dependent inputs. Every real call site in the
//! ported code feeds `win32_resolve` an **absolute** path (the relative branches
//! are filtered out earlier by the POSIX guard / flavor checks), so this boundary
//! is behavior-equivalent for the deterministic core. cwd-relative Windows inputs
//! are out of scope for this pure step (they require a live cwd).

use crate::Env;

// ===========================================================================
// §1.1 Flavor detection & sanitization
// ===========================================================================

/// `UserPathFlavor` (`path-utils.ts:20`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserPathFlavor {
    Windows,
    Posix,
    Native,
}

/// `sanitizeUserPathInput` (`path-utils.ts:24-30`): trim, then strip a single
/// pair of wrapping quotes (`WRAPPED_QUOTES_RE = /^(["'])(.*)\1$/`) and re-trim.
pub fn sanitize_user_path_input(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(inner) = strip_wrapping_quotes(trimmed) {
        return inner.trim().to_string();
    }
    trimmed.to_string()
}

/// `WRAPPED_QUOTES_RE = /^(["'])(.*)\1$/`. `(.*)` (no `s` flag) does not span a
/// line terminator, so a wrapped value containing one does not match.
fn strip_wrapping_quotes(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    if b.len() < 2 {
        return None;
    }
    let first = b[0];
    let last = b[b.len() - 1];
    if (first == b'"' || first == b'\'') && first == last {
        let inner = &s[1..s.len() - 1];
        if !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            return Some(inner);
        }
    }
    None
}

/// `detectUserPathFlavor` (`path-utils.ts:32-46`).
pub fn detect_user_path_flavor(input: &str) -> UserPathFlavor {
    let cleaned = sanitize_user_path_input(input);
    if cleaned.is_empty() {
        return UserPathFlavor::Native;
    }
    if starts_windows_drive_or_end(&cleaned)
        || starts_windows_unc(&cleaned)
        || starts_windows_rooted(&cleaned)
    {
        return UserPathFlavor::Windows;
    }
    if starts_posix_absolute(&cleaned) {
        return UserPathFlavor::Posix;
    }
    UserPathFlavor::Native
}

/// `isLinuxPath` (`terminal-registry.ts:991-994`): `startsWith('/') && !startsWith('//')`.
pub fn is_linux_path(p: &str) -> bool {
    p.starts_with('/') && !p.starts_with("//")
}

// ---- Prefix predicates (hand-coded regexes; all-ASCII, byte-scanned) -------

/// `WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:([\\/]|$)/` (path-utils flavor).
fn starts_windows_drive_or_end(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'\\' || b[2] == b'/')
}

/// `/^[A-Za-z]:[\\/]/` (launch-cwd `WINDOWS_DRIVE_PREFIX_RE` — requires a separator).
fn starts_windows_drive_with_sep(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `/^[A-Za-z]:(?![\\/])/` (launch-cwd `WINDOWS_DRIVE_RELATIVE_RE`).
fn starts_windows_drive_relative(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || (b[2] != b'\\' && b[2] != b'/'))
}

/// `WINDOWS_UNC_PREFIX_RE = /^\\\\[^\\]+\\[^\\]+/`.
fn starts_windows_unc(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 4 || b[0] != b'\\' || b[1] != b'\\' {
        return false;
    }
    let mut i = 2;
    let seg1 = i;
    while i < b.len() && b[i] != b'\\' {
        i += 1;
    }
    if i == seg1 || i >= b.len() {
        return false; // need >=1 char then a '\'
    }
    i += 1; // the '\'
    let seg2 = i;
    while i < b.len() && b[i] != b'\\' {
        i += 1;
    }
    i > seg2 // need >=1 char in the second segment
}

/// `WINDOWS_ROOTED_PREFIX_RE = /^\\(?!\\)/`.
fn starts_windows_rooted(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b[0] == b'\\' && (b.len() == 1 || b[1] != b'\\')
}

/// `POSIX_ABSOLUTE_PREFIX_RE = /^\//`.
fn starts_posix_absolute(s: &str) -> bool {
    s.starts_with('/')
}

/// `SLASH_FORM_WSL_UNC_PREFIX_RE = /^\/\/(?:wsl(?:\.localhost)?|wsl\$)\/[^/]+(?:\/|$)/i`.
fn starts_slash_form_wsl_unc(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b[0] != b'/' || b[1] != b'/' {
        return false;
    }
    let mut i = 2;
    if b.len() < i + 3 || !b[i..i + 3].eq_ignore_ascii_case(b"wsl") {
        return false;
    }
    i += 3;
    // (?:\.localhost)? | wsl$ already consumed `wsl`; handle the `$` and `.localhost` variants.
    if b.len() > i && b[i] == b'$' {
        i += 1; // `wsl$`
    } else if b.len() >= i + 10 && b[i..i + 10].eq_ignore_ascii_case(b".localhost") {
        i += 10; // `wsl.localhost`
    }
    // `/[^/]+(?:\/|$)`
    if b.len() <= i || b[i] != b'/' {
        return false;
    }
    i += 1;
    let seg = i;
    while i < b.len() && b[i] != b'/' {
        i += 1;
    }
    i > seg // one+ non-slash chars; trailing `/` or end both satisfy `(?:\/|$)`
}

/// `SLASH_FORM_UNC_PREFIX_RE = /^\/\/[^/]+\/[^/]+/`.
fn starts_slash_form_unc(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 4 || b[0] != b'/' || b[1] != b'/' {
        return false;
    }
    let mut i = 2;
    let seg1 = i;
    while i < b.len() && b[i] != b'/' {
        i += 1;
    }
    if i == seg1 || i >= b.len() {
        return false;
    }
    i += 1;
    let seg2 = i;
    while i < b.len() && b[i] != b'/' {
        i += 1;
    }
    i > seg2
}

// ===========================================================================
// §1.2 Mount-prefix derivation — `getWslMountPrefix` (`path-utils.ts:83-91`)
// ===========================================================================

/// `getWslMountPrefix` (`path-utils.ts:83-91`). CD-2: the STRICT regex
/// `^(.*)/[a-zA-Z]/Windows/System32$` (case-insensitive) — **not** the dead
/// `platform-utils.ts` looser `^(.*)/[a-zA-Z]/`.
pub fn get_wsl_mount_prefix(env: &dyn Env) -> String {
    let sys32 = match env.get("WSL_WINDOWS_SYS32") {
        Some(s) if !s.is_empty() => s,
        _ => return "/mnt".to_string(),
    };
    // `.replace(/\\/g,'/')` then `.replace(/\/+$/,'')`.
    let normalized = sys32.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    const SUFFIX: &[u8] = b"/windows/system32";
    let n = normalized.as_bytes();
    if n.len() >= SUFFIX.len() + 2 {
        let (head, tail) = n.split_at(n.len() - SUFFIX.len());
        if tail.eq_ignore_ascii_case(SUFFIX)
            && head[head.len() - 1].is_ascii_alphabetic()
            && head[head.len() - 2] == b'/'
        {
            // Capture group 1 = everything before the `/<letter>` (original casing).
            return normalized[..head.len() - 2].to_string();
        }
    }
    "/mnt".to_string()
}

// ===========================================================================
// path.win32.resolve — normalization of ABSOLUTE Windows paths only.
// ===========================================================================

/// Faithful subset of Node's `path.win32.resolve` for a single **absolute** arg.
/// Returns `None` for cwd-dependent inputs (drive-relative, rooted-without-drive,
/// bare-relative) — see the module-level deterministic-core boundary note.
///
/// Verified against Node 22 goldens (see `tests/path_tests.rs`), e.g.
/// `c:/foo -> c:\foo`, `C:\a\..\b -> C:\b`, `\\wsl.localhost\Ubuntu -> \\wsl.localhost\Ubuntu\`.
pub fn win32_resolve(input: &str) -> Option<String> {
    let b = input.as_bytes();
    // Drive-absolute: `X:` followed by a separator.
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        let device: String = format!("{}:", b[0] as char); // preserve drive-letter case
        let tail = &input[3..];
        let normalized_tail = normalize_win32_segments(tail);
        return Some(join_device_root(&device, &normalized_tail));
    }
    // UNC: `\\server\share...` or `//server/share...`.
    if b.len() >= 2 && ((b[0] == b'\\' && b[1] == b'\\') || (b[0] == b'/' && b[1] == b'/')) {
        if let Some((server, share, tail)) = split_unc(input) {
            let device = format!("\\\\{server}\\{share}");
            let normalized_tail = normalize_win32_segments(tail);
            return Some(join_device_root(&device, &normalized_tail));
        }
    }
    None
}

/// `path.win32.normalize` for the win32-only wsl.exe fallback output (§1.5).
/// wslpath `-w` always returns an absolute path, so this delegates to the same
/// absolute normalization; a non-absolute input is collapsed with `\` separators.
fn win32_normalize(input: &str) -> String {
    win32_resolve(input).unwrap_or_else(|| normalize_win32_segments(input).join("\\"))
}

/// Split `\\server\share<tail>` (or `//server/share<tail>`). Returns
/// `(server, share, tail)` where `tail` begins at the separator after `share`
/// (empty if none). Requires both server and share to be non-empty.
fn split_unc(input: &str) -> Option<(&str, &str, &str)> {
    let b = input.as_bytes();
    let mut i = 2; // skip the two leading separators
    let is_sep = |c: u8| c == b'\\' || c == b'/';
    let server_start = i;
    while i < b.len() && !is_sep(b[i]) {
        i += 1;
    }
    if i == server_start || i >= b.len() {
        return None; // no server, or no separator after server
    }
    let server = &input[server_start..i];
    i += 1; // separator
    let share_start = i;
    while i < b.len() && !is_sep(b[i]) {
        i += 1;
    }
    if i == share_start {
        return None; // no share
    }
    let share = &input[share_start..i];
    let tail = &input[i..]; // begins at the sep after share (or is empty)
    Some((server, share, tail))
}

/// Collapse `.`/`..`/empty segments (split on `\` or `/`), returning the kept
/// segments (never ascending above the root — a leading `..` on an absolute path
/// is dropped, matching Node).
fn normalize_win32_segments(tail: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for seg in tail.split(['\\', '/']) {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other.to_string()),
        }
    }
    out
}

/// Reassemble `device` + root separator + normalized tail. Empty tail yields the
/// bare root `device\` (matches Node: `C:\`, `\\server\share\`).
fn join_device_root(device: &str, segments: &[String]) -> String {
    if segments.is_empty() {
        format!("{device}\\")
    } else {
        format!("{device}\\{}", segments.join("\\"))
    }
}

// ===========================================================================
// §1.3 WSL-drive path -> Windows path (`convertWslDrivePathToWindowsPath`)
// ===========================================================================

/// `convertWslDrivePathToWindowsPath` (`path-utils.ts:97-116`).
/// `/mnt/d/foo/bar -> D:\foo\bar`, `/mnt/c -> C:\`.
pub fn convert_wsl_drive_path_to_windows_path(input: &str, env: &dyn Env) -> Option<String> {
    let normalized = sanitize_user_path_input(input).replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let mount_prefix = get_wsl_mount_prefix(env);
    // `prefixes = mountPrefix === '/mnt' ? ['/mnt'] : [mountPrefix]` — a single entry either way.
    // Regex: `^{prefix}/([a-zA-Z])(?:/(.*))?$` (empty prefix -> `^/([a-zA-Z])...`).
    if !normalized.starts_with(&mount_prefix) {
        return None;
    }
    let after_prefix = &normalized[mount_prefix.len()..];
    let rest_after_slash = after_prefix.strip_prefix('/')?; // require the `/` that follows the prefix
    let rb = rest_after_slash.as_bytes();
    if rb.is_empty() || !rb[0].is_ascii_alphabetic() {
        return None; // need a single drive letter
    }
    let drive = (rb[0] as char).to_ascii_uppercase();
    // After the letter: end-of-string, or `/` + rest. Anything else -> no match.
    let after_letter = &rest_after_slash[1..];
    let rest: Option<&str> = if after_letter.is_empty() {
        None
    } else if let Some(r) = after_letter.strip_prefix('/') {
        Some(r) // `(.*)` after the slash (may be empty)
    } else {
        return None; // letter followed by a non-slash char (e.g. `/mnt/cc`)
    };
    match rest {
        Some(r) if !r.is_empty() => Some(format!("{drive}:\\{}", r.replace('/', "\\"))),
        _ => Some(format!("{drive}:\\")),
    }
}

// ===========================================================================
// §1.4 Windows path -> WSL path (`convertWindowsPathToWslPath`)
// ===========================================================================

/// `convertWindowsPathToWslPath` (`path-utils.ts:118-148`).
///
/// - POSIX-absolute input -> `None` early (the guard at `:124`).
/// - Drive form works regardless of WSL env; the `\\wsl(.localhost)?\<distro>`
///   UNC form only when `is_wsl_env` **and** `<distro>` matches `WSL_DISTRO_NAME`
///   (case-insensitively, and only when `WSL_DISTRO_NAME` is non-empty).
///
/// `is_wsl_env` is Regime A (`detect::is_wsl_env`), passed explicitly per CD-1.
pub fn convert_windows_path_to_wsl_path(input: &str, env: &dyn Env, is_wsl_env: bool) -> Option<String> {
    let cleaned = sanitize_user_path_input(input);
    if cleaned.is_empty() {
        return None;
    }
    if starts_posix_absolute(&cleaned) {
        return None; // the false-positive guard (`:124`)
    }
    let normalized = win32_resolve(&cleaned)?; // see deterministic-core boundary note

    // driveMatch `^([a-zA-Z]):(?:\\(.*))?$`
    if let Some((drive, rest)) = match_drive_backslash(&normalized) {
        let mount_prefix = get_wsl_mount_prefix(env);
        let drive_lower = drive.to_ascii_lowercase();
        let root = if mount_prefix.is_empty() {
            format!("/{drive_lower}")
        } else {
            format!("{mount_prefix}/{drive_lower}")
        };
        return Some(match rest {
            Some(r) if !r.is_empty() => format!("{root}/{}", r.replace('\\', "/")),
            _ => root,
        });
    }

    // wslUncMatch `^\\wsl(?:\.localhost)?\\([^\\]+)(?:\\(.*))?$` (i) — WSL env only.
    if is_wsl_env {
        if let Some((distro, rest)) = match_wsl_unc(&normalized) {
            if let Some(current) = env.get("WSL_DISTRO_NAME") {
                if !current.is_empty() && !current.eq_ignore_ascii_case(distro) {
                    return None;
                }
            }
            return Some(match rest {
                Some(r) if !r.is_empty() => format!("/{}", r.replace('\\', "/")),
                _ => "/".to_string(),
            });
        }
    }

    None
}

/// `^([a-zA-Z]):(?:\\(.*))?$` on a backslash-normalized path. `rest` is the
/// group after the `\` (empty string for a bare root like `C:\`).
fn match_drive_backslash(s: &str) -> Option<(char, Option<&str>)> {
    let b = s.as_bytes();
    if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
        return None;
    }
    if b.len() == 2 {
        return Some((b[0] as char, None)); // `X:` (win32_resolve never emits this, kept for completeness)
    }
    if b[2] == b'\\' {
        return Some((b[0] as char, Some(&s[3..])));
    }
    None
}

/// `^\\wsl(?:\.localhost)?\\([^\\]+)(?:\\(.*))?$` (case-insensitive). Returns
/// `(distro, rest)` where `rest` is the group after the separator (or `None`).
/// Note: only `\\wsl` / `\\wsl.localhost` — NOT `\\wsl$` (that share form yields
/// `None`, matching the reference).
fn match_wsl_unc(s: &str) -> Option<(&str, Option<&str>)> {
    let b = s.as_bytes();
    if b.len() < 2 || b[0] != b'\\' || b[1] != b'\\' {
        return None;
    }
    let mut i = 2;
    if b.len() < i + 3 || !b[i..i + 3].eq_ignore_ascii_case(b"wsl") {
        return None;
    }
    i += 3;
    if b.len() >= i + 10 && b[i..i + 10].eq_ignore_ascii_case(b".localhost") {
        i += 10;
    }
    if b.len() <= i || b[i] != b'\\' {
        return None; // must be `\` immediately after `wsl`/`wsl.localhost`
    }
    i += 1;
    let distro_start = i;
    while i < b.len() && b[i] != b'\\' {
        i += 1;
    }
    if i == distro_start {
        return None; // `[^\\]+` needs >=1 char
    }
    let distro = &s[distro_start..i];
    if i == b.len() {
        return Some((distro, None));
    }
    // b[i] == '\\' here (loop stopped on it): `(?:\\(.*))?`
    i += 1;
    Some((distro, Some(&s[i..])))
}

// ===========================================================================
// §1.5 Native-Windows async fallback to `wsl.exe` (`convertWslPathToWindows`)
// ===========================================================================

/// Injected model of the win32-only `wsl.exe`/`reg.exe` fallback (`path-utils.ts:158-206`),
/// so it is testable without invoking either. `platform-glue.md §1.5 [PORT RISK]`:
/// this whole path is native-Windows-only and not live-verifiable from WSL.
pub trait WslPathResolver {
    /// `hasWslDistributions` (`path-utils.ts:158-174`): a `reg.exe query HKCU\..\Lxss`
    /// probe (cached by the reference) to avoid the Windows-Store WSL-install dialog.
    fn has_wsl_distributions(&self) -> bool;
    /// `wsl.exe wslpath -w <posix>` (`path-utils.ts:190-198`). `None` on failure/empty.
    fn wslpath_to_windows(&self, posix_path: &str) -> Option<String>;
}

const WSL_PATH_TO_WINDOWS_CACHE_MAX_ENTRIES: usize = 256;

/// Promise-cache analogue for `convert_wsl_path_to_windows` (`path-utils.ts:16-18,200-205`):
/// insertion-ordered, LRU-ish eviction of the oldest entry past 256.
#[derive(Debug, Default)]
pub struct WslPathCache {
    map: std::collections::HashMap<String, Option<String>>,
    order: std::collections::VecDeque<String>,
}

impl WslPathCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &str) -> Option<Option<String>> {
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: &str, value: Option<String>) {
        if !self.map.contains_key(key) {
            self.order.push_back(key.to_string());
        }
        self.map.insert(key.to_string(), value);
        if self.map.len() > WSL_PATH_TO_WINDOWS_CACHE_MAX_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// `convertWslPathToWindows` (`path-utils.ts:176-206`), native-Windows-only.
///
/// `host_os` stands in for `process.platform` so the (otherwise `cfg!(windows)`)
/// logic is unit-testable on Linux with an injected [`WslPathResolver`].
pub fn convert_wsl_path_to_windows(
    posix_path: &str,
    host_os: crate::HostOs,
    env: &dyn Env,
    resolver: &dyn WslPathResolver,
    cache: &mut WslPathCache,
) -> Option<String> {
    if host_os != crate::HostOs::Windows {
        return None; // `process.platform !== 'win32'`
    }
    if !posix_path.starts_with('/') {
        return None;
    }
    // 1. mount-mapped sync attempt.
    if let Some(mapped) = convert_wsl_drive_path_to_windows_path(posix_path, env) {
        return Some(mapped);
    }
    // 2. reg.exe Store-dialog guard.
    if !resolver.has_wsl_distributions() {
        return None;
    }
    // 3. promise-cache.
    if let Some(hit) = cache.get(posix_path) {
        return hit;
    }
    // 4. wsl.exe wslpath -w, then path.win32.normalize(trim).
    let result = resolver.wslpath_to_windows(posix_path).and_then(|out| {
        let trimmed = out.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(win32_normalize(trimmed))
        }
    });
    cache.insert(posix_path, result.clone());
    result
}

// ===========================================================================
// launch-cwd (`server/launch-cwd.ts`) — `resolveLaunchCwd`
// ===========================================================================

/// `LaunchCwdTargetRuntime` (`launch-cwd.ts:19`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchCwdTargetRuntime {
    LinuxProcess,
    WindowsProcess,
}

/// `LaunchCwdConversion` (`launch-cwd.ts:21-24`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchCwdConversion {
    None,
    WindowsDriveToWslMount,
    WslMountToWindowsDrive,
}

/// `ResolvedLaunchCwd` (`launch-cwd.ts:26-32`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLaunchCwd {
    pub target_runtime: LaunchCwdTargetRuntime,
    pub input_cwd: Option<String>,
    pub display_cwd: Option<String>,
    pub launch_cwd: Option<String>,
    pub conversion: LaunchCwdConversion,
}

/// `resolveLaunchCwd` (`launch-cwd.ts:127-151`). `is_wsl_env` is Regime A
/// (`isWslRuntime()` == `isWslEnvironment()`), passed explicitly per CD-1.
pub fn resolve_launch_cwd(
    raw_cwd: Option<&str>,
    target_runtime: LaunchCwdTargetRuntime,
    env: &dyn Env,
    is_wsl_env: bool,
) -> ResolvedLaunchCwd {
    let cleaned = raw_cwd.map(sanitize_user_path_input).unwrap_or_default();
    if cleaned.is_empty() {
        return ResolvedLaunchCwd {
            target_runtime,
            input_cwd: raw_cwd.map(str::to_string),
            display_cwd: None,
            launch_cwd: None,
            conversion: LaunchCwdConversion::None,
        };
    }
    let (launch_cwd, conversion) = match target_runtime {
        LaunchCwdTargetRuntime::LinuxProcess => resolve_linux_process_cwd(&cleaned, env, is_wsl_env),
        LaunchCwdTargetRuntime::WindowsProcess => resolve_windows_process_cwd(&cleaned, env, is_wsl_env),
    };
    ResolvedLaunchCwd {
        target_runtime,
        input_cwd: raw_cwd.map(str::to_string),
        display_cwd: Some(cleaned),
        launch_cwd,
        conversion,
    }
}

/// `resolveLinuxProcessCwd` (`launch-cwd.ts:52-89`).
fn resolve_linux_process_cwd(
    candidate: &str,
    env: &dyn Env,
    is_wsl_env: bool,
) -> (Option<String>, LaunchCwdConversion) {
    if starts_windows_drive_relative(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if starts_slash_form_wsl_unc(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if candidate.starts_with("//") {
        return (Some(candidate.to_string()), LaunchCwdConversion::None);
    }
    if is_linux_path(candidate) {
        return (Some(candidate.to_string()), LaunchCwdConversion::None);
    }
    if starts_windows_unc(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if starts_windows_rooted(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if is_windows_absolute_launch(candidate) && is_wsl_env {
        if let Some(converted) = convert_windows_path_to_wsl_path(candidate, env, is_wsl_env) {
            return (Some(converted), LaunchCwdConversion::WindowsDriveToWslMount);
        }
    }
    (None, LaunchCwdConversion::None)
}

/// `resolveWindowsProcessCwd` (`launch-cwd.ts:91-125`).
fn resolve_windows_process_cwd(
    candidate: &str,
    env: &dyn Env,
    is_wsl_env: bool,
) -> (Option<String>, LaunchCwdConversion) {
    if starts_windows_drive_relative(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if is_linux_path(candidate) {
        if !is_wsl_env {
            return (None, LaunchCwdConversion::None);
        }
        if let Some(converted) = convert_wsl_drive_path_to_windows_path(candidate, env) {
            return (Some(converted), LaunchCwdConversion::WslMountToWindowsDrive);
        }
        return (None, LaunchCwdConversion::None);
    }
    if starts_windows_unc(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if starts_slash_form_unc(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if starts_windows_rooted(candidate) {
        return (None, LaunchCwdConversion::None);
    }
    if starts_windows_drive_with_sep(candidate) {
        return (win32_resolve(candidate), LaunchCwdConversion::None);
    }
    (None, LaunchCwdConversion::None)
}

/// `isWindowsAbsolutePath` (`launch-cwd.ts:46-50`): drive-with-sep OR UNC OR rooted.
fn is_windows_absolute_launch(candidate: &str) -> bool {
    starts_windows_drive_with_sep(candidate) || starts_windows_unc(candidate) || starts_windows_rooted(candidate)
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn win32_resolve_absolute_goldens() {
        // Verified against Node path.win32.resolve.
        assert_eq!(win32_resolve("C:\\").as_deref(), Some("C:\\"));
        assert_eq!(win32_resolve("c:/foo").as_deref(), Some("c:\\foo")); // drive case preserved
        assert_eq!(win32_resolve("D:\\a\\b").as_deref(), Some("D:\\a\\b"));
        assert_eq!(win32_resolve("C:\\a\\..\\b").as_deref(), Some("C:\\b"));
        assert_eq!(win32_resolve("C:\\a\\.\\b").as_deref(), Some("C:\\a\\b"));
        assert_eq!(win32_resolve("C:\\foo\\").as_deref(), Some("C:\\foo"));
        assert_eq!(win32_resolve("C:\\foo\\\\bar").as_deref(), Some("C:\\foo\\bar"));
        assert_eq!(
            win32_resolve("\\\\wsl.localhost\\Ubuntu\\home\\dan").as_deref(),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\dan")
        );
        // UNC root gains a trailing backslash (Node behavior).
        assert_eq!(
            win32_resolve("\\\\wsl.localhost\\Ubuntu").as_deref(),
            Some("\\\\wsl.localhost\\Ubuntu\\")
        );
        assert_eq!(
            win32_resolve("//wsl.localhost/Ubuntu/x").as_deref(),
            Some("\\\\wsl.localhost\\Ubuntu\\x")
        );
    }

    #[test]
    fn win32_resolve_none_for_cwd_dependent() {
        // Deterministic-core boundary: relative / drive-relative / rooted -> None.
        assert_eq!(win32_resolve("C:"), None);
        assert_eq!(win32_resolve("C:foo"), None);
        assert_eq!(win32_resolve("\\foo"), None);
        assert_eq!(win32_resolve("foo\\bar"), None);
    }

    #[test]
    fn prefix_predicates() {
        assert!(starts_windows_drive_or_end("C:"));
        assert!(starts_windows_drive_or_end("C:\\"));
        assert!(!starts_windows_drive_or_end("C:foo"));
        assert!(starts_windows_drive_with_sep("C:\\x"));
        assert!(!starts_windows_drive_with_sep("C:"));
        assert!(starts_windows_drive_relative("C:"));
        assert!(starts_windows_drive_relative("C:foo"));
        assert!(!starts_windows_drive_relative("C:\\"));
        assert!(starts_windows_unc("\\\\srv\\share"));
        assert!(!starts_windows_unc("\\\\srv"));
        assert!(starts_windows_rooted("\\foo"));
        assert!(!starts_windows_rooted("\\\\foo"));
        assert!(starts_slash_form_wsl_unc("//wsl.localhost/Ubuntu/x"));
        assert!(starts_slash_form_wsl_unc("//wsl$/Ubuntu"));
        assert!(starts_slash_form_unc("//server/share"));
    }

    #[test]
    fn match_wsl_unc_rejects_dollar_share_form() {
        // `\\wsl$\Ubuntu` is NOT handled by convertWindowsPathToWslPath (only `\\wsl`/`\\wsl.localhost`).
        assert!(match_wsl_unc("\\\\wsl$\\Ubuntu\\x").is_none());
        assert_eq!(
            match_wsl_unc("\\\\wsl.localhost\\Ubuntu\\home\\dan"),
            Some(("Ubuntu", Some("home\\dan")))
        );
        assert_eq!(match_wsl_unc("\\\\wsl.localhost\\Ubuntu\\"), Some(("Ubuntu", Some(""))));
        assert_eq!(match_wsl_unc("\\\\wsl.localhost\\Ubuntu"), Some(("Ubuntu", None)));
    }
}
