use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{DeployError, Result};
use crate::paths::{validate_relative_path, validate_symlink_target};

pub const MANIFEST_FILE_NAME: &str = "manifest.json";
const SCHEMA_VERSION: &str = "1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: EntryKind,
    pub mode: u32,
    pub symlink_target: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationManifest {
    pub schema_version: String,
    pub generation_id: String,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestIdentity<'a> {
    schema_version: &'a str,
    entries: &'a [ManifestEntry],
}

impl GenerationManifest {
    pub(crate) fn build(root: &Path) -> Result<Self> {
        let entries = snapshot_entries(root, true)?;
        let generation_id = generation_id(&entries)?;
        Ok(Self {
            schema_version: SCHEMA_VERSION.to_string(),
            generation_id,
            entries,
        })
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes)
            .map_err(|error| DeployError::InvalidManifest(error.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn to_json(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut bytes = serde_json::to_vec(self)
            .map_err(|error| DeployError::InvalidManifest(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    pub fn read(path: &Path) -> Result<Self> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(DeployError::InvalidManifest(format!(
                "{} is not a regular manifest file",
                path.display()
            )));
        }
        let mode = metadata.mode() & 0o7777;
        if mode != 0o444 {
            return Err(DeployError::ModeMismatch {
                path: path.to_path_buf(),
                expected: 0o444,
                actual: mode,
            });
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Self::from_json(&bytes)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(DeployError::InvalidManifest(
                "schemaVersion must be \"1\"".to_string(),
            ));
        }
        validate_digest(&self.generation_id, "generationId")?;
        let mut prior: Option<&str> = None;
        let mut paths = BTreeSet::new();
        for entry in &self.entries {
            let relative = Path::new(&entry.path);
            validate_relative_path(relative, false)
                .map_err(|error| DeployError::InvalidManifest(error.to_string()))?;
            if entry.path == MANIFEST_FILE_NAME {
                return Err(DeployError::InvalidManifest(
                    "manifest cannot include itself".to_string(),
                ));
            }
            if entry.mode & !0o7777 != 0 {
                return Err(DeployError::InvalidManifest(format!(
                    "invalid mode for {}",
                    entry.path
                )));
            }
            if let Some(previous) = prior {
                if previous.as_bytes() >= entry.path.as_bytes() {
                    return Err(DeployError::InvalidManifest(
                        "entries must be unique and bytewise sorted".to_string(),
                    ));
                }
            }
            prior = Some(&entry.path);
            if !paths.insert(&entry.path) {
                return Err(DeployError::InvalidManifest(format!(
                    "duplicate path {}",
                    entry.path
                )));
            }
            match entry.kind {
                EntryKind::File => {
                    if entry.symlink_target.is_some() {
                        return Err(DeployError::InvalidManifest(format!(
                            "file {} has a symlink target",
                            entry.path
                        )));
                    }
                    validate_digest_option(&entry.sha256, &entry.path)?;
                }
                EntryKind::Directory => {
                    if entry.symlink_target.is_some() || entry.sha256.is_some() {
                        return Err(DeployError::InvalidManifest(format!(
                            "directory {} has file-only metadata",
                            entry.path
                        )));
                    }
                }
                EntryKind::Symlink => {
                    let target = entry.symlink_target.as_deref().ok_or_else(|| {
                        DeployError::InvalidManifest(format!(
                            "symlink {} has no target",
                            entry.path
                        ))
                    })?;
                    validate_symlink_target(relative, Path::new(target))
                        .map_err(|error| DeployError::InvalidManifest(error.to_string()))?;
                    validate_digest_option(&entry.sha256, &entry.path)?;
                }
            }
        }
        let actual_id = generation_id(&self.entries)?;
        if actual_id != self.generation_id {
            return Err(DeployError::InvalidManifest(
                "generationId does not match canonical manifest entries".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn verify_tree(&self, root: &Path) -> Result<()> {
        self.validate()?;
        let actual_entries = snapshot_entries(root, true)?;
        let actual: BTreeMap<&str, &ManifestEntry> = actual_entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let expected: BTreeMap<&str, &ManifestEntry> = self
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();

        for (path, actual_entry) in &actual {
            let Some(expected_entry) = expected.get(path) else {
                return Err(DeployError::UnmanifestedPath(root.join(path)));
            };
            let full_path = root.join(path);
            if actual_entry.kind != expected_entry.kind {
                return Err(DeployError::TypeMismatch(full_path));
            }
            if actual_entry.mode != expected_entry.mode {
                return Err(DeployError::ModeMismatch {
                    path: full_path,
                    expected: expected_entry.mode,
                    actual: actual_entry.mode,
                });
            }
            if actual_entry.symlink_target != expected_entry.symlink_target {
                return Err(DeployError::SymlinkTargetMismatch(full_path));
            }
            if actual_entry.sha256 != expected_entry.sha256 {
                return Err(DeployError::DigestMismatch {
                    path: full_path,
                    expected: expected_entry.sha256.clone().unwrap_or_default(),
                    actual: actual_entry.sha256.clone().unwrap_or_default(),
                });
            }
        }
        for path in expected.keys() {
            if !actual.contains_key(path) {
                return Err(DeployError::TypeMismatch(root.join(path)));
            }
        }
        Ok(())
    }
}

pub(crate) fn snapshot_tree_entries(root: &Path) -> Result<Vec<ManifestEntry>> {
    snapshot_entries(root, false)
}

fn snapshot_entries(root: &Path, skip_authoritative_manifest: bool) -> Result<Vec<ManifestEntry>> {
    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries, skip_authoritative_manifest)?;
    entries.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    Ok(entries)
}

fn validate_digest_option(digest: &Option<String>, path: &str) -> Result<()> {
    let digest = digest.as_deref().ok_or_else(|| {
        DeployError::InvalidManifest(format!("entry {path} has no SHA-256 digest"))
    })?;
    validate_digest(digest, path)
}

fn validate_digest(digest: &str, field: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(DeployError::InvalidManifest(format!(
            "{field} must be lowercase SHA-256 hex"
        )));
    }
    Ok(())
}

fn generation_id(entries: &[ManifestEntry]) -> Result<String> {
    let bytes = serde_json::to_vec(&ManifestIdentity {
        schema_version: SCHEMA_VERSION,
        entries,
    })
    .map_err(|error| DeployError::InvalidManifest(error.to_string()))?;
    Ok(sha256_bytes(&bytes))
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    sha256_reader(&mut file)
}

pub(crate) fn sha256_reader(reader: &mut impl Read) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn collect_entries(
    root: &Path,
    directory: &Path,
    output: &mut Vec<ManifestEntry>,
    skip_authoritative_manifest: bool,
) -> Result<()> {
    let mut children = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name().as_bytes().to_vec());
    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| DeployError::UnsafeRelativePath(path.clone()))?;
        if skip_authoritative_manifest && relative == Path::new(MANIFEST_FILE_NAME) {
            continue;
        }
        validate_relative_path(relative, false)?;
        let relative_string = relative
            .to_str()
            .ok_or_else(|| DeployError::UnsafeRelativePath(relative.to_path_buf()))?
            .to_string();
        let metadata = fs::symlink_metadata(&path)?;
        let mode = metadata.mode() & 0o7777;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path)?;
            validate_symlink_target(relative, &target)?;
            let target_string = target
                .to_str()
                .ok_or_else(|| DeployError::UnsafeRelativePath(target.clone()))?
                .to_string();
            output.push(ManifestEntry {
                path: relative_string,
                kind: EntryKind::Symlink,
                mode,
                sha256: Some(sha256_bytes(target.as_os_str().as_bytes())),
                symlink_target: Some(target_string),
            });
        } else if metadata.is_dir() {
            output.push(ManifestEntry {
                path: relative_string,
                kind: EntryKind::Directory,
                mode,
                symlink_target: None,
                sha256: None,
            });
            collect_entries(root, &path, output, skip_authoritative_manifest)?;
        } else if metadata.is_file() {
            output.push(ManifestEntry {
                path: relative_string,
                kind: EntryKind::File,
                mode,
                symlink_target: None,
                sha256: Some(sha256_file(&path)?),
            });
        } else {
            return Err(DeployError::InvalidManifest(format!(
                "special files are not allowed: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn copy_regular_file(source: &Path, destination: &Path, mode: u32) -> Result<()> {
    let mut input = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(source)?;
    copy_open_file(&mut input, destination, mode)
}

pub(crate) fn copy_open_file(input: &mut File, destination: &Path, mode: u32) -> Result<()> {
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(destination)?;
    std::io::copy(input, &mut output)?;
    output.flush()?;
    output.set_permissions(fs::Permissions::from_mode(mode))?;
    output.sync_all()?;
    Ok(())
}
