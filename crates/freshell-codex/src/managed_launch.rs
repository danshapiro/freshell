//! Final exec accounting for the one immutable managed Codex launcher.
use freshell_platform::provider_exec::{check_final_exec, process_profile, Profile};
use serde::Deserialize;
use std::{collections::BTreeMap, io::Read, path::Path, process::Command};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    version: String,
    layout_file: String,
    launch_wrapper: String,
    node_executable: String,
    npm_wrapper: String,
    package_root: String,
    helper_directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layout {
    version: String,
    launch_wrapper: String,
    node_executable: String,
    npm_wrapper: String,
    package_root: String,
    helper_directory: String,
    native_executable: String,
}

fn identity() -> Result<Identity, String> {
    let resource: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docker/runtime/codex-native-sandbox.json"
    ))
    .map_err(|_| "Codex managed launch resource is invalid")?;
    serde_json::from_value(resource["native"].clone())
        .map_err(|_| "Codex managed launch identity is incomplete".into())
}

/// Keep explicit custom executables; the managed default uses its owned launcher.
pub fn managed_program(program: &str) -> Result<String, String> {
    let identity = identity()?;
    Ok(if program == "codex" || program == identity.npm_wrapper {
        identity.launch_wrapper
    } else {
        program.to_owned()
    })
}

fn read_layout(identity: &Identity) -> Result<Layout, String> {
    const LIMIT: u64 = 16 * 1024;
    let file = std::fs::File::open(&identity.layout_file)
        .map_err(|_| "Codex managed launch layout is missing; rebuild the pinned workload image")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Codex managed layout is unreadable")?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err("Codex managed layout exceeds its finite profile".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Codex managed layout is unreadable")?;
    if bytes.len() as u64 > LIMIT {
        return Err("Codex managed layout changed during its read".into());
    }
    let layout: Layout =
        serde_json::from_slice(&bytes).map_err(|_| "Codex managed layout is invalid")?;
    if layout.version != identity.version
        || layout.launch_wrapper != identity.launch_wrapper
        || layout.node_executable != identity.node_executable
        || layout.npm_wrapper != identity.npm_wrapper
        || layout.package_root != identity.package_root
        || layout.helper_directory != identity.helper_directory
        || !Path::new(&layout.native_executable).is_absolute()
    {
        return Err("Codex managed layout is incompatible with this server".into());
    }
    Ok(layout)
}

fn managed_environment(
    layout: &Layout,
    environment: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut child = environment.clone();
    let current = child.get("PATH").cloned().unwrap_or_default();
    let prefix = format!("{}:", layout.helper_directory);
    if current != layout.helper_directory && !current.starts_with(&prefix) {
        child.insert(
            "PATH".into(),
            if current.is_empty() {
                layout.helper_directory.clone()
            } else {
                format!("{prefix}{current}")
            },
        );
    }
    for name in [
        "CODEX_MANAGED_BY_NPM",
        "CODEX_MANAGED_BY_BUN",
        "CODEX_MANAGED_BY_PNPM",
        "CODEX_MANAGED_BY_VITE_PLUS",
        "npm_config_user_agent",
        "npm_execpath",
    ] {
        child.remove(name);
    }
    child.insert(
        "CODEX_MANAGED_PACKAGE_ROOT".into(),
        layout.package_root.clone(),
    );
    child.insert("CODEX_MANAGED_BY_NPM".into(), "1".into());
    child
}

fn check_managed_stages(
    layout: &Layout,
    args: &[String],
    environment: &BTreeMap<String, String>,
    profile: Profile,
) -> Result<(), String> {
    let environment = managed_environment(layout, environment);
    let node_args = std::iter::once(layout.npm_wrapper.clone())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    // The fixed Node executable reads the npm JS file as an argument; its
    // shebang is not another exec. The npm child then execs native directly.
    check_final_exec(
        &layout.node_executable,
        &node_args,
        &environment,
        &[],
        profile,
    )
    .map_err(|error| error.to_string())?;
    check_final_exec(&layout.native_executable, args, &environment, &[], profile)
        .map_err(|error| error.to_string())
}

/// Check the original context and the exact later Node/npm/native stages.
pub fn check_launch(
    program: &str,
    args: &[String],
    environment: &BTreeMap<String, String>,
) -> Result<(), String> {
    let profile = process_profile().map_err(|error| error.to_string())?;
    let boundary = (program == "/usr/bin/setpriv")
        .then(|| args.iter().position(|arg| arg == "--"))
        .flatten();
    let (target, provider_args) = if let Some(boundary) = boundary {
        (
            args.get(boundary + 1)
                .ok_or("Codex identity drop has no provider executable")?
                .as_str(),
            &args[boundary + 2..],
        )
    } else {
        (program, args)
    };
    let additional = if boundary.is_some() {
        vec![target]
    } else {
        vec![]
    };
    check_final_exec(program, args, environment, &additional, profile)
        .map_err(|error| error.to_string())?;
    let identity = identity()?;
    if target != identity.launch_wrapper {
        return Ok(());
    }
    check_managed_stages(
        &read_layout(&identity)?,
        provider_args,
        environment,
        profile,
    )
}

pub fn check_command(command: &Command) -> Result<(), String> {
    let mut environment = std::env::vars_os()
        .map(|(name, value)| {
            Ok((
                name.into_string()
                    .map_err(|_| "provider exec profile String")?,
                value
                    .into_string()
                    .map_err(|_| "provider exec profile String")?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    for (name, value) in command.get_envs() {
        let name = name.to_str().ok_or("provider exec profile String")?;
        match value {
            Some(value) => {
                environment.insert(
                    name.into(),
                    value.to_str().ok_or("provider exec profile String")?.into(),
                );
            }
            None => {
                environment.remove(name);
            }
        }
    }
    let args = command
        .get_args()
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or("provider exec profile String".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    check_launch(
        command
            .get_program()
            .to_str()
            .ok_or("provider exec profile Executable")?,
        &args,
        &environment,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_helper_prefix_is_accounted_before_dispatch_at_actual_kernel_boundary() {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let marker = owned.path().join("dispatched");
        let script = owned.path().join("entry.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\nprintf dispatched > '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let layout = Layout {
            version: "fixture".into(),
            launch_wrapper: script.to_str().unwrap().into(),
            node_executable: "/bin/sh".into(),
            npm_wrapper: script.to_str().unwrap().into(),
            package_root: owned.path().to_str().unwrap().into(),
            helper_directory: owned.path().join("helpers").to_str().unwrap().into(),
            native_executable: "/usr/bin/true".into(),
        };
        let profile = process_profile().unwrap();
        let environment = BTreeMap::from([(
            "PATH".into(),
            "x".repeat(profile.page_bytes * 32 - "PATH=".len() - 1),
        )]);
        check_final_exec(
            "/bin/sh",
            std::slice::from_ref(&layout.npm_wrapper),
            &environment,
            &[],
            profile,
        )
        .expect("initial environment must fit before the wrapper changes PATH");
        let checked = check_managed_stages(&layout, &[], &environment, profile);
        assert!(
            matches!(checked, Err(ref error) if error.contains("String")),
            "final helper PATH must refuse before dispatch: {checked:?}"
        );
        let expanded = format!("{}:{}", layout.helper_directory, environment["PATH"]);
        let error = Command::new("/bin/sh")
            .arg(&script)
            .env_clear()
            .env("PATH", expanded)
            .spawn()
            .expect_err("actual Linux kernel must reject the final oversized PATH");
        assert_eq!(error.raw_os_error(), Some(libc::E2BIG));
        assert!(!marker.exists());
        let small = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        check_managed_stages(&layout, &[], &small, profile).unwrap();
        assert!(Command::new("/bin/sh")
            .arg(&script)
            .env_clear()
            .envs(small)
            .status()
            .unwrap()
            .success());
        assert!(marker.is_file());
    }
}
