use serde_json::Value;
use std::{
    net::TcpListener,
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const AUTH_TOKEN: &str = "managed-runtime-startup-test-token";
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

fn reserved_loopback_port() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve a loopback port");
    let port = listener.local_addr().expect("read reserved port").port();
    (listener, port)
}

fn wait_for_output(mut child: Child, timeout: Duration) -> Output {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .expect("collect output from the exited server process");
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("freshell-server did not exit within {timeout:?}");
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("failed to wait for freshell-server: {error}");
            }
        }
    }
}

fn isolated_server_command(home: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_freshell-server"));
    command
        .current_dir(home)
        .env_clear()
        .env("HOME", home)
        .env("FRESHELL_HOME", home)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn build_info_reports_the_binary_feature_without_starting_the_server() {
    let home = tempfile::tempdir().expect("create isolated server home");
    let (_occupied_port, port) = reserved_loopback_port();

    let mut command = isolated_server_command(home.path());
    command
        .arg("--build-info")
        .env("PORT", port.to_string())
        .env("FRESHELL_MANAGED_RUNTIME_V1", "1");

    let output = wait_for_output(
        command
            .spawn()
            .expect("spawn the Cargo-built freshell-server"),
        CHILD_EXIT_TIMEOUT,
    );
    assert!(
        output.status.success(),
        "--build-info exited with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );

    let build_info: Value =
        serde_json::from_slice(&output.stdout).expect("--build-info should print JSON");
    assert_eq!(
        build_info["managedRuntimeV1"],
        cfg!(feature = "managed-runtime-v1"),
        "the executable should report the feature compiled into this integration test"
    );
}

#[cfg(not(feature = "managed-runtime-v1"))]
#[test]
fn featureless_binary_refuses_managed_runtime_before_server_startup() {
    let home = tempfile::tempdir().expect("create isolated server home");
    let (_occupied_port, port) = reserved_loopback_port();

    let mut command = isolated_server_command(home.path());
    command
        .env("PORT", port.to_string())
        .env("FRESHELL_MANAGED_RUNTIME_V1", "1");

    let output = wait_for_output(
        command
            .spawn()
            .expect("spawn the Cargo-built freshell-server"),
        CHILD_EXIT_TIMEOUT,
    );
    assert!(
        !output.status.success(),
        "a featureless binary must refuse managed runtime startup"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires freshell-server to be built with the managed-runtime-v1 feature"
        ),
        "expected the feature-specific startup refusal, got stderr: {stderr}"
    );
}
