use freshell_runtime_protocol::InstallationId;
use freshell_supervisor::{
    admission::{AdmissionBudget, AdmissionPolicy},
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
    run_with(
        std::env::args().collect(),
        |root, hint| Registry::open(root, hint).map_err(|error| error.to_string()),
        |version| println!("{version}"),
        |output| println!("{output}"),
    )
    .await
}

async fn run_with(
    args: Vec<String>,
    open_registry: impl FnOnce(&std::path::Path, Option<InstallationId>) -> Result<Registry, String>,
    report_schema: impl FnOnce(&str),
    report_maintenance_inventory: impl FnOnce(&str),
) -> Result<(), String> {
    if let Some(version) = schema_version_command(&args) {
        report_schema(&version);
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("maintenance-inventory") {
        if args.len() != 3 {
            return Err(
                "usage: freshell-supervisor maintenance-inventory <absolute-database-path>".into(),
            );
        }
        let database_path = PathBuf::from(&args[2]);
        if !database_path.is_absolute() {
            return Err("maintenance-inventory requires an absolute database path".into());
        }
        let inventory = freshell_supervisor::registry::read_maintenance_inventory(&database_path)
            .map_err(|error| format!("maintenance inventory: {error}"))?;
        let output = serde_json::to_string(&inventory)
            .map_err(|error| format!("serialize maintenance inventory: {error}"))?;
        report_maintenance_inventory(&output);
        return Ok(());
    }
    freshell_agent_runtime::process_qualification_policy()?;
    if args.get(1).map(String::as_str) != Some("serve") {
        return Err("usage: freshell-supervisor schema-version | maintenance-inventory <absolute-database-path> | serve --registry-root PATH --control-socket PATH --control-secret-file PATH --docker-socket PATH --runtime-root PATH --host-binary PATH --image-ref sha256:... --test-run-id ID [--installation-id ID] [--operator-home PATH]".into());
    }
    let rest = &args[2..];
    let registry_root = PathBuf::from(required_arg(rest, "--registry-root")?);
    let control_socket = PathBuf::from(required_arg(rest, "--control-socket")?);
    freshell_supervisor::backend::docker::configure_capability_dir(&control_socket)?;
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
    if let Some(operator_home) = optional_arg(rest, "--operator-home") {
        std::env::set_var("FRESHELL_SUPERVISOR_OPERATOR_HOME", operator_home);
    }
    let defaults = AdmissionPolicy::default();
    let admission = AdmissionPolicy {
        installation: AdmissionBudget::new(
            optional_u64_arg(rest, "--installation-budget-cpu-milli")?
                .unwrap_or(defaults.installation.cpu_milli),
            optional_u64_arg(rest, "--installation-budget-memory-bytes")?
                .unwrap_or(defaults.installation.memory_bytes),
            optional_u64_arg(rest, "--installation-budget-pids")?
                .unwrap_or(defaults.installation.pids_max),
        )
        .validate()
        .map_err(str::to_owned)?,
        project: AdmissionBudget::new(
            optional_u64_arg(rest, "--project-budget-cpu-milli")?
                .unwrap_or(defaults.project.cpu_milli),
            optional_u64_arg(rest, "--project-budget-memory-bytes")?
                .unwrap_or(defaults.project.memory_bytes),
            optional_u64_arg(rest, "--project-budget-pids")?.unwrap_or(defaults.project.pids_max),
        )
        .validate()
        .map_err(str::to_owned)?,
    };
    let control_secret = std::fs::read_to_string(&control_secret_file)
        .map_err(|e| format!("read control secret: {e}"))?
        .trim()
        .to_owned();
    if control_secret.len() < 16 {
        return Err("control secret too short".into());
    }
    let registry = open_registry(&registry_root, installation_hint)?;
    let lifecycle_log = runtime_root
        .parent()
        .unwrap_or(&runtime_root)
        .join("evidence")
        .join("lifecycle.jsonl");
    let supervisor = Supervisor::new(
        registry,
        default_backend(docker_socket, lifecycle_log.clone()),
        SupervisorConfig {
            runtime_root,
            control_socket_path: control_socket.clone(),
            host_binary_path,
            image_ref,
            test_run_id,
            control_secret,
            lifecycle_log,
            admission,
        },
    )
    .map_err(|e| e.message)?;
    supervisor
        .reconcile_pending_loss_cleanup()
        .await
        .map_err(|error| format!("pending loss cleanup reconciliation: {}", error.message))?;
    supervisor
        .reconcile_startup()
        .await
        .map_err(|error| format!("startup reconciliation: {}", error.message))?;
    supervisor.spawn_runtime_observer();
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

fn optional_u64_arg(args: &[String], key: &str) -> Result<Option<u64>, String> {
    optional_arg(args, key)
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|e| format!("invalid {key}: {e}"))
        })
        .transpose()
}

fn schema_version_command(args: &[String]) -> Option<String> {
    (args.get(1).map(String::as_str) == Some("schema-version") && args.len() == 2)
        .then(|| freshell_supervisor::registry::SCHEMA_VERSION.to_string())
}

#[cfg(test)]
mod tests {
    use super::run_with;
    use freshell_supervisor::registry::SCHEMA_VERSION;

    async fn assert_schema_dispatch_is_read_only() {
        let directory = tempfile::tempdir().unwrap();
        let registry_root = directory.path().join("registry");
        let opened = std::cell::Cell::new(false);
        let output = std::cell::RefCell::new(String::new());
        let result = run_with(
            vec!["freshell-supervisor".into(), "schema-version".into()],
            |_, hint| {
                opened.set(true);
                freshell_supervisor::registry::Registry::open(&registry_root, hint)
                    .map_err(|error| error.to_string())
            },
            |version| *output.borrow_mut() = version.into(),
            |_| {},
        )
        .await;
        assert!(result.is_ok(), "schema command dispatch failed: {result:?}");
        assert_eq!(*output.borrow(), SCHEMA_VERSION.to_string());
        assert!(
            !opened.get(),
            "schema command must dispatch before registry opening"
        );
        assert!(
            !registry_root.exists(),
            "schema reporting must not create the registry"
        );
    }

    #[tokio::test]
    async fn schema_version_command_does_not_open_registry() {
        assert_schema_dispatch_is_read_only().await;
    }

    #[tokio::test]
    async fn schema_version_startup_dispatch_never_opens_registry() {
        assert_schema_dispatch_is_read_only().await;
    }

    #[tokio::test]
    async fn maintenance_inventory_command_is_read_only() {
        use rusqlite::{params, Connection};

        let directory = tempfile::tempdir().unwrap();
        let registry_root = directory.path().join("registry");
        drop(freshell_supervisor::registry::Registry::open(&registry_root, None).unwrap());
        let database_path = registry_root.join("runtime.sqlite3");
        let soul_id = freshell_runtime_protocol::SoulId::new().to_string();
        let conn = Connection::open(&database_path).unwrap();
        conn.execute(
            "INSERT INTO souls (soul_id,provider,provider_store_id,creation_seed_ref,desired_state,intent_revision,recovery_state,durability_state,allocation_state,checkpoint_revision,evidence_revision,successful_recoveries_in_window,project_key,resource_profile,provider_volume_name,created_at,updated_at) VALUES (?1,'codex','store','seed','stopped',1,'stopped','durable','allocated',0,0,0,'default','custom','volume',0,0)",
            params![soul_id],
        )
        .unwrap();
        drop(conn);

        let database_bytes_before = std::fs::read(&database_path).unwrap();
        let (schema_version_before, schema_cookie_before): (u32, i64) = {
            let conn = Connection::open(&database_path).unwrap();
            (
                conn.query_row(
                    "SELECT schema_version FROM installation WHERE singleton=1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
                conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
                    .unwrap(),
            )
        };
        let output = std::cell::RefCell::new(String::new());
        let result = run_with(
            vec![
                "freshell-supervisor".into(),
                "maintenance-inventory".into(),
                database_path.to_string_lossy().into_owned(),
            ],
            |_, _| panic!("maintenance inventory must not open or initialize a registry"),
            |_| panic!("maintenance inventory must not dispatch schema-version"),
            |value| *output.borrow_mut() = value.into(),
        )
        .await;
        assert!(result.is_ok(), "maintenance inventory failed: {result:?}");
        let value: serde_json::Value = serde_json::from_str(&output.borrow()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "noRuntime": [{
                    "soulId": soul_id,
                    "desiredState": "stopped",
                    "intentRevision": 1,
                    "status": "verified_empty"
                }]
            })
        );
        assert_eq!(
            std::fs::read(&database_path).unwrap(),
            database_bytes_before,
            "maintenance inventory must not change database bytes"
        );
        let conn = Connection::open(&database_path).unwrap();
        let schema_version_after: u32 = conn
            .query_row(
                "SELECT schema_version FROM installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let schema_cookie_after: i64 = conn
            .query_row("PRAGMA schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(schema_version_after, schema_version_before);
        assert_eq!(schema_cookie_after, schema_cookie_before);

        let missing_database_path = directory.path().join("missing.sqlite3");
        let missing_result = run_with(
            vec![
                "freshell-supervisor".into(),
                "maintenance-inventory".into(),
                missing_database_path.to_string_lossy().into_owned(),
            ],
            |_, _| panic!("maintenance inventory must not initialize a registry"),
            |_| panic!("maintenance inventory must not dispatch schema-version"),
            |_| {},
        )
        .await;
        assert!(missing_result.is_err());
        assert!(!missing_database_path.exists());
    }
}
