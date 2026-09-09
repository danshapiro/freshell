use std::{path::PathBuf, process::Command};

fn main() {
    let commit = run_git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = run_git_raw(&["status", "--porcelain"])
        .map(|output| (!output.trim().is_empty()).to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=FRESHELL_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=FRESHELL_BUILD_DIRTY={dirty}");
    for path in rerun_paths() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn run_git(args: &[&str]) -> Option<String> {
    run_git_raw(args).map(|output| output.trim().to_string())
}

fn run_git_raw(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn rerun_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for args in [
        vec!["rev-parse", "--git-path", "HEAD"],
        vec!["rev-parse", "--git-path", "index"],
        vec!["rev-parse", "--git-path", "packed-refs"],
    ] {
        if let Some(path) = run_git(&args) {
            let path = PathBuf::from(path);
            if path.exists() || args.last() == Some(&"HEAD") {
                paths.push(path);
            }
        }
    }
    if let Some(reference) = run_git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = run_git(&["rev-parse", "--git-path", &reference]) {
            paths.push(PathBuf::from(path));
        }
    }
    paths
}
