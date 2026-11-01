use freshell_runtime_client::{ClientError, RuntimeClient};
use freshell_runtime_protocol::{ReopenOutcome, RequestId, SoulId, StopOutcome};
use serde_json::{json, Value};
use std::{env, path::PathBuf, process::ExitCode};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = match parse_args(env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(message) => return report_error(message, 2),
    };
    let client = match RuntimeClient::from_secret_file(args.socket, args.secret_file).await {
        Ok(client) => client,
        Err(error) => return report_client_error(error),
    };

    match args.command.as_str() {
        "health" => match client.health().await {
            Ok((control_epoch, installation_id)) => report(
                json!({
                    "state": "ok",
                    "controlEpoch": control_epoch,
                    "installationId": installation_id,
                }),
                0,
            ),
            Err(error) => report_client_error(error),
        },
        "inventory" => match client.inventory().await {
            Ok(views) => report(json!({ "state": "ok", "views": views }), 0),
            Err(error) => report_client_error(error),
        },
        "stop" => {
            let (soul_id, expected_revision) = match parse_soul_revision(&args.remaining) {
                Ok(parsed) => parsed,
                Err(message) => return report_error(message, 2),
            };
            match client.stop_expected(soul_id, Some(expected_revision)).await {
                Ok((outcome, view)) => {
                    let state = match outcome {
                        StopOutcome::VerifiedEmpty => "verified_empty",
                        StopOutcome::BlockedOwnership => "blocked_ownership",
                        StopOutcome::BackendUnavailable => "backend_unavailable",
                        StopOutcome::TerminationUnconfirmed => "termination_unconfirmed",
                    };
                    report(
                        json!({ "state": state, "view": view }),
                        if outcome == StopOutcome::VerifiedEmpty {
                            0
                        } else {
                            1
                        },
                    )
                }
                Err(error) => report_client_error(error),
            }
        }
        "reopen" => {
            let (soul_id, expected_revision) = match parse_soul_revision(&args.remaining) {
                Ok(parsed) => parsed,
                Err(message) => return report_error(message, 2),
            };
            match client
                .reopen_with_request_id(RequestId::new(), soul_id, expected_revision)
                .await
            {
                Ok(result) => {
                    let code = if result.outcome == ReopenOutcome::Reopened {
                        0
                    } else {
                        1
                    };
                    report(
                        serde_json::to_value(result).expect("Reopen result serializes"),
                        code,
                    )
                }
                Err(error) => report_client_error(error),
            }
        }
        _ => unreachable!("argument parser validates the command"),
    }
}

struct Arguments {
    socket: PathBuf,
    secret_file: PathBuf,
    command: String,
    remaining: Vec<String>,
}

fn parse_args(args: Vec<String>) -> Result<Arguments, String> {
    let mut socket = None;
    let mut secret_file = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--socket" | "--secret-file" => {
                let option = args[index].as_str();
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| format!("{option} requires a path"))?;
                match option {
                    "--socket" => socket = Some(PathBuf::from(value)),
                    "--secret-file" => secret_file = Some(PathBuf::from(value)),
                    _ => unreachable!(),
                }
                index += 2;
            }
            _ => break,
        }
    }
    let socket = socket.ok_or("--socket is required".to_owned())?;
    let secret_file = secret_file.ok_or("--secret-file is required".to_owned())?;
    let command = args
        .get(index)
        .ok_or("a command is required".to_owned())?
        .clone();
    if !matches!(command.as_str(), "health" | "inventory" | "stop" | "reopen") {
        return Err("command must be health, inventory, stop, or reopen".into());
    }
    let remaining = args[index + 1..].to_vec();
    match command.as_str() {
        "health" | "inventory" if !remaining.is_empty() => {
            return Err(format!("{command} does not accept arguments"));
        }
        "stop" | "reopen" => {
            parse_soul_revision(&remaining)?;
        }
        _ => {}
    }
    Ok(Arguments {
        socket,
        secret_file,
        command,
        remaining,
    })
}

fn parse_soul_revision(args: &[String]) -> Result<(SoulId, u64), String> {
    if args.len() != 3 || args[1] != "--expected-revision" {
        return Err("expected <soul-id> --expected-revision <revision>".into());
    }
    let soul_id = SoulId::parse(args[0].clone()).map_err(|_| "invalid soul id".to_owned())?;
    let revision = args[2]
        .parse::<u64>()
        .map_err(|_| "expected revision must be an unsigned integer".to_owned())?;
    Ok((soul_id, revision))
}

fn report_client_error(error: ClientError) -> ExitCode {
    let message = match error {
        ClientError::Runtime { message, .. } => message,
        ClientError::Io(_) => "runtime supervisor is unavailable".into(),
        ClientError::Protocol(message) => message,
        ClientError::UnexpectedResult => "runtime supervisor returned an unexpected result".into(),
    };
    report(json!({ "state": "error", "message": message }), 1)
}

fn report_error(message: String, code: u8) -> ExitCode {
    report(json!({ "state": "error", "message": message }), code)
}

fn report(value: Value, code: u8) -> ExitCode {
    println!("{value}");
    ExitCode::from(code)
}
