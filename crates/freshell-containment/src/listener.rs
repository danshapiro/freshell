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

/// Windows: the pid (among `candidates` and their descendants) that owns
/// the TCP LISTEN socket bound to `port` (IPv4 or IPv6), from the system's
/// TCP tables (`GetExtendedTcpTable`). Same contract as on Linux.
#[cfg(windows)]
pub fn listening_socket_owner(port: u16, candidates: &[u32]) -> Option<u32> {
    let owners = windows_tables::listening_pids(port);
    if owners.is_empty() {
        return None;
    }
    owner_among(
        &owners,
        candidates,
        &crate::process::parent_links(),
        |pid| crate::process::start_time(pid).ok(),
    )
}

/// The first of `candidates` and their descendants that is one of
/// `owners`. Descendants are found through `links` (`(pid, parent pid)`),
/// following a link only to a child that started no earlier than its parent
/// ([`crate::process::tree_by_start`]): a process whose original parent
/// exited can name a pid that a candidate reuses, and it is no descendant
/// of that candidate.
#[cfg(any(windows, test))]
fn owner_among(
    owners: &[u32],
    candidates: &[u32],
    links: &[(u32, u32)],
    start_of: impl Fn(u32) -> Option<u64>,
) -> Option<u32> {
    let roots: Vec<(u32, u64)> = candidates
        .iter()
        .filter_map(|pid| start_of(*pid).map(|start| (*pid, start)))
        .collect();
    crate::process::tree_by_start(&roots, links, start_of)
        .into_iter()
        .map(|(pid, _)| pid)
        .find(|pid| owners.contains(pid))
}

#[cfg(windows)]
mod windows_tables {
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    /// How many times a table that grew between the size query and the read
    /// is asked for again.
    const TABLE_ATTEMPTS: usize = 4;

    /// The owners of every listening TCP socket on `port`.
    pub(super) fn listening_pids(port: u16) -> Vec<u32> {
        let mut pids = Vec::new();
        if let Some(table) = read(u32::from(AF_INET)) {
            // SAFETY: a successful read holds a MIB_TCPTABLE_OWNER_PID with
            // `dwNumEntries` rows.
            let rows = unsafe {
                let t = &*table.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
                std::slice::from_raw_parts::<MIB_TCPROW_OWNER_PID>(
                    t.table.as_ptr(),
                    t.dwNumEntries as usize,
                )
            };
            pids.extend(
                rows.iter()
                    .filter(|r| u16::from_be(r.dwLocalPort as u16) == port)
                    .map(|r| r.dwOwningPid),
            );
        }
        if let Some(table) = read(u32::from(AF_INET6)) {
            // SAFETY: as above, for the IPv6 table.
            let rows = unsafe {
                let t = &*table.as_ptr().cast::<MIB_TCP6TABLE_OWNER_PID>();
                std::slice::from_raw_parts::<MIB_TCP6ROW_OWNER_PID>(
                    t.table.as_ptr(),
                    t.dwNumEntries as usize,
                )
            };
            pids.extend(
                rows.iter()
                    .filter(|r| u16::from_be(r.dwLocalPort as u16) == port)
                    .map(|r| r.dwOwningPid),
            );
        }
        pids
    }

    /// One listener table of `family`, in a buffer aligned for its rows.
    fn read(family: u32) -> Option<Vec<u64>> {
        let mut size = 0u32;
        let mut table: Vec<u64> = Vec::new();
        for _ in 0..TABLE_ATTEMPTS {
            // SAFETY: `table` holds at least `size` bytes (none on the first
            // call, which only asks for the size).
            let rc = unsafe {
                GetExtendedTcpTable(
                    if table.is_empty() {
                        std::ptr::null_mut()
                    } else {
                        table.as_mut_ptr().cast()
                    },
                    &mut size,
                    0,
                    family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            match rc {
                NO_ERROR if !table.is_empty() => return Some(table),
                NO_ERROR | ERROR_INSUFFICIENT_BUFFER => {
                    table = vec![0u64; (size as usize).div_ceil(8).max(1)];
                }
                _ => return None,
            }
        }
        None
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn listening_socket_owner(_port: u16, _candidates: &[u32]) -> Option<u32> {
    None // macOS: Task 7 (libproc)
}

#[cfg(test)]
mod tests {
    use super::owner_among;

    /// Candidate 10 started at 100, 20 is its child and 40 its grandchild.
    /// 30 names 10 as its parent but started at 50, before the candidate:
    /// its real parent was an earlier process 10 that exited before the
    /// candidate reused the pid (Windows never re-parents); 50 is 30's
    /// child.
    const LINKS: [(u32, u32); 5] = [(10, 1), (20, 10), (30, 10), (40, 20), (50, 30)];

    fn start(pid: u32) -> Option<u64> {
        match pid {
            10 => Some(100),
            20 => Some(150),
            30 => Some(50),
            40 => Some(160),
            50 => Some(60),
            _ => None,
        }
    }

    #[test]
    fn the_listener_is_the_candidate_or_one_of_its_descendants_at_any_depth() {
        assert_eq!(owner_among(&[10], &[10], &LINKS, start), Some(10));
        assert_eq!(owner_among(&[20], &[10], &LINKS, start), Some(20));
        assert_eq!(owner_among(&[40], &[10], &LINKS, start), Some(40));
        assert_eq!(owner_among(&[40], &[99], &LINKS, start), None);
    }

    #[test]
    fn a_listener_whose_recorded_parent_pid_a_candidate_reused_is_not_its_descendant() {
        assert_eq!(owner_among(&[30], &[10], &LINKS, start), None);
        assert_eq!(owner_among(&[50], &[10], &LINKS, start), None);
    }
}
