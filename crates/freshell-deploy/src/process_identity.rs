use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Seek, SeekFrom};
use std::net::SocketAddr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::bounded_http::{get as bounded_http_get, HttpLimits};
use crate::error::{DeployError, Result};
use crate::manifest::sha256_reader;
use crate::paths::DeployPort;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIdentity {
    pub device: String,
    pub inode: String,
    pub sha256: String,
    pub mode: u32,
}

impl FileIdentity {
    pub fn from_path(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        Self::from_file(&mut file)
    }

    pub fn from_file(file: &mut File) -> Result<Self> {
        file.seek(SeekFrom::Start(0))?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(DeployError::ProcessIdentity(
                "executable descriptor is not a regular file".to_string(),
            ));
        }
        let sha256 = sha256_reader(file)?;
        file.seek(SeekFrom::Start(0))?;
        Ok(Self {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            sha256,
            mode: metadata.mode() & 0o7777,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListenerIdentity {
    pub port: DeployPort,
    pub socket_inode: String,
    pub owner_pid: u32,
    pub network_namespace: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub kernel_boot_id: String,
    pub start_time_ticks: String,
    pub executable: FileIdentity,
    pub listener: ListenerIdentity,
    pub cwd: String,
    pub argv0: String,
    pub argument_count: u32,
    pub effective_uid: u32,
    pub runtime: RuntimeProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProvenance {
    pub client_dir: String,
    pub extensions_dir: String,
    pub dist_server_dir: String,
    pub mcp_entry: String,
    pub claude_sidecar_entry: String,
    pub node_executable: String,
    pub package_json: String,
    pub package_lock: String,
    pub production_node_modules: String,
}

impl RuntimeProvenance {
    fn validate(&self) -> bool {
        [
            &self.client_dir,
            &self.extensions_dir,
            &self.dist_server_dir,
            &self.mcp_entry,
            &self.claude_sidecar_entry,
            &self.node_executable,
            &self.package_json,
            &self.package_lock,
            &self.production_node_modules,
        ]
        .into_iter()
        .all(|path| Path::new(path).is_absolute())
    }
}

impl ProcessIdentity {
    pub fn validate(&self) -> Result<()> {
        let decimal =
            |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
        let digest_is_valid = self.executable.sha256.len() == 64
            && self
                .executable
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let boot_id_is_valid = self.kernel_boot_id.len() == 36
            && self
                .kernel_boot_id
                .bytes()
                .enumerate()
                .all(|(index, byte)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                });
        if self.pid == 0
            || self.listener.owner_pid != self.pid
            || self.listener.port.get() == 0
            || !decimal(&self.start_time_ticks)
            || !decimal(&self.executable.device)
            || !decimal(&self.executable.inode)
            || self.executable.mode & !0o7777 != 0
            || self.executable.mode & 0o111 == 0
            || !digest_is_valid
            || !decimal(&self.listener.socket_inode)
            || self.listener.socket_inode == "0"
            || !self.listener.network_namespace.starts_with("net:[")
            || !self.listener.network_namespace.ends_with(']')
            || !boot_id_is_valid
            || !Path::new(&self.cwd).is_absolute()
            || self.argv0.is_empty()
            || self.argument_count == 0
            || !self.runtime.validate()
        {
            return Err(DeployError::ProcessIdentity(
                "process identity is incomplete or malformed".to_string(),
            ));
        }
        Ok(())
    }
}

pub trait ProcessInspector {
    type Pin;

    fn resolve_listener(&self, port: DeployPort) -> Result<ListenerIdentity>;
    fn resolve_listener_for_pid(
        &self,
        port: DeployPort,
        expected_pid: u32,
    ) -> Result<ListenerIdentity> {
        let listener = self.resolve_listener(port)?;
        if listener.owner_pid != expected_pid {
            return Err(DeployError::ProcessIdentity(format!(
                "listener owner pid {} does not match expected pid {expected_pid}",
                listener.owner_pid
            )));
        }
        Ok(listener)
    }
    fn open_pidfd(&self, pid: u32) -> Result<Self::Pin>;
    fn snapshot(&self, pin: &Self::Pin, listener: &ListenerIdentity) -> Result<ProcessIdentity>;
    fn open_executable(&self, pin: &Self::Pin) -> Result<File>;
    fn read_live_client(&self, port: DeployPort) -> Result<Vec<u8>>;
}

pub struct PinnedProcess<'a, Inspector: ProcessInspector> {
    inspector: &'a Inspector,
    pin: Inspector::Pin,
    expected: ProcessIdentity,
    port: DeployPort,
}

impl<'a, Inspector: ProcessInspector> PinnedProcess<'a, Inspector> {
    pub fn pin(inspector: &'a Inspector, pid_hint: u32, port: DeployPort) -> Result<Self> {
        let listener = inspector.resolve_listener_for_pid(port, pid_hint)?;
        if listener.port != port {
            return Err(DeployError::ProcessIdentity(format!(
                "listener resolver returned port {} for requested port {port}",
                listener.port
            )));
        }
        if listener.owner_pid != pid_hint {
            return Err(DeployError::ProcessIdentity(format!(
                "listener owner pid {} does not match pid hint {pid_hint}",
                listener.owner_pid
            )));
        }
        let pin = inspector.open_pidfd(pid_hint)?;
        let expected = inspector.snapshot(&pin, &listener)?;
        validate_snapshot(pid_hint, &listener, &expected)?;
        let pinned = Self {
            inspector,
            pin,
            expected,
            port,
        };
        pinned.revalidate()?;
        Ok(pinned)
    }

    pub fn identity(&self) -> &ProcessIdentity {
        &self.expected
    }

    pub fn open_verified_executable(&self) -> Result<File> {
        let mut executable = self.inspector.open_executable(&self.pin)?;
        let identity = FileIdentity::from_file(&mut executable)?;
        if identity != self.expected.executable {
            return Err(DeployError::ProcessIdentity(
                "opened /proc executable identity changed".to_string(),
            ));
        }
        Ok(executable)
    }

    pub fn read_live_client(&self) -> Result<Vec<u8>> {
        self.inspector.read_live_client(self.port)
    }

    pub fn revalidate(&self) -> Result<()> {
        let current = self
            .inspector
            .snapshot(&self.pin, &self.expected.listener)?;
        if current != self.expected {
            return Err(DeployError::ProcessIdentity(
                "boot/process/executable/socket identity changed".to_string(),
            ));
        }
        // Keep listener ownership last so a listener transferred during the
        // more expensive executable hash invalidates the capture.
        let listener = self
            .inspector
            .resolve_listener_for_pid(self.port, self.expected.pid)
            .map_err(|error| {
                DeployError::ProcessIdentity(format!("listener socket identity changed: {error}"))
            })?;
        if listener != self.expected.listener {
            return Err(DeployError::ProcessIdentity(
                "listener socket identity changed".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_snapshot(
    pid: u32,
    listener: &ListenerIdentity,
    snapshot: &ProcessIdentity,
) -> Result<()> {
    if snapshot.pid != pid || &snapshot.listener != listener {
        return Err(DeployError::ProcessIdentity(
            "process snapshot does not own the resolved listener".to_string(),
        ));
    }
    snapshot.validate()
}

#[derive(Debug, Clone)]
pub struct LinuxProcfs {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExpectedListenerObservation {
    PortFree,
    Expected(ListenerIdentity),
    Foreign,
}

impl Default for LinuxProcfs {
    fn default() -> Self {
        Self {
            root: PathBuf::from("/proc"),
        }
    }
}

impl LinuxProcfs {
    pub fn with_root(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    fn listener_inodes(&self, port: DeployPort) -> Result<BTreeSet<String>> {
        let mut inodes = BTreeSet::new();
        for table in ["tcp", "tcp6"] {
            let path = self.root.join("net").join(table);
            let raw = fs::read_to_string(&path).map_err(|error| {
                DeployError::ProcessIdentity(format!(
                    "cannot read listener table {}: {error}",
                    path.display()
                ))
            })?;
            parse_listener_table(&raw, port, &mut inodes)?;
        }
        Ok(inodes)
    }

    fn owner_pids(&self, socket_inode: &str) -> Result<BTreeSet<u32>> {
        let mut owners = BTreeSet::new();
        let wanted = format!("socket:[{socket_inode}]");
        let current_uid = unsafe { libc::geteuid() };
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if metadata.uid() != current_uid {
                continue;
            }
            let fd_dir = entry.path().join("fd");
            let descriptors = match fs::read_dir(&fd_dir) {
                Ok(descriptors) => descriptors,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(DeployError::ProcessIdentity(format!(
                        "cannot inspect same-user fd directory {}: {error}",
                        fd_dir.display()
                    )));
                }
            };
            for descriptor in descriptors {
                let descriptor = match descriptor {
                    Ok(descriptor) => descriptor,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                match fs::read_link(descriptor.path()) {
                    Ok(target) if target == Path::new(&wanted) => {
                        owners.insert(pid);
                        break;
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(owners)
    }

    fn pid_owns_socket(&self, pid: u32, socket_inode: &str) -> Result<bool> {
        let process_root = self.root.join(pid.to_string());
        let metadata = match fs::symlink_metadata(&process_root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Ok(false);
        }
        let wanted = format!("socket:[{socket_inode}]");
        let fd_dir = process_root.join("fd");
        let descriptors = match fs::read_dir(&fd_dir) {
            Ok(descriptors) => descriptors,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(DeployError::ProcessIdentity(format!(
                    "cannot inspect expected pid {pid} fd directory {}: {error}",
                    fd_dir.display()
                )));
            }
        };
        for descriptor in descriptors {
            let descriptor = match descriptor {
                Ok(descriptor) => descriptor,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            match fs::read_link(descriptor.path()) {
                Ok(target) if target == Path::new(&wanted) => return Ok(true),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(false)
    }

    pub(crate) fn listener_is_loopback(
        &self,
        port: DeployPort,
        socket_inode: &str,
    ) -> Result<bool> {
        let mut matches = Vec::new();
        for table in ["tcp", "tcp6"] {
            let path = self.root.join("net").join(table);
            let raw = fs::read_to_string(&path).map_err(|error| {
                DeployError::ProcessIdentity(format!(
                    "cannot read listener table {}: {error}",
                    path.display()
                ))
            })?;
            parse_listener_addresses(&raw, table, port, socket_inode, &mut matches)?;
        }
        if matches.len() != 1 {
            return Err(DeployError::ProcessIdentity(format!(
                "listener inode {socket_inode} has {} matching address rows",
                matches.len()
            )));
        }
        Ok(matches[0])
    }

    fn pid_path(&self, pid: u32, suffix: &str) -> PathBuf {
        self.root.join(pid.to_string()).join(suffix)
    }

    pub(crate) fn observe_listener(&self, port: DeployPort) -> Result<Option<ListenerIdentity>> {
        let inodes = self.listener_inodes(port)?;
        if inodes.is_empty() {
            return Ok(None);
        }
        if inodes.len() != 1 {
            return Err(DeployError::ProcessIdentity(format!(
                "requested port {port} has {} listening socket inodes; ownership is ambiguous",
                inodes.len()
            )));
        }
        let socket_inode = inodes.into_iter().next().expect("exactly one");
        let owners = self.owner_pids(&socket_inode)?;
        if owners.len() != 1 {
            return Err(DeployError::ProcessIdentity(format!(
                "listener socket inode {socket_inode} has {} visible same-user owners; ownership is ambiguous",
                owners.len()
            )));
        }
        let owner_pid = owners.into_iter().next().expect("exactly one");
        let namespace = fs::read_link(self.pid_path(owner_pid, "ns/net")).map_err(|error| {
            DeployError::ProcessIdentity(format!(
                "cannot read listener network namespace for pid {owner_pid}: {error}"
            ))
        })?;
        let network_namespace = namespace
            .to_str()
            .ok_or_else(|| {
                DeployError::ProcessIdentity("network namespace is not UTF-8".to_string())
            })?
            .to_string();
        Ok(Some(ListenerIdentity {
            port,
            socket_inode,
            owner_pid,
            network_namespace,
        }))
    }

    pub(crate) fn observe_listener_for_pid(
        &self,
        port: DeployPort,
        expected_pid: u32,
    ) -> Result<ExpectedListenerObservation> {
        let inodes = self.listener_inodes(port)?;
        if inodes.is_empty() {
            return Ok(ExpectedListenerObservation::PortFree);
        }
        if inodes.len() != 1 {
            return Err(DeployError::ProcessIdentity(format!(
                "requested port {port} has {} listening socket inodes; ownership is ambiguous",
                inodes.len()
            )));
        }
        let socket_inode = inodes.into_iter().next().expect("exactly one");
        if !self.pid_owns_socket(expected_pid, &socket_inode)? {
            return Ok(ExpectedListenerObservation::Foreign);
        }
        let namespace = fs::read_link(self.pid_path(expected_pid, "ns/net")).map_err(|error| {
            DeployError::ProcessIdentity(format!(
                "cannot read expected listener network namespace for pid {expected_pid}: {error}"
            ))
        })?;
        let network_namespace = namespace
            .to_str()
            .ok_or_else(|| {
                DeployError::ProcessIdentity("network namespace is not UTF-8".to_string())
            })?
            .to_string();
        Ok(ExpectedListenerObservation::Expected(ListenerIdentity {
            port,
            socket_inode,
            owner_pid: expected_pid,
            network_namespace,
        }))
    }

    pub fn resolve_listener_for_pid(
        &self,
        port: DeployPort,
        expected_pid: u32,
    ) -> Result<ListenerIdentity> {
        match self.observe_listener_for_pid(port, expected_pid)? {
            ExpectedListenerObservation::Expected(listener) => Ok(listener),
            ExpectedListenerObservation::PortFree => Err(DeployError::ProcessIdentity(format!(
                "requested port {port} has no listening socket"
            ))),
            ExpectedListenerObservation::Foreign => Err(DeployError::ProcessIdentity(format!(
                "requested port {port} is not owned by expected pid {expected_pid}"
            ))),
        }
    }

    pub(crate) fn observe_recorded_listener(
        &self,
        expected: &ListenerIdentity,
    ) -> Result<ExpectedListenerObservation> {
        let inodes = self.listener_inodes(expected.port)?;
        if inodes.is_empty() {
            return Ok(ExpectedListenerObservation::PortFree);
        }
        if inodes.len() != 1 {
            return Err(DeployError::ProcessIdentity(format!(
                "requested port {} has {} listening socket inodes; ownership is ambiguous",
                expected.port,
                inodes.len()
            )));
        }
        if inodes.first() != Some(&expected.socket_inode) {
            return Ok(ExpectedListenerObservation::Foreign);
        }
        if !self.pid_owns_socket(expected.owner_pid, &expected.socket_inode)? {
            return Ok(ExpectedListenerObservation::Foreign);
        }
        let namespace = match fs::read_link(self.pid_path(expected.owner_pid, "ns/net")) {
            Ok(namespace) => namespace,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ExpectedListenerObservation::Foreign)
            }
            Err(error) => {
                return Err(DeployError::ProcessIdentity(format!(
                    "cannot read recorded listener network namespace for pid {}: {error}",
                    expected.owner_pid
                )))
            }
        };
        if namespace != Path::new(&expected.network_namespace) {
            return Ok(ExpectedListenerObservation::Foreign);
        }
        Ok(ExpectedListenerObservation::Expected(expected.clone()))
    }

    pub fn resolve_recorded_listener(
        &self,
        expected: &ListenerIdentity,
    ) -> Result<ListenerIdentity> {
        match self.observe_recorded_listener(expected)? {
            ExpectedListenerObservation::Expected(listener) => Ok(listener),
            ExpectedListenerObservation::PortFree => Err(DeployError::ProcessIdentity(format!(
                "recorded listener port {} has no listening socket",
                expected.port
            ))),
            ExpectedListenerObservation::Foreign => Err(DeployError::ProcessIdentity(format!(
                "recorded listener fingerprint no longer owns port {}",
                expected.port
            ))),
        }
    }

    pub(crate) fn port_has_listener(&self, port: DeployPort) -> Result<bool> {
        Ok(!self.listener_inodes(port)?.is_empty())
    }

    pub(crate) fn snapshot_listener(&self, listener: &ListenerIdentity) -> Result<ProcessIdentity> {
        let pin = self.open_pidfd(listener.owner_pid)?;
        self.snapshot(&pin, listener)
    }

    pub(crate) fn launch_executor_identity(
        &self,
        pid: u32,
        expected_executable: FileIdentity,
        expected_cwd: &Path,
    ) -> Result<crate::journal::LaunchExecutorIdentity> {
        if self.root != Path::new("/proc") {
            return Err(DeployError::ProcessIdentity(
                "launch executor identity requires live /proc".to_string(),
            ));
        }
        let kernel_boot_id = fs::read_to_string(self.root.join("sys/kernel/random/boot_id"))?
            .trim()
            .to_string();
        let stat = fs::read_to_string(self.pid_path(pid, "stat"))?;
        let start_time_ticks = parse_start_time(&stat)?.to_string();
        let cwd = fs::read_link(self.pid_path(pid, "cwd"))?;
        if cwd != expected_cwd {
            return Err(DeployError::ProcessIdentity(format!(
                "launch helper cwd {} does not match generation root {}",
                cwd.display(),
                expected_cwd.display()
            )));
        }
        let effective_uid = fs::symlink_metadata(self.root.join(pid.to_string()))?.uid();
        Ok(crate::journal::LaunchExecutorIdentity {
            pid,
            kernel_boot_id,
            start_time_ticks,
            executable: expected_executable,
            cwd: expected_cwd.display().to_string(),
            effective_uid,
        })
    }

    pub(crate) fn executor_birth_is_alive(
        &self,
        executor: &crate::journal::LaunchExecutorIdentity,
    ) -> Result<bool> {
        let boot_id = fs::read_to_string(self.root.join("sys/kernel/random/boot_id"))?
            .trim()
            .to_string();
        if boot_id != executor.kernel_boot_id {
            return Ok(false);
        }
        let stat = match fs::read_to_string(self.pid_path(executor.pid, "stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if parse_start_time(&stat)?.to_string() != executor.start_time_ticks {
            return Ok(false);
        }
        let cwd = match fs::read_link(self.pid_path(executor.pid, "cwd")) {
            Ok(cwd) => cwd,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let uid = match fs::symlink_metadata(self.root.join(executor.pid.to_string())) {
            Ok(metadata) => metadata.uid(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        Ok(cwd == Path::new(&executor.cwd) && uid == executor.effective_uid)
    }

    pub(crate) fn process_birth_is_alive(&self, process: &ProcessIdentity) -> Result<bool> {
        self.executor_birth_is_alive(&crate::journal::LaunchExecutorIdentity {
            pid: process.pid,
            kernel_boot_id: process.kernel_boot_id.clone(),
            start_time_ticks: process.start_time_ticks.clone(),
            executable: process.executable.clone(),
            cwd: process.cwd.clone(),
            effective_uid: process.effective_uid,
        })
    }
}

pub struct LinuxPidFd {
    pid: u32,
    descriptor: OwnedFd,
}

impl LinuxPidFd {
    pub(crate) fn raw_fd(&self) -> std::os::fd::RawFd {
        self.descriptor.as_raw_fd()
    }
}

impl ProcessInspector for LinuxProcfs {
    type Pin = LinuxPidFd;

    fn resolve_listener(&self, port: DeployPort) -> Result<ListenerIdentity> {
        self.observe_listener(port)?.ok_or_else(|| {
            DeployError::ProcessIdentity(format!("requested port {port} has no listening socket"))
        })
    }

    fn resolve_listener_for_pid(
        &self,
        port: DeployPort,
        expected_pid: u32,
    ) -> Result<ListenerIdentity> {
        LinuxProcfs::resolve_listener_for_pid(self, port, expected_pid)
    }

    fn open_pidfd(&self, pid: u32) -> Result<Self::Pin> {
        if self.root != Path::new("/proc") {
            return Err(DeployError::ProcessIdentity(
                "pidfds are available only from the live /proc filesystem".to_string(),
            ));
        }
        // SAFETY: pidfd_open takes a numeric PID and zero flags. A successful
        // return is a new owned descriptor.
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0_u32) };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: a successful pidfd_open returned a fresh descriptor.
        let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor as i32) };
        Ok(LinuxPidFd { pid, descriptor })
    }

    fn snapshot(&self, pin: &Self::Pin, listener: &ListenerIdentity) -> Result<ProcessIdentity> {
        ensure_pidfd_alive(&pin.descriptor)?;
        let boot_id = fs::read_to_string(self.root.join("sys/kernel/random/boot_id"))?
            .trim()
            .to_string();
        let stat = fs::read_to_string(self.pid_path(pin.pid, "stat"))?;
        let start_time_ticks = parse_start_time(&stat)?.to_string();
        let mut executable = self.open_executable(pin)?;
        let executable = FileIdentity::from_file(&mut executable)?;
        let cwd = path_to_utf8(&fs::read_link(self.pid_path(pin.pid, "cwd"))?, "cwd")?;
        let network_namespace = path_to_utf8(
            &fs::read_link(self.pid_path(pin.pid, "ns/net"))?,
            "net namespace",
        )?;
        if network_namespace != listener.network_namespace {
            return Err(DeployError::ProcessIdentity(
                "process network namespace changed".to_string(),
            ));
        }
        let command_line = fs::read(self.pid_path(pin.pid, "cmdline"))?;
        let arguments: Vec<&[u8]> = command_line
            .split(|byte| *byte == 0)
            .filter(|argument| !argument.is_empty())
            .collect();
        let argv0 = arguments
            .first()
            .and_then(|argument| std::str::from_utf8(argument).ok())
            .and_then(|argument| Path::new(argument).file_name())
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                DeployError::ProcessIdentity("process argv0 is missing or non-UTF-8".to_string())
            })?
            .to_string();
        let effective_uid = fs::symlink_metadata(self.root.join(pin.pid.to_string()))?.uid();
        let runtime = self.runtime_provenance(pin.pid, Path::new(&cwd))?;
        Ok(ProcessIdentity {
            pid: pin.pid,
            kernel_boot_id: boot_id,
            start_time_ticks,
            executable,
            listener: listener.clone(),
            cwd,
            argv0,
            argument_count: u32::try_from(arguments.len()).map_err(|_| {
                DeployError::ProcessIdentity("process argument count overflow".to_string())
            })?,
            effective_uid,
            runtime,
        })
    }

    fn open_executable(&self, pin: &Self::Pin) -> Result<File> {
        ensure_pidfd_alive(&pin.descriptor)?;
        Ok(File::open(self.pid_path(pin.pid, "exe"))?)
    }

    fn read_live_client(&self, port: DeployPort) -> Result<Vec<u8>> {
        read_loopback_http_body(port, "/")
    }
}

impl LinuxProcfs {
    fn runtime_provenance(&self, pid: u32, cwd: &Path) -> Result<RuntimeProvenance> {
        let raw = fs::read(self.pid_path(pid, "environ"))?;
        let mut environment = std::collections::BTreeMap::<String, String>::new();
        for entry in raw
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let separator = entry.iter().position(|byte| *byte == b'=').ok_or_else(|| {
                DeployError::ProcessIdentity("process environment is malformed".to_string())
            })?;
            let (name, value_with_separator) = entry.split_at(separator);
            let value = &value_with_separator[1..];
            let name = std::str::from_utf8(name).map_err(|_| {
                DeployError::ProcessIdentity("process environment name is not UTF-8".to_string())
            })?;
            if !matches!(
                name,
                "FRESHELL_CLIENT_DIR"
                    | "FRESHELL_EXTENSIONS_DIR"
                    | "FRESHELL_CLAUDE_SIDECAR"
                    | "FRESHELL_CLAUDE_NODE"
                    | "FRESHELL_MCP_SERVER_ENTRY"
                    | "PATH"
            ) {
                continue;
            }
            let value = std::str::from_utf8(value)
                .map_err(|_| DeployError::ProcessIdentity(format!("{name} is not UTF-8")))?;
            if environment
                .insert(name.to_string(), value.to_string())
                .is_some()
            {
                return Err(DeployError::ProcessIdentity(format!(
                    "process environment contains duplicate {name}"
                )));
            }
        }
        let effective = |name: &str, fallback: PathBuf| -> Result<String> {
            let path = environment
                .get(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or(fallback);
            canonical_runtime_path(cwd, &path, name)
        };
        if environment
            .get("FRESHELL_CLIENT_DIR")
            .is_some_and(String::is_empty)
        {
            return Err(DeployError::ProcessIdentity(
                "FRESHELL_CLIENT_DIR is present but empty; live client closure is ambiguous"
                    .to_string(),
            ));
        }
        let explicit_client = environment.get("FRESHELL_CLIENT_DIR");
        let explicit_sidecar = environment
            .get("FRESHELL_CLAUDE_SIDECAR")
            .filter(|value| !value.is_empty());
        let compiled_root = if explicit_client.is_none() || explicit_sidecar.is_none() {
            let executable = fs::read(self.pid_path(pid, "exe")).map_err(|error| {
                DeployError::ProcessIdentity(format!(
                    "cannot read observed executable for compiled runtime provenance: {error}"
                ))
            })?;
            Some(infer_compiled_workspace_root(&executable)?)
        } else {
            None
        };
        let client_path = if let Some(path) = explicit_client {
            PathBuf::from(path)
        } else {
            let compiled = compiled_root
                .as_ref()
                .expect("missing override inferred compile root")
                .join("dist/client");
            if compiled.exists() {
                compiled
            } else {
                cwd.join("dist/client")
            }
        };
        let sidecar_path = explicit_sidecar.map(PathBuf::from).unwrap_or_else(|| {
            compiled_root
                .as_ref()
                .expect("missing override inferred compile root")
                .join("crates/freshell-claude-sidecar/index.mjs")
        });
        let node_path = environment
            .get("FRESHELL_CLAUDE_NODE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        let node_path = if node_path.components().count() == 1 {
            resolve_path_executable(
                &node_path,
                environment.get("PATH").map(String::as_str).unwrap_or(""),
            )?
        } else {
            node_path
        };
        Ok(RuntimeProvenance {
            client_dir: client_runtime_path(cwd, &client_path)?,
            extensions_dir: effective("FRESHELL_EXTENSIONS_DIR", cwd.join("extensions"))?,
            dist_server_dir: canonical_runtime_path(
                cwd,
                &cwd.join("dist/server"),
                "compiled server",
            )?,
            mcp_entry: effective(
                "FRESHELL_MCP_SERVER_ENTRY",
                cwd.join("dist/server/mcp/server.js"),
            )?,
            claude_sidecar_entry: canonical_runtime_path(
                cwd,
                &sidecar_path,
                "FRESHELL_CLAUDE_SIDECAR",
            )?,
            node_executable: canonical_runtime_path(cwd, &node_path, "FRESHELL_CLAUDE_NODE")?,
            package_json: canonical_runtime_path(cwd, &cwd.join("package.json"), "package.json")?,
            package_lock: canonical_runtime_path(
                cwd,
                &cwd.join("package-lock.json"),
                "package-lock.json",
            )?,
            production_node_modules: canonical_runtime_path(
                cwd,
                &cwd.join("node_modules"),
                "node_modules",
            )?,
        })
    }
}

fn client_runtime_path(cwd: &Path, path: &Path) -> Result<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    if !looks_like_managed_current_client(&absolute) {
        return canonical_runtime_path(cwd, path, "FRESHELL_CLIENT_DIR");
    }
    if absolute.components().any(|component| {
        !matches!(
            component,
            std::path::Component::RootDir | std::path::Component::Normal(_)
        )
    }) {
        return Err(DeployError::ProcessIdentity(
            "managed current/client path is not lexically normalized".to_string(),
        ));
    }
    let current = absolute
        .parent()
        .expect("stable current/client has a parent");
    let metadata = fs::symlink_metadata(current)?;
    let target = fs::read_link(current)?;
    let mut target_parts = target.components();
    let target_is_generation = !target.is_absolute()
        && target_parts
            .next()
            .and_then(|part| part.as_os_str().to_str())
            == Some("generations")
        && target_parts
            .next()
            .and_then(|part| part.as_os_str().to_str())
            .is_some_and(|id| crate::receipts::validate_generation_id(id).is_ok())
        && target_parts.next().is_none();
    if !metadata.file_type().is_symlink()
        || !target_is_generation
        || !fs::canonicalize(&absolute)?.is_dir()
    {
        return Err(DeployError::ProcessIdentity(
            "managed current/client path is not backed by the atomic current symlink".to_string(),
        ));
    }
    absolute.to_str().map(str::to_string).ok_or_else(|| {
        DeployError::ProcessIdentity("managed current/client path is not UTF-8".to_string())
    })
}

fn looks_like_managed_current_client(path: &Path) -> bool {
    let Some(current) = path.parent() else {
        return false;
    };
    let Some(port_root) = current.parent() else {
        return false;
    };
    let Some(ports) = port_root.parent() else {
        return false;
    };
    let Some(deploy_root) = ports.parent() else {
        return false;
    };
    path.file_name() == Some(std::ffi::OsStr::new("client"))
        && current.file_name() == Some(std::ffi::OsStr::new("current"))
        && port_root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|port| DeployPort::parse(port).is_ok())
        && ports.file_name() == Some(std::ffi::OsStr::new("ports"))
        && deploy_root.file_name() == Some(std::ffi::OsStr::new(".freshell-deploy"))
}

fn infer_compiled_workspace_root(executable: &[u8]) -> Result<PathBuf> {
    let server_roots =
        compiled_roots_for_marker(executable, "/crates/freshell-server", |root, candidate| {
            let expected = root.join("crates/freshell-server");
            if fs::canonicalize(candidate).ok()? != expected {
                return None;
            }
            let manifest = fs::read_to_string(expected.join("Cargo.toml")).ok()?;
            (manifest.lines().any(|line| line.trim() == "[package]")
                && manifest
                    .lines()
                    .any(|line| line.trim() == "name = \"freshell-server\""))
            .then_some(())
        });
    let sidecar_roots = compiled_roots_for_marker(
        executable,
        "/crates/freshell-freshagent/../freshell-claude-sidecar/index.mjs",
        |root, candidate| {
            let expected = root.join("crates/freshell-claude-sidecar/index.mjs");
            (candidate.is_file() && fs::canonicalize(candidate).ok()? == expected).then_some(())
        },
    );
    let roots: BTreeSet<PathBuf> = server_roots.intersection(&sidecar_roots).cloned().collect();
    if roots.len() == 1 && server_roots.len() == 1 && sidecar_roots.len() == 1 {
        return Ok(roots.into_iter().next().expect("exactly one"));
    }
    if server_roots.is_empty() || sidecar_roots.is_empty() || roots.is_empty() {
        return Err(DeployError::ProcessIdentity(
            "cannot prove the observed binary's compiled Freshell workspace root".to_string(),
        ));
    }
    Err(DeployError::ProcessIdentity(format!(
        "observed binary compiled Freshell workspace root is ambiguous: server={server_roots:?}, sidecar={sidecar_roots:?}"
    )))
}

fn compiled_roots_for_marker(
    executable: &[u8],
    marker: &str,
    validate_candidate: impl Fn(&Path, &Path) -> Option<()>,
) -> BTreeSet<PathBuf> {
    let marker = marker.as_bytes();
    let mut roots = BTreeSet::new();
    for marker_start in executable
        .windows(marker.len())
        .enumerate()
        .filter_map(|(index, window)| (window == marker).then_some(index))
    {
        let marker_end = marker_start + marker.len();
        let lower_bound = marker_start.saturating_sub(4096);
        for start in lower_bound..=marker_start {
            if executable[start] != b'/' {
                continue;
            }
            let Ok(raw) = std::str::from_utf8(&executable[start..marker_end]) else {
                continue;
            };
            let candidate = Path::new(raw);
            if !candidate.is_absolute()
                || candidate
                    .to_str()
                    .is_none_or(|value| !value.ends_with(std::str::from_utf8(marker).unwrap()))
            {
                continue;
            }
            let Ok(root_raw) = std::str::from_utf8(&executable[start..marker_start]) else {
                continue;
            };
            let root = Path::new(root_raw);
            let Ok(canonical_root) = fs::canonicalize(root) else {
                continue;
            };
            if canonical_root != root || validate_candidate(root, candidate).is_none() {
                continue;
            }
            roots.insert(canonical_root);
        }
    }
    roots
}

fn canonical_runtime_path(cwd: &Path, path: &Path, label: &str) -> Result<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    fs::canonicalize(&absolute)
        .map_err(|error| {
            DeployError::ProcessIdentity(format!(
                "cannot resolve live {label} path {}: {error}",
                absolute.display()
            ))
        })?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| DeployError::ProcessIdentity(format!("live {label} path is not UTF-8")))
}

fn resolve_path_executable(name: &Path, path: &str) -> Result<PathBuf> {
    for directory in std::env::split_paths(path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(DeployError::ProcessIdentity(format!(
        "cannot resolve live executable {} through process PATH",
        name.display()
    )))
}

fn read_loopback_http_body(port: DeployPort, path: &str) -> Result<Vec<u8>> {
    read_loopback_http_body_with_limits(port, path, HttpLimits::default())
}

fn read_loopback_http_body_with_limits(
    port: DeployPort,
    path: &str,
    limits: HttpLimits,
) -> Result<Vec<u8>> {
    let response = bounded_http_get(
        SocketAddr::from(([127, 0, 0, 1], port.get())),
        "127.0.0.1",
        path,
        None,
        limits,
    )
    .map_err(|error| {
        DeployError::ProcessIdentity(format!("cannot read live server client: {error}"))
    })?;
    if response.status != 200 {
        return Err(DeployError::ProcessIdentity(format!(
            "live client request did not return 200: {}",
            response.status
        )));
    }
    Ok(response.body)
}

fn parse_listener_table(raw: &str, port: DeployPort, output: &mut BTreeSet<String>) -> Result<()> {
    for line in raw.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            return Err(DeployError::ProcessIdentity(
                "malformed /proc TCP listener row".to_string(),
            ));
        }
        if fields[3] != "0A" {
            continue;
        }
        let port_hex = fields[1]
            .rsplit_once(':')
            .map(|(_, port)| port)
            .ok_or_else(|| {
                DeployError::ProcessIdentity("malformed listener address".to_string())
            })?;
        let parsed_port = u16::from_str_radix(port_hex, 16)
            .map_err(|_| DeployError::ProcessIdentity("malformed listener port".to_string()))?;
        if parsed_port == port.get() {
            let inode = fields[9];
            if inode == "0" || !inode.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(DeployError::ProcessIdentity(
                    "listener inode is missing or malformed".to_string(),
                ));
            }
            output.insert(inode.to_string());
        }
    }
    Ok(())
}

fn parse_listener_addresses(
    raw: &str,
    table: &str,
    port: DeployPort,
    socket_inode: &str,
    output: &mut Vec<bool>,
) -> Result<()> {
    for line in raw.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            return Err(DeployError::ProcessIdentity(
                "malformed /proc TCP listener row".to_string(),
            ));
        }
        if fields[3] != "0A" || fields[9] != socket_inode {
            continue;
        }
        let (address_hex, port_hex) = fields[1].rsplit_once(':').ok_or_else(|| {
            DeployError::ProcessIdentity("malformed listener address".to_string())
        })?;
        let parsed_port = u16::from_str_radix(port_hex, 16)
            .map_err(|_| DeployError::ProcessIdentity("malformed listener port".to_string()))?;
        if parsed_port != port.get() {
            continue;
        }
        let loopback = match table {
            "tcp" => {
                let encoded = u32::from_str_radix(address_hex, 16).map_err(|_| {
                    DeployError::ProcessIdentity("malformed IPv4 listener address".to_string())
                })?;
                std::net::Ipv4Addr::from(encoded.to_le_bytes()).is_loopback()
            }
            "tcp6" => {
                if address_hex.len() != 32 {
                    return Err(DeployError::ProcessIdentity(
                        "malformed IPv6 listener address".to_string(),
                    ));
                }
                let mut octets = [0_u8; 16];
                for (index, chunk) in address_hex.as_bytes().chunks_exact(8).enumerate() {
                    let chunk = std::str::from_utf8(chunk).map_err(|_| {
                        DeployError::ProcessIdentity("malformed IPv6 listener address".to_string())
                    })?;
                    let word = u32::from_str_radix(chunk, 16).map_err(|_| {
                        DeployError::ProcessIdentity("malformed IPv6 listener address".to_string())
                    })?;
                    octets[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
                }
                std::net::Ipv6Addr::from(octets).is_loopback()
            }
            _ => {
                return Err(DeployError::ProcessIdentity(
                    "unknown /proc listener table".to_string(),
                ))
            }
        };
        output.push(loopback);
    }
    Ok(())
}

fn parse_start_time(stat: &str) -> Result<u64> {
    let close = stat
        .rfind(')')
        .ok_or_else(|| DeployError::ProcessIdentity("malformed /proc process stat".to_string()))?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let start_time = fields.get(19).ok_or_else(|| {
        DeployError::ProcessIdentity("process stat has no start time".to_string())
    })?;
    start_time
        .parse::<u64>()
        .map_err(|_| DeployError::ProcessIdentity("invalid process start time".to_string()))
}

fn ensure_pidfd_alive(descriptor: &OwnedFd) -> Result<()> {
    let mut descriptor = libc::pollfd {
        fd: descriptor.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll receives a valid pointer to one initialized pollfd.
    let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let terminal_events = libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
    if result != 0 && descriptor.revents & terminal_events != 0 {
        return Err(DeployError::ProcessIdentity(
            "pidfd reports that the process exited".to_string(),
        ));
    }
    if result != 0 {
        return Err(DeployError::ProcessIdentity(format!(
            "pidfd returned unexpected poll events: {}",
            descriptor.revents
        )));
    }
    Ok(())
}

fn path_to_utf8(path: &Path, label: &str) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| DeployError::ProcessIdentity(format!("{label} is not UTF-8")))
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::thread;
    use std::time::{Duration, Instant};

    use tempfile::TempDir;

    use super::*;
    use crate::bounded_http::HttpLimits;

    const FIXTURE_PID: u32 = 41_337;

    fn identity_http_limits(total_timeout: Duration, max_body_bytes: usize) -> HttpLimits {
        HttpLimits {
            connect_timeout: Duration::from_millis(100),
            total_timeout,
            max_header_bytes: 1024,
            max_body_bytes,
        }
    }

    #[test]
    fn first_adoption_client_read_has_a_total_deadline() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = DeployPort::new(listener.local_addr().unwrap().port()).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
            for _ in 0..30 {
                thread::sleep(Duration::from_millis(20));
                if stream.write_all(b"x").is_err() {
                    break;
                }
            }
        });

        let started = Instant::now();
        let error = read_loopback_http_body_with_limits(
            port,
            "/",
            identity_http_limits(Duration::from_millis(120), 128),
        )
        .unwrap_err();

        assert!(error.to_string().contains("deadline"));
        assert!(started.elapsed() < Duration::from_millis(400));
        server.join().unwrap();
    }

    #[test]
    fn first_adoption_client_read_rejects_an_oversized_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = DeployPort::new(listener.local_addr().unwrap().port()).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n")
                .unwrap();
        });

        let error = read_loopback_http_body_with_limits(
            port,
            "/",
            identity_http_limits(Duration::from_millis(200), 16),
        )
        .unwrap_err();

        assert!(error.to_string().contains("exceeds"));
        server.join().unwrap();
    }

    fn runtime_tree(parent: &Path, name: &str) -> PathBuf {
        let root = parent.join(name);
        for directory in [
            "crates/freshell-server",
            "crates/freshell-freshagent",
            "crates/freshell-claude-sidecar",
            "dist/client",
            "dist/server/mcp",
            "extensions",
            "node_modules",
        ] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        fs::write(
            root.join("crates/freshell-server/Cargo.toml"),
            "[package]\nname = \"freshell-server\"\n",
        )
        .unwrap();
        fs::write(
            root.join("crates/freshell-claude-sidecar/index.mjs"),
            format!("// sidecar from {name}\n"),
        )
        .unwrap();
        fs::write(
            root.join("dist/client/index.html"),
            format!("client from {name}\n"),
        )
        .unwrap();
        fs::write(root.join("dist/server/mcp/server.js"), "export {};\n").unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("package-lock.json"), "{}").unwrap();
        fs::write(root.join("node"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(root.join("node"), fs::Permissions::from_mode(0o755)).unwrap();
        root
    }

    fn proc_fixture(
        fixture: &TempDir,
        executable_strings: &[&Path],
        environment: &[(&str, &Path)],
    ) -> LinuxProcfs {
        let proc_root = fixture.path().join("proc");
        let pid_root = proc_root.join(FIXTURE_PID.to_string());
        fs::create_dir_all(&pid_root).unwrap();
        let mut executable = b"ELF fixture\0".to_vec();
        for value in executable_strings {
            executable.extend_from_slice(value.as_os_str().as_encoded_bytes());
            executable.push(0);
        }
        fs::write(pid_root.join("exe"), executable).unwrap();
        let mut environ = Vec::new();
        for (name, value) in environment {
            environ.extend_from_slice(name.as_bytes());
            environ.push(b'=');
            environ.extend_from_slice(value.as_os_str().as_encoded_bytes());
            environ.push(0);
        }
        fs::write(pid_root.join("environ"), environ).unwrap();
        LinuxProcfs::with_root(&proc_root)
    }

    fn manifest_markers(root: &Path) -> [PathBuf; 2] {
        [
            root.join("crates/freshell-server"),
            root.join("crates/freshell-freshagent/../freshell-claude-sidecar/index.mjs"),
        ]
    }

    fn replace_environment(proc: &LinuxProcfs, entries: &[(&str, &[u8])]) {
        let mut environment = Vec::new();
        for (name, value) in entries {
            environment.extend_from_slice(name.as_bytes());
            environment.push(b'=');
            environment.extend_from_slice(value);
            environment.push(0);
        }
        fs::write(proc.pid_path(FIXTURE_PID, "environ"), environment).unwrap();
    }

    #[test]
    fn proc_listener_address_parser_distinguishes_loopback_from_wildcard() {
        let header =
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
        let loopback =
            "   0: 0100007F:B415 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345\n";
        let wildcard =
            "   0: 00000000:B415 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345\n";
        let port = DeployPort::new(46_101).unwrap();

        let mut addresses = Vec::new();
        parse_listener_addresses(
            &format!("{header}{loopback}"),
            "tcp",
            port,
            "12345",
            &mut addresses,
        )
        .unwrap();
        assert_eq!(addresses, [true]);

        addresses.clear();
        parse_listener_addresses(
            &format!("{header}{wildcard}"),
            "tcp",
            port,
            "12345",
            &mut addresses,
        )
        .unwrap();
        assert_eq!(addresses, [false]);
    }

    #[test]
    fn absent_overrides_use_the_binary_compile_root_not_launch_cwd() {
        let fixture = tempfile::tempdir().unwrap();
        let compiled = runtime_tree(fixture.path(), "compiled");
        let launch_cwd = runtime_tree(fixture.path(), "launch");
        let markers = manifest_markers(&compiled);
        let node = launch_cwd.join("node");
        let proc = proc_fixture(
            &fixture,
            &[markers[0].as_path(), markers[1].as_path()],
            &[("FRESHELL_CLAUDE_NODE", node.as_path())],
        );

        let provenance = proc
            .runtime_provenance(FIXTURE_PID, &launch_cwd)
            .expect("unique compiled fallback provenance");

        assert_eq!(
            Path::new(&provenance.client_dir),
            fs::canonicalize(compiled.join("dist/client")).unwrap()
        );
        assert_eq!(
            Path::new(&provenance.claude_sidecar_entry),
            fs::canonicalize(compiled.join("crates/freshell-claude-sidecar/index.mjs")).unwrap()
        );
    }

    #[test]
    fn absent_overrides_reject_ambiguous_binary_compile_roots() {
        let fixture = tempfile::tempdir().unwrap();
        let first = runtime_tree(fixture.path(), "first-compiled");
        let second = runtime_tree(fixture.path(), "second-compiled");
        let launch_cwd = runtime_tree(fixture.path(), "launch");
        let first_markers = manifest_markers(&first);
        let second_markers = manifest_markers(&second);
        let node = launch_cwd.join("node");
        let proc = proc_fixture(
            &fixture,
            &[
                first_markers[0].as_path(),
                first_markers[1].as_path(),
                second_markers[0].as_path(),
                second_markers[1].as_path(),
            ],
            &[("FRESHELL_CLAUDE_NODE", node.as_path())],
        );

        let error = proc
            .runtime_provenance(FIXTURE_PID, &launch_cwd)
            .unwrap_err();

        assert!(error.to_string().contains("ambiguous"));
    }

    #[test]
    fn absent_overrides_reject_unprovable_binary_compile_root() {
        let fixture = tempfile::tempdir().unwrap();
        let launch_cwd = runtime_tree(fixture.path(), "launch");
        let node = launch_cwd.join("node");
        let proc = proc_fixture(&fixture, &[], &[("FRESHELL_CLAUDE_NODE", node.as_path())]);

        let error = proc
            .runtime_provenance(FIXTURE_PID, &launch_cwd)
            .unwrap_err();

        assert!(error.to_string().contains("cannot prove"));
    }

    #[test]
    fn explicit_client_and_sidecar_overrides_do_not_require_compile_root_provenance() {
        let fixture = tempfile::tempdir().unwrap();
        let launch_cwd = runtime_tree(fixture.path(), "launch");
        let explicit = runtime_tree(fixture.path(), "explicit");
        let node = launch_cwd.join("node");
        let client = explicit.join("dist/client");
        let sidecar = explicit.join("crates/freshell-claude-sidecar/index.mjs");
        let proc = proc_fixture(
            &fixture,
            &[],
            &[
                ("FRESHELL_CLAUDE_NODE", node.as_path()),
                ("FRESHELL_CLIENT_DIR", client.as_path()),
                ("FRESHELL_CLAUDE_SIDECAR", sidecar.as_path()),
            ],
        );

        let provenance = proc
            .runtime_provenance(FIXTURE_PID, &launch_cwd)
            .expect("explicit overrides");

        assert_eq!(
            Path::new(&provenance.client_dir),
            fs::canonicalize(client).unwrap()
        );
        assert_eq!(
            Path::new(&provenance.claude_sidecar_entry),
            fs::canonicalize(sidecar).unwrap()
        );
    }

    #[test]
    fn managed_current_client_override_preserves_the_stable_lexical_path() {
        let fixture = tempfile::tempdir().unwrap();
        let port_root = fixture.path().join(".freshell-deploy/ports/3410");
        let generation = runtime_tree(
            &port_root.join("generations"),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        fs::create_dir(generation.join("client")).unwrap();
        fs::write(generation.join("client/index.html"), "managed client").unwrap();
        std::os::unix::fs::symlink(
            Path::new("generations")
                .join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            port_root.join("current"),
        )
        .unwrap();
        let stable_client = port_root.join("current/client");
        let node = generation.join("node");
        let sidecar = generation.join("crates/freshell-claude-sidecar/index.mjs");
        let proc = proc_fixture(
            &fixture,
            &[],
            &[
                ("FRESHELL_CLAUDE_NODE", node.as_path()),
                ("FRESHELL_CLIENT_DIR", stable_client.as_path()),
                ("FRESHELL_CLAUDE_SIDECAR", sidecar.as_path()),
            ],
        );

        let provenance = proc
            .runtime_provenance(FIXTURE_PID, &generation)
            .expect("managed stable client provenance");

        assert_eq!(Path::new(&provenance.client_dir), stable_client);
        assert_ne!(
            Path::new(&provenance.client_dir),
            fs::canonicalize(&stable_client).unwrap(),
            "current/client must not be frozen to the selected generation"
        );
    }

    #[test]
    fn unrelated_current_client_symlink_is_not_treated_as_managed_indirection() {
        let fixture = tempfile::tempdir().unwrap();
        let generation = runtime_tree(fixture.path(), "ordinary-generation");
        fs::create_dir(generation.join("client")).unwrap();
        fs::write(generation.join("client/index.html"), "ordinary client").unwrap();
        let unrelated = fixture.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        std::os::unix::fs::symlink(&generation, unrelated.join("current")).unwrap();
        let client = unrelated.join("current/client");
        let node = generation.join("node");
        let sidecar = generation.join("crates/freshell-claude-sidecar/index.mjs");
        let proc = proc_fixture(
            &fixture,
            &[],
            &[
                ("FRESHELL_CLAUDE_NODE", node.as_path()),
                ("FRESHELL_CLIENT_DIR", client.as_path()),
                ("FRESHELL_CLAUDE_SIDECAR", sidecar.as_path()),
            ],
        );

        let provenance = proc
            .runtime_provenance(FIXTURE_PID, &generation)
            .expect("ordinary symlink provenance");

        assert_eq!(
            Path::new(&provenance.client_dir),
            fs::canonicalize(client).unwrap()
        );
    }

    #[test]
    fn present_but_empty_client_override_fails_closed() {
        let fixture = tempfile::tempdir().unwrap();
        let compiled = runtime_tree(fixture.path(), "compiled");
        let launch_cwd = runtime_tree(fixture.path(), "launch");
        let markers = manifest_markers(&compiled);
        let node = launch_cwd.join("node");
        let proc = proc_fixture(&fixture, &[markers[0].as_path(), markers[1].as_path()], &[]);
        replace_environment(
            &proc,
            &[
                ("FRESHELL_CLIENT_DIR", b""),
                ("FRESHELL_CLAUDE_NODE", node.as_os_str().as_encoded_bytes()),
            ],
        );

        let error = proc
            .runtime_provenance(FIXTURE_PID, &launch_cwd)
            .unwrap_err();

        assert!(error.to_string().contains("FRESHELL_CLIENT_DIR"));
        assert!(error.to_string().contains("empty"));
    }

    #[test]
    fn present_but_empty_sidecar_override_uses_compiled_fallback() {
        let fixture = tempfile::tempdir().unwrap();
        let compiled = runtime_tree(fixture.path(), "compiled");
        let launch_cwd = runtime_tree(fixture.path(), "launch");
        let markers = manifest_markers(&compiled);
        let node = launch_cwd.join("node");
        let client = launch_cwd.join("dist/client");
        let proc = proc_fixture(&fixture, &[markers[0].as_path(), markers[1].as_path()], &[]);
        replace_environment(
            &proc,
            &[
                ("FRESHELL_CLIENT_DIR", client.as_os_str().as_encoded_bytes()),
                ("FRESHELL_CLAUDE_SIDECAR", b""),
                ("FRESHELL_CLAUDE_NODE", node.as_os_str().as_encoded_bytes()),
            ],
        );

        let provenance = proc
            .runtime_provenance(FIXTURE_PID, &launch_cwd)
            .expect("empty sidecar override follows compiled fallback");

        assert_eq!(
            Path::new(&provenance.claude_sidecar_entry),
            fs::canonicalize(compiled.join("crates/freshell-claude-sidecar/index.mjs")).unwrap()
        );
    }
}
