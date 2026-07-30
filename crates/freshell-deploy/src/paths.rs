use std::fmt;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{DeployError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u16", into = "u16")]
pub struct DeployPort(u16);

impl DeployPort {
    pub fn new(value: u16) -> Result<Self> {
        if value == 0 {
            return Err(DeployError::InvalidPort(value.to_string()));
        }
        Ok(Self(value))
    }

    pub fn parse(raw: &str) -> Result<Self> {
        if raw.is_empty()
            || !raw.bytes().all(|byte| byte.is_ascii_digit())
            || (raw.len() > 1 && raw.starts_with('0'))
        {
            return Err(DeployError::InvalidPort(raw.to_string()));
        }
        let value = raw
            .parse::<u16>()
            .map_err(|_| DeployError::InvalidPort(raw.to_string()))?;
        Self::new(value)
    }

    pub fn get(self) -> u16 {
        self.0
    }
}

impl TryFrom<u16> for DeployPort {
    type Error = DeployError;

    fn try_from(value: u16) -> Result<Self> {
        Self::new(value)
    }
}

impl From<DeployPort> for u16 {
    fn from(port: DeployPort) -> Self {
        port.get()
    }
}

impl fmt::Display for DeployPort {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone)]
pub struct StorePaths {
    checkout: PathBuf,
    port: DeployPort,
    store_root: PathBuf,
    port_root: PathBuf,
    generations: PathBuf,
    current: PathBuf,
    live: PathBuf,
    legacy: PathBuf,
    lock: PathBuf,
}

impl StorePaths {
    pub fn new(checkout: &Path, port: DeployPort) -> Result<Self> {
        if !checkout.is_absolute()
            || checkout == Path::new("/")
            || checkout
                .components()
                .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err(DeployError::UnsafeCheckout(checkout.to_path_buf()));
        }
        let metadata = fs::symlink_metadata(checkout)
            .map_err(|_| DeployError::UnsafeCheckout(checkout.to_path_buf()))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(DeployError::UnsafeCheckout(checkout.to_path_buf()));
        }
        let canonical = fs::canonicalize(checkout)
            .map_err(|_| DeployError::UnsafeCheckout(checkout.to_path_buf()))?;
        if canonical != checkout {
            return Err(DeployError::UnsafeCheckout(checkout.to_path_buf()));
        }
        let git_marker = canonical.join(".git");
        let git_metadata = fs::symlink_metadata(&git_marker)
            .map_err(|_| DeployError::UnsafeCheckout(canonical.clone()))?;
        if git_metadata.file_type().is_symlink()
            || !(git_metadata.is_file() || git_metadata.is_dir())
        {
            return Err(DeployError::UnsafeCheckout(canonical));
        }

        let store_root = canonical.join(".freshell-deploy");
        let port_root = store_root.join("ports").join(port.to_string());
        Ok(Self {
            checkout: canonical,
            port,
            generations: port_root.join("generations"),
            current: port_root.join("current"),
            live: port_root.join("live.json"),
            legacy: port_root.join("legacy.json"),
            lock: port_root.join("deploy.lock"),
            store_root,
            port_root,
        })
    }

    pub(crate) fn initialize(&self) -> Result<()> {
        ensure_private_directory(&self.store_root)?;
        ensure_private_directory(&self.store_root.join("ports"))?;
        ensure_private_directory(&self.port_root)?;
        ensure_private_directory(&self.generations)?;
        Ok(())
    }

    pub fn checkout(&self) -> &Path {
        &self.checkout
    }

    pub fn port(&self) -> DeployPort {
        self.port
    }

    pub fn store_root(&self) -> &Path {
        &self.store_root
    }

    pub fn port_root(&self) -> &Path {
        &self.port_root
    }

    pub fn generations_dir(&self) -> &Path {
        &self.generations
    }

    pub fn current_pointer(&self) -> &Path {
        &self.current
    }

    pub fn live_receipt(&self) -> &Path {
        &self.live
    }

    pub fn legacy_receipt(&self) -> &Path {
        &self.legacy
    }

    pub fn lock_file(&self) -> &Path {
        &self.lock
    }
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let current_uid = unsafe { libc::geteuid() };
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || metadata.uid() != current_uid
                || metadata.mode() & 0o7777 != 0o700
            {
                return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = path
        .parent()
        .ok_or_else(|| DeployError::UnsafeStorePath(path.to_path_buf()))?;
    fs::create_dir(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
    }
    fs::File::open(path)?.sync_all()?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub(crate) fn validate_relative_path(path: &Path, allow_empty: bool) -> Result<()> {
    if path.is_absolute() || (!allow_empty && path.as_os_str().is_empty()) {
        return Err(DeployError::UnsafeRelativePath(path.to_path_buf()));
    }
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(DeployError::UnsafeRelativePath(path.to_path_buf()));
    }
    if path.to_str().is_none() {
        return Err(DeployError::UnsafeRelativePath(path.to_path_buf()));
    }
    Ok(())
}

pub(crate) fn validate_symlink_target(entry: &Path, target: &Path) -> Result<()> {
    if target.is_absolute() || target.to_str().is_none() {
        return Err(DeployError::UnsafeRelativePath(target.to_path_buf()));
    }
    let mut depth = entry
        .parent()
        .map_or(0, |parent| parent.components().count());
    for component in target.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            _ => return Err(DeployError::UnsafeRelativePath(target.to_path_buf())),
        }
    }
    Ok(())
}
