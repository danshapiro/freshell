use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;

use crate::error::{DeployError, Result};
use crate::legacy::{
    capture_legacy, LegacyCaptureReceipt, LegacyCaptureRequest, LegacyRuntimeSources,
    NodePrerequisite, RealScratchProbe,
};
use crate::paths::DeployPort;
use crate::process_identity::LinuxProcfs;
use crate::store::Store;

#[derive(Debug, Clone)]
pub struct CaptureCommand {
    pub checkout: PathBuf,
    pub port: DeployPort,
    pub pid_file: PathBuf,
    pub runtime: LegacyRuntimeSources,
    pub node: NodePrerequisite,
}

impl CaptureCommand {
    pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self> {
        let mut arguments = arguments.into_iter();
        if arguments.next().as_deref() != Some(std::ffi::OsStr::new("capture")) {
            return Err(DeployError::LegacyCapture(
                "expected the `capture` subcommand".to_string(),
            ));
        }
        let mut values = BTreeMap::new();
        while let Some(flag) = arguments.next() {
            let flag_string = flag.to_str().ok_or_else(|| {
                DeployError::LegacyCapture("command option is not UTF-8".to_string())
            })?;
            if !flag_string.starts_with("--") {
                return Err(DeployError::LegacyCapture(format!(
                    "unexpected positional argument {flag_string:?}"
                )));
            }
            if values.contains_key(flag_string) {
                return Err(DeployError::LegacyCapture(format!(
                    "duplicate command option {flag_string}"
                )));
            }
            let value = arguments.next().ok_or_else(|| {
                DeployError::LegacyCapture(format!("missing value for {flag_string}"))
            })?;
            values.insert(flag_string.to_string(), value);
        }

        let checkout = take_path(&mut values, "--checkout")?;
        let port = take_utf8(&mut values, "--port").and_then(|raw| DeployPort::parse(&raw))?;
        let pid_file = take_path(&mut values, "--pid-file")?;
        let client_dir = take_path(&mut values, "--client-dir")?;
        let extensions_dir = take_path(&mut values, "--extensions-dir")?;
        let dist_server_dir = take_path(&mut values, "--dist-server-dir")?;
        let mcp_entry_relative = take_path(&mut values, "--mcp-entry-relative")?;
        let claude_sidecar_dir = take_path(&mut values, "--claude-sidecar-dir")?;
        let claude_sidecar_entry_relative =
            take_path(&mut values, "--claude-sidecar-entry-relative")?;
        let package_json = take_path(&mut values, "--package-json")?;
        let package_lock = take_path(&mut values, "--package-lock")?;
        let production_node_modules = take_path(&mut values, "--node-modules")?;
        let node_executable = take_path(&mut values, "--node-executable")?;
        let node_version = take_utf8(&mut values, "--node-version")?;
        if let Some((unknown, _)) = values.into_iter().next() {
            return Err(DeployError::LegacyCapture(format!(
                "unknown command option {unknown}"
            )));
        }
        Ok(Self {
            checkout,
            port,
            pid_file,
            runtime: LegacyRuntimeSources {
                client_dir,
                extensions_dir,
                dist_server_dir,
                mcp_entry_relative,
                claude_sidecar_dir,
                claude_sidecar_entry_relative,
                package_json,
                package_lock,
                production_node_modules,
            },
            node: NodePrerequisite {
                executable: node_executable,
                version: node_version,
            },
        })
    }

    pub fn pid_hint(&self) -> Result<u32> {
        let metadata = fs::symlink_metadata(&self.pid_file).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "cannot read legacy PID file {}: {error}",
                self.pid_file.display()
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(DeployError::LegacyCapture(format!(
                "legacy PID file is not a regular file: {}",
                self.pid_file.display()
            )));
        }
        let raw = fs::read_to_string(&self.pid_file)?;
        let value = raw.strip_suffix('\n').unwrap_or(&raw);
        if value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
            || (raw != value && raw != format!("{value}\n"))
        {
            return Err(DeployError::LegacyCapture(
                "legacy PID file must contain one canonical decimal PID".to_string(),
            ));
        }
        let pid = value.parse::<u32>().map_err(|_| {
            DeployError::LegacyCapture("legacy PID is outside the supported range".to_string())
        })?;
        if pid == 0 {
            return Err(DeployError::LegacyCapture(
                "legacy PID must be positive".to_string(),
            ));
        }
        Ok(pid)
    }
}

pub fn execute_capture(command: CaptureCommand) -> Result<LegacyCaptureReceipt> {
    let pid_hint = command.pid_hint()?;
    let store = Store::open(&command.checkout, command.port)?;
    let request = LegacyCaptureRequest {
        pid_hint,
        port: command.port,
        runtime: command.runtime,
        node: command.node,
        controller_executable: std::env::current_exe()?,
    };
    capture_legacy(
        &store,
        &request,
        &LinuxProcfs::default(),
        &RealScratchProbe::default(),
    )
}

fn take_path(values: &mut BTreeMap<String, OsString>, flag: &str) -> Result<PathBuf> {
    values
        .remove(flag)
        .map(PathBuf::from)
        .ok_or_else(|| DeployError::LegacyCapture(format!("missing required option {flag}")))
}

fn take_utf8(values: &mut BTreeMap<String, OsString>, flag: &str) -> Result<String> {
    values
        .remove(flag)
        .ok_or_else(|| DeployError::LegacyCapture(format!("missing required option {flag}")))?
        .into_string()
        .map_err(|_| DeployError::LegacyCapture(format!("{flag} value is not UTF-8")))
}
