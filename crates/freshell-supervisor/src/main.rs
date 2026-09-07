use freshell_runtime_protocol::InstallationId;
use freshell_supervisor::{
    registry::Registry,
    service::{default_backend, serve_control, Supervisor, SupervisorConfig},
};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!(
            "{{\"event\":\"supervisor.fatal\",\"error\":{}}}",
            serde_json::to_string(&error).unwrap_or_else(|_| "\"unknown\"".into())
        );
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("serve") {
        return Err("usage: freshell-supervisor serve --registry-root PATH --control-socket PATH --control-secret-file PATH --docker-socket PATH --runtime-root PATH --host-binary PATH --image-ref sha256:... --test-run-id ID [--installation-id ID]".into());
    }
    let rest = &args[2..];
    let registry_root = PathBuf::from(required_arg(rest, "--registry-root")?);
    let control_socket = PathBuf::from(required_arg(rest, "--control-socket")?);
    let control_secret_file = PathBuf::from(required_arg(rest, "--control-secret-file")?);
    let docker_socket = PathBuf::from(required_arg(rest, "--docker-socket")?);
    let runtime_root = PathBuf::from(required_arg(rest, "--runtime-root")?);
    let host_binary_path = PathBuf::from(required_arg(rest, "--host-binary")?);
    let image_ref = required_arg(rest, "--image-ref")?;
    let test_run_id = required_arg(rest, "--test-run-id")?;
    let installation_hint = optional_arg(rest, "--installation-id")
        .map(InstallationId::parse)
        .transpose()
        .map_err(|e| e.to_string())?;
    let control_secret = std::fs::read_to_string(&control_secret_file)
        .map_err(|e| format!("read control secret: {e}"))?
        .trim()
        .to_owned();
    if control_secret.len() < 16 {
        return Err("control secret too short".into());
    }
    let registry = Registry::open(&registry_root, installation_hint).map_err(|e| e.to_string())?;
    let lifecycle_log = runtime_root
        .parent()
        .unwrap_or(&runtime_root)
        .join("evidence")
        .join("lifecycle.jsonl");
    let supervisor = Supervisor::new(
        registry,
        default_backend(docker_socket),
        SupervisorConfig {
            runtime_root,
            host_binary_path,
            image_ref,
            test_run_id,
            control_secret,
            lifecycle_log,
        },
    )
    .map_err(|e| e.message)?;
    serve_control(supervisor, &control_socket).await
}

fn required_arg(args: &[String], key: &str) -> Result<String, String> {
    optional_arg(args, key).ok_or_else(|| format!("missing {key}"))
}
fn optional_arg(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
}
