//! Claude's finite native Git-source selector. This does not share the more
//! forgiving Git metadata resolver used for presentation and workspaces.
use super::NativeSourceRuntime;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Roots {
    pub checkout: PathBuf,
    pub canonical: PathBuf,
}

pub fn roots(cwd: &Path, runtime: NativeSourceRuntime) -> Result<Option<Roots>, String> {
    let cwd = lexical(cwd);
    let Some(checkout) = cwd.ancestors().find(|base| candidate(base, runtime)) else {
        return Ok(None);
    };
    let canonical = linked_root(checkout, runtime)?.unwrap_or_else(|| checkout.into());
    Ok(Some(Roots {
        checkout: checkout.into(),
        canonical,
    }))
}

fn candidate(base: &Path, runtime: NativeSourceRuntime) -> bool {
    let marker = base.join(".git");
    match kind(&marker) {
        Kind::File | Kind::Directory => true,
        Kind::Link => std::fs::read_link(&marker).ok().is_some_and(|target| {
            target.to_str().is_some_and(|raw| {
                !raw.contains('\0')
                    && !unsafe_pointer(raw, base, base, runtime)
                    && std::fs::metadata(&marker).is_ok_and(|m| m.is_file() || m.is_dir())
            })
        }),
        _ => false,
    }
}

fn linked_root(checkout: &Path, runtime: NativeSourceRuntime) -> Result<Option<PathBuf>, String> {
    let Some(marker) = read_pointer(&checkout.join(".git"))? else {
        return Ok(None);
    };
    let Some(pointer) = native_trim(&marker).strip_prefix("gitdir:") else {
        return Ok(None);
    };
    let pointer = native_trim(pointer);
    if unsafe_pointer(pointer, checkout, checkout, runtime) {
        return Ok(None);
    }
    let gitdir = resolve(checkout, pointer);
    let common_file = gitdir.join("commondir");
    if suspect_file(&common_file, &gitdir, runtime) {
        return Ok(None);
    }
    let Some(common) = read_pointer(&common_file)? else {
        return Ok(None);
    };
    let common = native_trim(&common);
    if unsafe_pointer(common, &gitdir, &gitdir, runtime) {
        return Ok(None);
    }
    let common = resolve(&gitdir, common);
    if gitdir.parent().map(lexical) != Some(common.join("worktrees")) {
        return Ok(None);
    }
    let backlink_file = gitdir.join("gitdir");
    if suspect_file(&backlink_file, &gitdir, runtime) {
        return Ok(None);
    }
    let Some(backlink) = read_pointer(&backlink_file)? else {
        return Ok(None);
    };
    let backlink = native_trim(&backlink);
    if unsafe_network(backlink, checkout, runtime)
        || unsafe_traversal(backlink, &gitdir, checkout, runtime)
    {
        return Ok(None);
    }
    let Ok(backlink) = std::fs::canonicalize(resolve(&gitdir, backlink)) else {
        return Ok(None);
    };
    let Ok(real_checkout) = std::fs::canonicalize(checkout) else {
        return Ok(None);
    };
    if backlink != real_checkout.join(".git") {
        return Ok(None);
    }
    Ok(Some(
        if common.file_name().is_some_and(|name| name == ".git") {
            common.parent().unwrap_or(&common).into()
        } else {
            common
        },
    ))
}

fn read_pointer(path: &Path) -> Result<Option<String>, String> {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return Ok(None);
    };
    let limit = crate::provider_input_profiles::MAX_SOURCE_VIEW_BYTES;
    let Ok(metadata) = file.metadata() else {
        return Ok(None);
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    let over_limit = || {
        format!(
            "Claude Git selection metadata {} exceeds the 16 MiB source-view profile; retain inputs and reduce the selected metadata",
            path.display()
        )
    };
    if metadata.len() > limit {
        return Err(over_limit());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(metadata.len() as usize)
        .map_err(|_| over_limit())?;
    let mut chunk = [0; 8192];
    loop {
        let count = match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Ok(None),
        };
        if bytes.len() as u64 + count as u64 > limit {
            return Err(over_limit());
        }
        bytes.try_reserve_exact(count).map_err(|_| over_limit())?;
        bytes.extend_from_slice(&chunk[..count]);
    }
    let raw = match String::from_utf8(bytes) {
        Ok(raw) => raw,
        Err(error) => {
            let bytes = error.into_bytes();
            lossy_utf8_view(&bytes, limit).map_err(|_| over_limit())?
        }
    };
    if native_trim(&raw).len() > 64 * 1024 {
        return Err(format!(
            "Claude Git selection pointer {} exceeds the 64 KiB path profile; retain inputs and repair the selected metadata",
            path.display()
        ));
    }
    Ok(Some(raw))
}

// Both pinned native runtimes use String.trim: BOM is whitespace, NEL is not.
fn native_trim(raw: &str) -> &str {
    raw.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    })
}

// Native replacement groups are admitted before allocation. Reserve the exact
// output length so incremental replacement cannot double a view's capacity.
fn lossy_utf8_view(bytes: &[u8], limit: u64) -> Result<String, ()> {
    let length = bytes
        .utf8_chunks()
        .try_fold(0usize, |length, chunk| {
            length.checked_add(chunk.valid().len() + if chunk.invalid().is_empty() { 0 } else { 3 })
        })
        .filter(|length| *length as u64 <= limit)
        .ok_or(())?;
    let mut view = String::new();
    view.try_reserve_exact(length).map_err(|_| ())?;
    for chunk in bytes.utf8_chunks() {
        view.push_str(chunk.valid());
        if !chunk.invalid().is_empty() {
            view.push('\u{fffd}');
        }
    }
    Ok(view)
}

#[derive(PartialEq)]
enum Kind {
    File,
    Directory,
    Link,
    Absent,
    Other,
}
fn kind(path: &Path) -> Kind {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Kind::Link,
        Ok(m) if m.is_dir() => Kind::Directory,
        Ok(m) if m.is_file() => Kind::File,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Kind::Absent
        }
        _ => Kind::Other,
    }
}
fn suspect_file(path: &Path, base: &Path, runtime: NativeSourceRuntime) -> bool {
    !walk(path, base, 40, runtime) || matches!(kind(path), Kind::Link | Kind::Other)
}
fn unsafe_pointer(raw: &str, base: &Path, anchor: &Path, runtime: NativeSourceRuntime) -> bool {
    unsafe_network(raw, base, runtime) || unsafe_traversal(raw, base, anchor, runtime)
}
fn unsafe_traversal(raw: &str, base: &Path, anchor: &Path, runtime: NativeSourceRuntime) -> bool {
    let original = if raw.starts_with('/') {
        PathBuf::from(raw)
    } else {
        base.join(raw)
    };
    !walk(&original, anchor, 40, runtime) || !walk(&resolve(base, raw), anchor, 40, runtime)
}
fn walk(path: &Path, anchor: &Path, remaining: usize, runtime: NativeSourceRuntime) -> bool {
    if remaining == 0 {
        return false;
    }
    let Some(raw) = path.to_str() else {
        return false;
    };
    let parts = raw.split('/').collect::<Vec<_>>();
    let mut current = PathBuf::from("/");
    for (index, component) in parts.iter().enumerate() {
        match *component {
            "" | "." => continue,
            ".." => {
                current.pop();
                continue;
            }
            _ => current.push(component),
        }
        if network_host(&current, runtime)
            .is_some_and(|host| Some(host) != network_host(anchor, runtime))
        {
            return false;
        }
        match kind(&current) {
            Kind::Other => return false,
            Kind::Link => {
                let Ok(target) = std::fs::read_link(&current) else {
                    return false;
                };
                let Some(target) = target.to_str() else {
                    return false;
                };
                let parent = current.parent().unwrap_or(Path::new("/"));
                if target.contains('\0') || unsafe_network(target, parent, runtime) {
                    return false;
                }
                let mut continued = if target.starts_with('/') {
                    PathBuf::from(target)
                } else {
                    parent.join(target)
                };
                for component in &parts[index + 1..] {
                    continued.push(component);
                }
                return walk(&continued, anchor, remaining - 1, runtime);
            }
            _ => {}
        }
    }
    true
}

fn unsafe_network(raw: &str, base: &Path, runtime: NativeSourceRuntime) -> bool {
    [PathBuf::from(raw), resolve(base, raw)].iter().any(|path| {
        let Some(text) = path.to_str() else {
            return true;
        };
        let bytes = text.as_bytes();
        let slash = |byte: u8| byte == b'/' || byte == b'\\';
        let unc = bytes.len() >= 2 && slash(bytes[0]) && slash(bytes[1]);
        let device =
            bytes.len() >= 4 && slash(bytes[0]) && &bytes[1..3] == b"??" && slash(bytes[3]);
        let normalized_device = text.contains("??") && {
            let mut parts = Vec::new();
            for part in text.split(['/', '\\']) {
                match part {
                    "" | "." => {}
                    ".." => {
                        parts.pop();
                    }
                    _ => parts.push(part),
                }
            }
            bytes.first().copied().is_some_and(slash) && parts.first() == Some(&"??")
        };
        if device || normalized_device {
            return true;
        }
        if unc {
            let parts = text
                .split(['/', '\\'])
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>();
            if parts.iter().any(|part| matches!(*part, "." | ".."))
                || parts.first().is_none_or(|part| matches!(*part, "?" | "."))
                || unc_host(text) != base.to_str().and_then(unc_host)
            {
                return true;
            }
        }
        let normalized = lexical(path);
        if runtime == NativeSourceRuntime::Terminal {
            let lower = normalized.to_string_lossy().to_lowercase();
            let mut raw_components = Vec::new();
            let mut entered_network = false;
            if text.starts_with('/') {
                for component in text.split('/') {
                    match component {
                        "" | "." => continue,
                        ".." => {
                            raw_components.pop();
                        }
                        _ => {
                            raw_components.push(component);
                            if raw_components.len() == 1
                                && component.eq_ignore_ascii_case("network")
                            {
                                entered_network = true;
                                break;
                            }
                        }
                    }
                }
            }
            if lower == "/net" || entered_network {
                return true;
            }
        }
        network_host(&normalized, runtime)
            .is_some_and(|host| Some(host) != network_host(base, runtime))
    })
}
fn unc_host(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.len() < 2 || !bytes[..2].iter().all(|b| matches!(b, b'/' | b'\\')) {
        return None;
    }
    raw.split(['/', '\\'])
        .find(|part| !part.is_empty())
        .map(str::to_ascii_lowercase)
}
fn network_host(path: &Path, runtime: NativeSourceRuntime) -> Option<String> {
    let normalized = lexical(path);
    let mut parts = normalized.to_str()?.split('/').filter(|p| !p.is_empty());
    let first = parts.next()?;
    if first.eq_ignore_ascii_case("net") {
        return parts.next().map(str::to_ascii_lowercase);
    }
    if runtime == NativeSourceRuntime::Terminal
        && first.eq_ignore_ascii_case("network")
        && parts.next()?.eq_ignore_ascii_case("servers")
    {
        return parts.next().map(str::to_ascii_lowercase);
    }
    None
}
pub fn lexical(path: &Path) -> PathBuf {
    crate::opencode_config::lexical_path(path)
}
fn resolve(base: &Path, raw: &str) -> PathBuf {
    lexical(&if raw.starts_with('/') {
        PathBuf::from(raw)
    } else {
        base.join(raw)
    })
}

/// Native eager-memory containment is inclusive and case folded, even on
/// Linux. Its /private aliases are lexical, rather than filesystem realpaths.
pub fn contained(candidate: &Path, root: &Path) -> bool {
    let normalize = |path: &Path| {
        let mut value = lexical(path)
            .to_string_lossy()
            .to_lowercase()
            .replace('\u{0131}', "i")
            .replace('\u{017f}', "s");
        if value.starts_with("/private/var/") {
            value = value.replacen("/private/var/", "/var/", 1);
        }
        if value == "/private/tmp" || value.starts_with("/private/tmp/") {
            value = value.replacen("/private/tmp", "/tmp", 1);
        }
        PathBuf::from(value)
    };
    normalize(candidate)
        .strip_prefix(normalize(root))
        .is_ok_and(|relative| {
            !relative
                .to_string_lossy()
                .split(['/', '\\'])
                .any(|part| part == "..")
        })
}
