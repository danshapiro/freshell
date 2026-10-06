//! Descriptor-owned placeholders in a verified soul volume, before mounting.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mountpoint {
    pub relative_path: String,
    pub directory: bool,
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
        collections::BTreeMap,
        os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    };
    let mut paths = BTreeMap::new();
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
    let result = (|| {
        for (relative, directory) in paths {
            let path = home.join(relative);
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
            }
            created.push(path);
        }
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
pub fn serve(home: &Path, socket: &Path) -> Result<(), &'static str> {
    use std::{
        io::{Read, Write},
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
    prepare(home, &selected)?;
    stream
        .write_all(b"ok")
        .map_err(|_| "provider mountpoint acknowledgement failed")
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
