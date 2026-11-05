use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};
use tempfile::tempdir;

const SECRET: &str = "fixture-control-secret";

#[test]
fn admin_cli_preserves_frozen_v2_wire_contract() {
    let directory = tempdir().expect("temporary directory");
    let socket_path = directory.path().join("supervisor.sock");
    let secret_path = directory.path().join("control.secret");
    std::fs::write(&secret_path, SECRET).expect("write control secret");

    let listener = UnixListener::bind(&socket_path).expect("bind legacy peer");
    listener
        .set_nonblocking(true)
        .expect("set nonblocking listener");
    let peer = thread::spawn(move || serve_frozen_v2_peer(listener, 4));

    let run = |command: &[&str]| -> Output {
        Command::new(env!("CARGO_BIN_EXE_freshell-supervisor-admin"))
            .args(["--socket", socket_path.to_str().unwrap()])
            .args(["--secret-file", secret_path.to_str().unwrap()])
            .args(command)
            .output()
            .expect("run supervisor admin CLI")
    };

    let health = run(&["health"]);
    let inventory = run(&["inventory"]);
    let stop = run(&["stop", "soul-fixture", "--expected-revision", "9"]);

    let observed = peer.join().expect("frozen peer should not panic");
    let observed_methods = observed
        .iter()
        .map(|request| request["body"]["method"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        observed_methods,
        ["health", "inventory", "health", "stop"],
        "CLI must speak the frozen Health, Inventory, and revision-fenced Stop v2 methods; statuses={:?}/{:?}/{:?}, stdout={}/{}/{}, stderr={}/{}/{}",
        health.status,
        inventory.status,
        stop.status,
        String::from_utf8_lossy(&health.stdout),
        String::from_utf8_lossy(&inventory.stdout),
        String::from_utf8_lossy(&stop.stdout),
        String::from_utf8_lossy(&health.stderr),
        String::from_utf8_lossy(&inventory.stderr),
        String::from_utf8_lossy(&stop.stderr)
    );

    for output in [&health, &inventory, &stop] {
        assert!(
            output.status.success(),
            "CLI failed: stdout={}, stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&health.stdout).unwrap()["state"],
        "ok"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&inventory.stdout).unwrap()["views"],
        json!([])
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&stop.stdout).unwrap()["state"],
        "verified_empty"
    );
}

#[test]
fn legacy_peer_rejects_additive_reopen_method_before_supervisor_replacement() {
    let directory = tempdir().expect("temporary directory");
    let socket_path = directory.path().join("supervisor.sock");
    let secret_path = directory.path().join("control.secret");
    std::fs::write(&secret_path, SECRET).expect("write control secret");

    let listener = UnixListener::bind(&socket_path).expect("bind legacy peer");
    listener
        .set_nonblocking(true)
        .expect("set nonblocking listener");
    let peer = thread::spawn(move || serve_frozen_peer_rejecting_reopen(listener));

    let output = Command::new(env!("CARGO_BIN_EXE_freshell-supervisor-admin"))
        .args(["--socket", socket_path.to_str().unwrap()])
        .args(["--secret-file", secret_path.to_str().unwrap()])
        .args(["reopen", "soul-fixture", "--expected-revision", "9"])
        .output()
        .expect("run supervisor admin CLI");
    let observed = peer
        .join()
        .expect("legacy peer should complete its exchange");

    assert_eq!(
        observed
            .iter()
            .map(|request| request["body"]["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["health", "reopen"]
    );
    assert!(
        !output.status.success(),
        "old supervisor must reject additive Reopen"
    );
    assert_eq!(output.status.code(), Some(1));
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["state"], "error");
    assert!(response["message"]
        .as_str()
        .unwrap()
        .contains("legacy peer"));
}

fn serve_frozen_v2_peer(listener: UnixListener, expected_connections: usize) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut requests = Vec::new();
    while requests.len() < expected_connections && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = read_request(&mut stream);
                validate_frozen_request(&request);
                let response = response_for(&request);
                write_response(&mut stream, &response);
                requests.push(request);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("legacy peer accept failed: {error}"),
        }
    }
    requests
}

fn serve_frozen_peer_rejecting_reopen(listener: UnixListener) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut requests = Vec::new();
    while requests.len() < 2 && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = read_request(&mut stream);
                assert_exact_keys(
                    &request,
                    &["protocolVersion", "requestId", "role", "auth", "body"],
                    "envelope",
                );
                assert_eq!(request["protocolVersion"], 2);
                assert_eq!(request["role"], "web");
                assert_eq!(request["auth"], SECRET);
                let response = match request["body"]["method"].as_str().unwrap() {
                    "health" => {
                        validate_frozen_request(&request);
                        response_for(&request)
                    }
                    "reopen" => {
                        assert_exact_keys(
                            &request["body"],
                            &["method", "params"],
                            "additive Reopen command",
                        );
                        assert_exact_keys(
                            &request["body"]["params"],
                            &["soulId", "expectedIntentRevision", "expectedControlEpoch"],
                            "additive Reopen params",
                        );
                        assert_eq!(request["body"]["params"]["soulId"], "soul-fixture");
                        assert_eq!(request["body"]["params"]["expectedIntentRevision"], 9);
                        assert_eq!(request["body"]["params"]["expectedControlEpoch"], 7);
                        json!({
                            "requestId": request["requestId"],
                            "result": {"Err": {"code": "INVALID_REQUEST", "message": "legacy peer does not support additive Reopen"}}
                        })
                    }
                    other => panic!("legacy peer received unexpected method {other:?}"),
                };
                write_response(&mut stream, &response);
                requests.push(request);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("legacy peer accept failed: {error}"),
        }
    }
    assert_eq!(
        requests.len(),
        2,
        "CLI did not complete its legacy-peer probe"
    );
    requests
}

fn read_request(stream: &mut UnixStream) -> Value {
    let mut length = [0; 4];
    stream
        .read_exact(&mut length)
        .expect("request frame length");
    let length = u32::from_be_bytes(length) as usize;
    let mut payload = vec![0; length];
    stream.read_exact(&mut payload).expect("request frame body");
    serde_json::from_slice(&payload).expect("request JSON")
}

fn write_response(stream: &mut UnixStream, response: &Value) {
    let payload = serde_json::to_vec(response).expect("response JSON");
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&payload))
        .expect("write response frame");
}

fn validate_frozen_request(request: &Value) {
    assert_exact_keys(
        request,
        &["protocolVersion", "requestId", "role", "auth", "body"],
        "envelope",
    );
    assert_eq!(request["protocolVersion"], 2);
    assert_eq!(request["role"], "web");
    assert_eq!(request["auth"], SECRET);

    let body = &request["body"];
    match body["method"].as_str().expect("method") {
        "health" | "inventory" => {
            assert_exact_keys(body, &["method"], "parameterless command");
        }
        "stop" => {
            assert_exact_keys(body, &["method", "params"], "stop command");
            assert_exact_keys(
                &body["params"],
                &["soulId", "expectedIntentRevision", "expectedControlEpoch"],
                "stop params",
            );
            assert_eq!(body["params"]["soulId"], "soul-fixture");
            assert_eq!(body["params"]["expectedIntentRevision"], 9);
            assert_eq!(body["params"]["expectedControlEpoch"], 7);
        }
        other => panic!("frozen v2 peer rejects method {other:?}"),
    }
}

fn response_for(request: &Value) -> Value {
    let request_id = request["requestId"].clone();
    let result = match request["body"]["method"].as_str().unwrap() {
        "health" => json!({
            "kind": "health",
            "data": { "control_epoch": 7, "installation_id": "installation-fixture" }
        }),
        "inventory" => json!({ "kind": "inventory", "data": [] }),
        "stop" => json!({
            "kind": "stop",
            "data": {
                "outcome": "verified_empty",
                "view": {
                    "soulId": "soul-fixture",
                    "incarnationId": "incarnation-fixture",
                    "launchState": "stopped",
                    "cleanupState": "verified_empty",
                    "intentRevision": 10,
                    "executionGeneration": 0
                }
            }
        }),
        _ => unreachable!("validated frozen method"),
    };
    json!({ "requestId": request_id, "result": { "Ok": result } })
}

fn assert_exact_keys(value: &Value, expected: &[&str], label: &str) {
    let actual = value
        .as_object()
        .unwrap_or_else(|| panic!("{label} must be an object"))
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(actual, expected, "unexpected {label} fields");
}
