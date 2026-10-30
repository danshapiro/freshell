//! Descriptor-owned placeholders in a verified soul volume, before mounting.
use serde::{Deserialize, Serialize};
use std::path::Path;

const RESOURCE_ROOTS: &str = ".freshell/provider-roots";
const RESOURCE_PLACEHOLDER_MANIFEST: &str = ".freshell/provider-resource-mountpoints.json";
const ORDINARY_PROJECTION_MANIFEST: &str = ".freshell-config-projection.json";
const MAX_PLACEHOLDER_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mountpoint {
    pub relative_path: String,
    pub directory: bool,
}

fn write_result(
    writer: &mut impl std::io::Write,
    result: Result<(), &'static str>,
) -> std::io::Result<()> {
    match result {
        Ok(()) => writer.write_all(b"ok"),
        Err(reason) => {
            writer.write_all(b"er")?;
            writer.write_all(&(reason.len() as u32).to_be_bytes())?;
            writer.write_all(reason.as_bytes())
        }
    }
}

#[cfg(unix)]
pub fn prepare(home: &Path, selected: &[Mountpoint]) -> Result<(), &'static str> {
    prepare_for_identity(home, selected, 65534, 0)
}
#[cfg(unix)]
fn prepare_for_identity(
    home: &Path,
    selected: &[Mountpoint],
    uid: u32,
    gid: u32,
) -> Result<(), &'static str> {
    use std::{
        collections::{BTreeMap, BTreeSet},
        os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    };
    let mut paths = BTreeMap::new();
    let mut current_resource_files = BTreeSet::new();
    let mut bytes = 0usize;
    for entry in selected {
        let relative = Path::new(&entry.relative_path);
        if relative.as_os_str().is_empty()
            || relative.components().count() > 64
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("provider mountpoint must be a bounded normal relative path");
        }
        for parent in relative
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .filter(|path| !path.as_os_str().is_empty())
        {
            if paths.insert(parent.to_owned(), true) == Some(false) {
                return Err("provider file mountpoint masks a parent directory");
            }
        }
        if paths
            .insert(relative.to_owned(), entry.directory)
            .is_some_and(|prior| prior != entry.directory)
        {
            return Err("provider mountpoint kinds conflict");
        }
        if !entry.directory
            && relative.starts_with(RESOURCE_ROOTS)
            && relative.components().count() > Path::new(RESOURCE_ROOTS).components().count()
        {
            current_resource_files.insert(relative.to_owned());
        }
        if paths.len() > 100_000 {
            return Err("provider mountpoint entry profile exceeded");
        }
        bytes = bytes
            .checked_add(entry.relative_path.len())
            .ok_or("provider mountpoint metadata overflow")?;
        if bytes > 64 * 1024 * 1024 {
            return Err("provider mountpoint metadata profile exceeded");
        }
    }
    if paths.insert(Path::new(".freshell").to_owned(), true) == Some(false) {
        return Err("provider mountpoint kinds conflict");
    }
    let metadata =
        std::fs::symlink_metadata(home).map_err(|_| "provider HOME mountpoint unavailable")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || std::fs::canonicalize(home).map_err(|_| "provider HOME mountpoint unavailable")? != home
    {
        return Err("provider HOME mountpoint must be physical");
    }
    let initial = metadata.uid() == 0 && metadata.gid() == 0 && uid != 0;
    if initial {
        if std::fs::read_dir(home)
            .map_err(|_| "initial provider HOME unreadable")?
            .next()
            .is_some()
        {
            return Err("initial provider HOME must be empty before ownership transfer");
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "initial provider HOME mode setup failed")?;
    } else if metadata.uid() != uid || metadata.gid() != gid {
        return Err("provider HOME ownership changed");
    }
    let previous_resource_files = read_resource_placeholder_manifest(home, uid, gid)?;
    let mut ordinary_projection = None;
    let mut retired = Vec::new();
    for relative in previous_resource_files.difference(&current_resource_files) {
        verify_owned_physical_parents(home, relative, uid, gid)?;
        match std::fs::symlink_metadata(home.join(relative)) {
            Ok(metadata)
                if !metadata.file_type().is_symlink()
                    && metadata.is_file()
                    && metadata.uid() == uid
                    && metadata.gid() == gid
                    && metadata.len() == 0 => retired.push(relative.clone()),
            Ok(metadata)
                if !metadata.file_type().is_symlink()
                    && metadata.is_file()
                    && metadata.uid() == uid
                    && metadata.gid() == gid => {
                if ordinary_projection.is_none() {
                    ordinary_projection = Some(read_ordinary_projection_manifest(home, uid, gid)?);
                }
                if ordinary_projection
                    .as_ref()
                    .is_some_and(|paths| paths.contains(relative))
                {
                    // Ordinary refresh populated this placeholder. Preserve its
                    // bytes and inode until the replacement's existing projection
                    // transaction retires the old managed leaf after mounting.
                    continue;
                }
                return Err(
                    "retired provider resource mountpoint is not empty; retain inputs and reprepare",
                )
            }
            Ok(_) => {
                return Err(
                    "retired provider resource mountpoint kind or ownership changed; retain inputs and reprepare",
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("retired provider resource mountpoint inspection failed"),
        }
    }
    // Inspection precedes every mutation, so a conflicting retained leaf never
    // causes a partially populated preparation or ownership adoption.
    for (relative, directory) in &paths {
        match std::fs::symlink_metadata(home.join(relative)) {
            Ok(metadata)
                if !metadata.file_type().is_symlink()
                    && metadata.uid() == uid
                    && metadata.gid() == gid
                    && if *directory {
                        metadata.is_dir()
                    } else {
                        metadata.is_file()
                    } => {}
            Ok(_) => return Err("retained provider mountpoint kind or ownership changed"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("retained provider mountpoint inspection failed"),
        }
    }
    let mut created = Vec::new();
    let mut created_resource_files = BTreeSet::new();
    let result = (|| {
        for (relative, directory) in paths {
            let path = home.join(&relative);
            if std::fs::symlink_metadata(&path).is_ok() {
                continue;
            }
            if directory {
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&path)
                    .map_err(|_| "provider directory mountpoint creation failed")?;
            } else {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&path)
                    .map_err(|_| "provider file mountpoint creation failed")?;
                if !directory
                    && Path::new(&relative).starts_with(RESOURCE_ROOTS)
                    && Path::new(&relative).components().count()
                        > Path::new(RESOURCE_ROOTS).components().count()
                {
                    created_resource_files.insert(relative.clone());
                }
            }
            created.push(path);
        }
        for relative in &retired {
            let path = home.join(relative);
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|_| "retired provider resource mountpoint changed during preparation")?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.uid() != uid
                || metadata.gid() != gid
                || metadata.len() != 0
            {
                return Err("retired provider resource mountpoint changed during preparation");
            }
            std::fs::remove_file(&path)
                .map_err(|_| "retired provider resource mountpoint removal failed")?;
        }
        let retained_resource_files = previous_resource_files
            .intersection(&current_resource_files)
            .cloned()
            .chain(created_resource_files.iter().cloned())
            .collect::<BTreeSet<_>>();
        // The fixed helper intentionally has CHOWN but not DAC_OVERRIDE. Write
        // the manifest while it can still traverse a root-owned initial HOME;
        // transferring HOME ownership first makes mode-0700 directories
        // inaccessible to the helper's still-root identity.
        write_resource_placeholder_manifest(home, &retained_resource_files, uid, gid, initial)?;
        for path in created
            .iter()
            .rev()
            .chain(initial.then_some(home.to_owned()).as_ref())
        {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::CString::new(path.as_os_str().as_bytes())
                .map_err(|_| "provider mountpoint path invalid")?;
            if unsafe { libc::lchown(name.as_ptr(), uid, gid) } != 0 {
                return Err("provider mountpoint ownership transfer failed");
            }
        }
        Ok(())
    })();
    if result.is_err() {
        for path in created.iter().rev() {
            if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                let _ = std::fs::remove_dir(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    result
}

#[cfg(unix)]
fn read_ordinary_projection_manifest(
    home: &Path,
    uid: u32,
    gid: u32,
) -> Result<std::collections::BTreeSet<std::path::PathBuf>, &'static str> {
    use std::os::unix::fs::MetadataExt;
    let path = home.join(ORDINARY_PROJECTION_MANIFEST);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err("provider ordinary projection metadata unavailable"),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != uid
        || metadata.gid() != gid
        || metadata.len() > MAX_PLACEHOLDER_MANIFEST_BYTES
    {
        return Err("provider ordinary projection metadata changed or exceeds its profile");
    }
    let bytes =
        std::fs::read(path).map_err(|_| "provider ordinary projection metadata unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "provider ordinary projection metadata invalid")
}

#[cfg(unix)]
fn read_resource_placeholder_manifest(
    home: &Path,
    uid: u32,
    gid: u32,
) -> Result<std::collections::BTreeSet<std::path::PathBuf>, &'static str> {
    use std::os::unix::fs::MetadataExt;
    let path = home.join(RESOURCE_PLACEHOLDER_MANIFEST);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err("provider resource mountpoint metadata unavailable"),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != uid
        || metadata.gid() != gid
        || metadata.len() > MAX_PLACEHOLDER_MANIFEST_BYTES
    {
        return Err("provider resource mountpoint metadata changed or exceeds its profile");
    }
    let bytes =
        std::fs::read(&path).map_err(|_| "provider resource mountpoint metadata unavailable")?;
    let entries: Vec<String> = serde_json::from_slice(&bytes)
        .map_err(|_| "provider resource mountpoint metadata invalid")?;
    let mut result = std::collections::BTreeSet::new();
    for entry in entries {
        let relative = std::path::PathBuf::from(&entry);
        if relative.as_os_str().is_empty()
            || !relative.starts_with(RESOURCE_ROOTS)
            || relative.components().count()
                <= std::path::Path::new(RESOURCE_ROOTS).components().count()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
            || !result.insert(relative)
        {
            return Err("provider resource mountpoint metadata invalid");
        }
    }
    Ok(result)
}

#[cfg(unix)]
fn verify_owned_physical_parents(
    home: &Path,
    relative: &Path,
    uid: u32,
    gid: u32,
) -> Result<(), &'static str> {
    use std::os::unix::fs::MetadataExt;
    let mut parent = home.to_owned();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        parent.push(component.as_os_str());
        match std::fs::symlink_metadata(&parent) {
            Ok(metadata)
                if !metadata.file_type().is_symlink()
                    && metadata.is_dir()
                    && metadata.uid() == uid
                    && metadata.gid() == gid => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            _ => return Err("retired provider resource mountpoint parent changed"),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn write_resource_placeholder_manifest(
    home: &Path,
    entries: &std::collections::BTreeSet<std::path::PathBuf>,
    uid: u32,
    gid: u32,
    allow_initial_root_parent: bool,
) -> Result<(), &'static str> {
    use std::{
        io::Write,
        os::unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let serialized = entries
        .iter()
        .map(|entry| {
            entry
                .to_str()
                .ok_or("provider resource mountpoint metadata invalid")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let bytes = serde_json::to_vec(&serialized)
        .map_err(|_| "provider resource mountpoint metadata serialization failed")?;
    if bytes.len() as u64 > MAX_PLACEHOLDER_MANIFEST_BYTES {
        return Err("provider resource mountpoint metadata profile exceeded");
    }
    let parent = home.join(".freshell");
    let parent_metadata =
        std::fs::symlink_metadata(&parent).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                "provider resource mountpoint metadata parent missing after preparation"
            }
            std::io::ErrorKind::PermissionDenied => {
                "provider resource mountpoint metadata parent inaccessible"
            }
            _ => "provider resource mountpoint metadata parent inspection failed",
        })?;
    let expected_owner = parent_metadata.uid() == uid && parent_metadata.gid() == gid;
    let initial_root_owner =
        allow_initial_root_parent && parent_metadata.uid() == 0 && parent_metadata.gid() == 0;
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || !(expected_owner || initial_root_owner)
    {
        return Err("provider resource mountpoint metadata parent changed");
    }
    let manifest = home.join(RESOURCE_PLACEHOLDER_MANIFEST);
    for _ in 0..8 {
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".provider-resource-mountpoints-{}-{sequence}.tmp",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
        {
            Ok(mut file) => {
                let result = (|| {
                    file.write_all(&bytes)
                        .map_err(|_| "provider resource mountpoint metadata write failed")?;
                    file.sync_all()
                        .map_err(|_| "provider resource mountpoint metadata sync failed")?;
                    std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600))
                        .map_err(|_| "provider resource mountpoint metadata permissions failed")?;
                    let name = std::ffi::CString::new(candidate.as_os_str().as_bytes())
                        .map_err(|_| "provider resource mountpoint metadata path invalid")?;
                    if unsafe { libc::lchown(name.as_ptr(), uid, gid) } != 0 {
                        return Err("provider resource mountpoint metadata ownership failed");
                    }
                    std::fs::rename(&candidate, &manifest)
                        .map_err(|_| "provider resource mountpoint metadata publish failed")?;
                    std::fs::File::open(&parent)
                        .and_then(|directory| directory.sync_all())
                        .map_err(|_| "provider resource mountpoint metadata parent sync failed")?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = std::fs::remove_file(&candidate);
                }
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("provider resource mountpoint metadata temporary unavailable"),
        }
    }
    Err("provider resource mountpoint metadata temporary unavailable")
}

#[cfg(unix)]
pub fn serve(home: &Path, socket: &Path) -> Result<(), &'static str> {
    use std::{
        io::Read,
        os::unix::{fs::MetadataExt, net::UnixStream},
    };
    let root =
        std::fs::symlink_metadata(home).map_err(|_| "provider mountpoint HOME unavailable")?;
    // The retained provider identity performs its own writes. The initial
    // empty volume is the only root-owned inode this helper may transfer.
    if root.uid() == 65534
        && root.gid() == 0
        && (unsafe { libc::setgroups(0, std::ptr::null()) } != 0
            || unsafe { libc::setgid(0) } != 0
            || unsafe { libc::setuid(65534) } != 0)
    {
        return Err("provider mountpoint identity transition failed");
    }
    let mut stream =
        UnixStream::connect(socket).map_err(|_| "provider mountpoint exchange unavailable")?;
    let timeout = Some(std::time::Duration::from_secs(20));
    stream
        .set_read_timeout(timeout)
        .map_err(|_| "provider mountpoint timeout setup failed")?;
    stream
        .set_write_timeout(timeout)
        .map_err(|_| "provider mountpoint timeout setup failed")?;
    let mut length = [0; 4];
    stream
        .read_exact(&mut length)
        .map_err(|_| "provider mountpoint request unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length > 1024 * 1024 {
        return Err("provider mountpoint control metadata profile exceeded");
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .map_err(|_| "provider mountpoint request incomplete")?;
    let selected: Vec<Mountpoint> =
        serde_json::from_slice(&bytes).map_err(|_| "provider mountpoint metadata invalid")?;
    let prepared = prepare(home, &selected);
    write_result(&mut stream, prepared)
        .map_err(|_| "provider mountpoint acknowledgement failed")?;
    prepared
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn provider_mountpoints_create_physical_files_and_preserve_existing_inodes() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let selected = vec![
            Mountpoint {
                relative_path: ".config/opencode/opencode.json".into(),
                directory: false,
            },
            Mountpoint {
                relative_path: ".freshell/provider-roots/plugin-0".into(),
                directory: true,
            },
        ];
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        prepare_for_identity(&home, &selected, uid, gid).unwrap();
        let file = home.join(&selected[0].relative_path);
        let root = home.join(&selected[1].relative_path);
        let metadata = std::fs::symlink_metadata(&file)
            .expect("the file mountpoint must exist before Docker create");
        assert!(metadata.is_file());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!((metadata.uid(), metadata.gid()), (uid, gid));
        assert!(std::fs::symlink_metadata(&root).unwrap().is_dir());
        std::fs::write(&file, "retained-owned-file").unwrap();
        let inode = metadata.ino();
        prepare_for_identity(&home, &selected, uid, gid).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "retained-owned-file"
        );
    }

    #[test]
    fn provider_mountpoints_create_a_file_target_inside_a_selected_directory() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let selected = [
            Mountpoint {
                relative_path: ".freshell/provider-roots/directory".into(),
                directory: true,
            },
            Mountpoint {
                relative_path: ".freshell/provider-roots/state/source".into(),
                directory: false,
            },
            Mountpoint {
                relative_path: "mcp".into(),
                directory: true,
            },
            Mountpoint {
                relative_path: "mcp/state.json".into(),
                directory: false,
            },
        ];
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };

        prepare_for_identity(&home, &selected, uid, gid).unwrap();

        assert!(home.join(".freshell/provider-roots/directory").is_dir());
        assert!(home.join(".freshell/provider-roots/state/source").is_file());
        assert!(home.join("mcp").is_dir());
        assert!(home.join("mcp/state.json").is_file());
    }

    #[test]
    fn provider_mountpoints_remove_only_retired_empty_resource_placeholders() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let root = ".freshell/provider-roots/project";
        let file = format!("{root}/opencode.json");
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        prepare_for_identity(
            &home,
            &[
                Mountpoint {
                    relative_path: root.into(),
                    directory: true,
                },
                Mountpoint {
                    relative_path: file.clone(),
                    directory: false,
                },
            ],
            uid,
            gid,
        )
        .unwrap();
        let placeholder = home.join(&file);
        let unrelated_empty = home.join(root).join("user-empty.json");
        std::fs::write(&unrelated_empty, b"").unwrap();
        assert_eq!(std::fs::metadata(&placeholder).unwrap().len(), 0);

        prepare_for_identity(&home, &[], uid, gid).unwrap();
        assert!(!placeholder.exists());
        assert!(unrelated_empty.exists());
        assert!(home.join(root).is_dir());

        prepare_for_identity(
            &home,
            &[
                Mountpoint {
                    relative_path: root.into(),
                    directory: true,
                },
                Mountpoint {
                    relative_path: file.clone(),
                    directory: false,
                },
            ],
            uid,
            gid,
        )
        .unwrap();
        std::fs::write(&placeholder, b"provider-owned").unwrap();
        let error = prepare_for_identity(
            &home,
            &[Mountpoint {
                relative_path: root.into(),
                directory: true,
            }],
            uid,
            gid,
        )
        .expect_err("retirement must not delete nonempty provider data");
        assert!(error.contains("not empty"));
        assert_eq!(std::fs::read(&placeholder).unwrap(), b"provider-owned");
    }

    #[test]
    fn provider_mountpoints_preserve_populated_retired_ordinary_files_for_refresh() {
        use std::os::unix::fs::MetadataExt;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        let old = Mountpoint {
            relative_path: ".freshell/provider-roots/prior/source".into(),
            directory: false,
        };
        prepare_for_identity(&home, std::slice::from_ref(&old), uid, gid).unwrap();
        let file = home.join(&old.relative_path);
        std::fs::write(&file, b"selected ordinary input").unwrap();
        let inode = file.metadata().unwrap().ino();
        let projection = serde_json::to_vec(&[&old.relative_path]).unwrap();
        std::fs::write(home.join(ORDINARY_PROJECTION_MANIFEST), &projection).unwrap();
        let current = Mountpoint {
            relative_path: ".freshell/provider-roots/current/source".into(),
            directory: false,
        };

        prepare_for_identity(&home, std::slice::from_ref(&current), uid, gid).unwrap();

        assert_eq!(std::fs::read(&file).unwrap(), b"selected ordinary input");
        assert_eq!(file.metadata().unwrap().ino(), inode);
        assert_eq!(
            std::fs::read(home.join(ORDINARY_PROJECTION_MANIFEST)).unwrap(),
            projection
        );
        assert_eq!(
            home.join(&current.relative_path).metadata().unwrap().len(),
            0
        );
    }

    #[test]
    fn provider_mountpoints_refuse_untracked_or_invalid_retired_projection_files() {
        use std::os::unix::fs::{symlink, MetadataExt};
        for invalid in [
            "untracked",
            "invalid-json",
            "manifest-directory",
            "manifest-symlink",
            "file-directory",
            "file-symlink",
        ] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            std::fs::create_dir(&home).unwrap();
            let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
            let old = Mountpoint {
                relative_path: ".freshell/provider-roots/prior/source".into(),
                directory: false,
            };
            prepare_for_identity(&home, std::slice::from_ref(&old), uid, gid).unwrap();
            let file = home.join(&old.relative_path);
            std::fs::write(&file, b"retained provider input").unwrap();
            let before = std::fs::read(home.join(RESOURCE_PLACEHOLDER_MANIFEST)).unwrap();
            let manifest = home.join(ORDINARY_PROJECTION_MANIFEST);
            let projection = serde_json::to_vec(&[&old.relative_path]).unwrap();
            match invalid {
                "untracked" => std::fs::write(&manifest, b"[]").unwrap(),
                "invalid-json" => std::fs::write(&manifest, b"not-json").unwrap(),
                "manifest-directory" => std::fs::create_dir(&manifest).unwrap(),
                "manifest-symlink" => {
                    std::fs::write(home.join("other-manifest"), &projection).unwrap();
                    symlink("other-manifest", &manifest).unwrap();
                }
                kind => {
                    std::fs::write(&manifest, &projection).unwrap();
                    std::fs::remove_file(&file).unwrap();
                    if kind == "file-directory" {
                        std::fs::create_dir(&file).unwrap();
                    } else {
                        std::fs::write(home.join("other-input"), b"retained provider input")
                            .unwrap();
                        symlink(home.join("other-input"), &file).unwrap();
                    }
                }
            }
            let metadata = std::fs::symlink_metadata(&file).unwrap();
            let current = Mountpoint {
                relative_path: ".freshell/provider-roots/current/source".into(),
                directory: false,
            };

            assert!(
                prepare_for_identity(&home, std::slice::from_ref(&current), uid, gid).is_err(),
                "{invalid}"
            );

            assert_eq!(
                std::fs::symlink_metadata(&file).unwrap().ino(),
                metadata.ino(),
                "{invalid}"
            );
            assert_eq!(
                std::fs::read(home.join(RESOURCE_PLACEHOLDER_MANIFEST)).unwrap(),
                before,
                "{invalid}"
            );
            assert!(!home.join(&current.relative_path).exists(), "{invalid}");
            if !metadata.is_dir() {
                assert_eq!(
                    std::fs::read(&file).unwrap(),
                    b"retained provider input",
                    "{invalid}"
                );
            }
        }
    }

    #[test]
    fn provider_mountpoint_failure_acknowledgement_carries_its_static_reason() {
        let mut encoded = Vec::new();
        write_result(&mut encoded, Err("preparation refused safely")).unwrap();
        assert_eq!(&encoded[..2], b"er");
        let length = u32::from_be_bytes(encoded[2..6].try_into().unwrap()) as usize;
        assert_eq!(length, encoded.len() - 6);
        assert_eq!(
            std::str::from_utf8(&encoded[6..]).unwrap(),
            "preparation refused safely"
        );
    }

    #[test]
    fn provider_mountpoints_refuse_symlink_parents_before_creating_other_paths() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let outside = owned.path().join("outside");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("kept"), "outside-original").unwrap();
        std::os::unix::fs::symlink(&outside, home.join("link")).unwrap();
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        let selected = [
            Mountpoint {
                relative_path: "aaa/new-file".into(),
                directory: false,
            },
            Mountpoint {
                relative_path: "link/kept".into(),
                directory: false,
            },
        ];
        assert!(prepare_for_identity(&home, &selected, uid, gid).is_err());
        assert!(!home.join("aaa").exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("kept")).unwrap(),
            "outside-original"
        );
        assert!(std::fs::symlink_metadata(home.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        for relative in ["../escape", "/outside", "", "a/../../escape"] {
            assert!(prepare_for_identity(
                &home,
                &[Mountpoint {
                    relative_path: relative.into(),
                    directory: false
                }],
                uid,
                gid
            )
            .is_err());
        }
    }

    #[test]
    fn provider_mountpoints_refuse_file_directory_collisions_without_overwrite() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        std::fs::write(home.join("retained"), "kept").unwrap();
        assert!(prepare_for_identity(
            &home,
            &[Mountpoint {
                relative_path: "retained/child".into(),
                directory: false
            }],
            uid,
            gid
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(home.join("retained")).unwrap(),
            "kept"
        );
        assert!(prepare_for_identity(
            &home,
            &[
                Mountpoint {
                    relative_path: "file".into(),
                    directory: false
                },
                Mountpoint {
                    relative_path: "file/child".into(),
                    directory: false
                }
            ],
            uid,
            gid
        )
        .is_err());
        assert!(!home.join("file").exists());
    }
}
