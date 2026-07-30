use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::{DeployError, Result};
use crate::journal::UpdateMode;
use crate::legacy::NodePrerequisite;
use crate::paths::DeployPort;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerAssemblySources {
    pub server_executable: PathBuf,
    pub controller_executable: PathBuf,
    pub extensions_dir: PathBuf,
    pub dist_server_dir: PathBuf,
    pub mcp_entry_relative: PathBuf,
    pub claude_sidecar_dir: PathBuf,
    pub claude_sidecar_entry_relative: PathBuf,
    pub package_json: PathBuf,
    pub package_lock: PathBuf,
    pub production_node_modules: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployCommand {
    pub checkout: PathBuf,
    pub port: DeployPort,
    pub mode: UpdateMode,
    pub client_dir: Option<PathBuf>,
    pub server: Option<ServerAssemblySources>,
    pub node: NodePrerequisite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControllerCommand {
    BootstrapStatus {
        checkout: PathBuf,
        port: DeployPort,
    },
    Deploy(Box<DeployCommand>),
    StartCurrent {
        checkout: PathBuf,
        port: DeployPort,
        restart: bool,
    },
    StopCurrent {
        checkout: PathBuf,
        port: DeployPort,
    },
}

impl ControllerCommand {
    pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self> {
        let mut arguments = arguments.into_iter();
        let command = arguments
            .next()
            .ok_or_else(|| command_error("missing subcommand"))?;
        let command = command
            .to_str()
            .ok_or_else(|| command_error("subcommand is not UTF-8"))?;
        let mut values = option_values(arguments)?;
        match command {
            "bootstrap-status" => {
                let common = take_common(&mut values)?;
                require_empty(values)?;
                Ok(Self::BootstrapStatus {
                    checkout: common.0,
                    port: common.1,
                })
            }
            "start-current" | "restart-current" => {
                let common = take_common(&mut values)?;
                require_empty(values)?;
                Ok(Self::StartCurrent {
                    checkout: common.0,
                    port: common.1,
                    restart: command == "restart-current",
                })
            }
            "stop-current" => {
                let common = take_common(&mut values)?;
                require_empty(values)?;
                Ok(Self::StopCurrent {
                    checkout: common.0,
                    port: common.1,
                })
            }
            "deploy" => Ok(Self::Deploy(Box::new(parse_deploy(values)?))),
            unknown => Err(command_error(format!("unknown subcommand {unknown}"))),
        }
    }
}

fn parse_deploy(mut values: BTreeMap<String, OsString>) -> Result<DeployCommand> {
    let (checkout, port) = take_common(&mut values)?;
    let mode = match take_utf8(&mut values, "--mode")?.as_str() {
        "client-only" => UpdateMode::ClientOnly,
        "server" => UpdateMode::Server,
        "full" => UpdateMode::Full,
        value => return Err(command_error(format!("invalid deployment mode {value}"))),
    };
    let node = NodePrerequisite {
        executable: take_path(&mut values, "--node-executable")?,
        version: take_utf8(&mut values, "--node-version")?,
    };
    if !node.executable.is_absolute() || node.version.is_empty() {
        return Err(command_error(
            "Node executable/version must be complete and absolute",
        ));
    }
    let client_dir = values.remove("--client-dir").map(PathBuf::from);
    let server_flags = [
        "--server-executable",
        "--controller-executable",
        "--extensions-dir",
        "--dist-server-dir",
        "--mcp-entry-relative",
        "--claude-sidecar-dir",
        "--claude-sidecar-entry-relative",
        "--package-json",
        "--package-lock",
        "--node-modules",
    ];
    let has_server_values = server_flags.iter().any(|flag| values.contains_key(*flag));
    let server = if has_server_values {
        Some(ServerAssemblySources {
            server_executable: take_path(&mut values, "--server-executable")?,
            controller_executable: take_path(&mut values, "--controller-executable")?,
            extensions_dir: take_path(&mut values, "--extensions-dir")?,
            dist_server_dir: take_path(&mut values, "--dist-server-dir")?,
            mcp_entry_relative: take_path(&mut values, "--mcp-entry-relative")?,
            claude_sidecar_dir: take_path(&mut values, "--claude-sidecar-dir")?,
            claude_sidecar_entry_relative: take_path(
                &mut values,
                "--claude-sidecar-entry-relative",
            )?,
            package_json: take_path(&mut values, "--package-json")?,
            package_lock: take_path(&mut values, "--package-lock")?,
            production_node_modules: take_path(&mut values, "--node-modules")?,
        })
    } else {
        None
    };
    require_empty(values)?;
    match mode {
        UpdateMode::ClientOnly if client_dir.is_some() && server.is_none() => {}
        UpdateMode::Server if client_dir.is_none() && server.is_some() => {}
        UpdateMode::Full if client_dir.is_some() && server.is_some() => {}
        _ => {
            return Err(command_error(
                "deployment mode does not have its exact required component sources",
            ))
        }
    }
    Ok(DeployCommand {
        checkout,
        port,
        mode,
        client_dir,
        server,
        node,
    })
}

fn option_values(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<BTreeMap<String, OsString>> {
    let mut arguments = arguments.into_iter();
    let mut values = BTreeMap::new();
    while let Some(flag) = arguments.next() {
        let flag = flag
            .to_str()
            .ok_or_else(|| command_error("command option is not UTF-8"))?;
        if !flag.starts_with("--") {
            return Err(command_error(format!(
                "unexpected positional argument {flag:?}"
            )));
        }
        if values.contains_key(flag) {
            return Err(command_error(format!("duplicate command option {flag}")));
        }
        let value = arguments
            .next()
            .ok_or_else(|| command_error(format!("missing value for {flag}")))?;
        values.insert(flag.to_string(), value);
    }
    Ok(values)
}

fn take_common(values: &mut BTreeMap<String, OsString>) -> Result<(PathBuf, DeployPort)> {
    let checkout = take_path(values, "--checkout")?;
    let port = DeployPort::parse(&take_utf8(values, "--port")?)?;
    Ok((checkout, port))
}

fn take_path(values: &mut BTreeMap<String, OsString>, flag: &str) -> Result<PathBuf> {
    values
        .remove(flag)
        .map(PathBuf::from)
        .ok_or_else(|| command_error(format!("missing required option {flag}")))
}

fn take_utf8(values: &mut BTreeMap<String, OsString>, flag: &str) -> Result<String> {
    values
        .remove(flag)
        .ok_or_else(|| command_error(format!("missing required option {flag}")))?
        .into_string()
        .map_err(|_| command_error(format!("{flag} value is not UTF-8")))
}

fn require_empty(values: BTreeMap<String, OsString>) -> Result<()> {
    if let Some((unknown, _)) = values.into_iter().next() {
        return Err(command_error(format!("unknown command option {unknown}")));
    }
    Ok(())
}

fn command_error(message: impl Into<String>) -> DeployError {
    DeployError::Activation(format!("controller command: {}", message.into()))
}
