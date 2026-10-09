/// Linux: the pid (among `candidates` and their descendants) whose fd table
/// holds the LISTEN socket bound to `port`. Used once, right after a
/// sidecar's readiness probe succeeds, to find the native app-server behind
/// any launcher/wrapper chain. `None` means no candidate tree owns the
/// listener (another unit's app-server may have answered the probe): the
/// caller fails that start attempt; it never falls back to the launcher.
#[cfg(target_os = "linux")]
pub fn listening_socket_owner(port: u16, candidates: &[u32]) -> Option<u32> {
    let inodes = listening_inodes(port);
    if inodes.is_empty() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut frontier: Vec<u32> = candidates.to_vec();
    while let Some(pid) = frontier.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if owns_socket(pid, &inodes) {
            return Some(pid);
        }
        frontier.extend(crate::process::children(pid));
    }
    None
}

#[cfg(target_os = "linux")]
fn listening_inodes(port: u16) -> Vec<String> {
    let mut out = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(raw) = std::fs::read_to_string(table) else {
            continue;
        };
        for line in raw.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                continue;
            }
            let Some(port_hex) = f[1].rsplit(':').next() else {
                continue;
            };
            if u16::from_str_radix(port_hex, 16).ok() == Some(port) {
                out.push(f[9].to_string());
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn owns_socket(pid: u32, inodes: &[String]) -> bool {
    let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    fds.flatten().any(|fd| {
        std::fs::read_link(fd.path())
            .ok()
            .and_then(|t| t.to_str().map(str::to_string))
            .and_then(|t| {
                t.strip_prefix("socket:[")
                    .and_then(|s| s.strip_suffix(']'))
                    .map(str::to_string)
            })
            .is_some_and(|ino| inodes.contains(&ino))
    })
}

#[cfg(not(target_os = "linux"))]
pub fn listening_socket_owner(_port: u16, _candidates: &[u32]) -> Option<u32> {
    None // Windows: Task 6 (GetExtendedTcpTable); macOS: Task 7 (libproc)
}
