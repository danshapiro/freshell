use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::ExitCode;

use freshell_deploy::{
    execute_capture, execute_controller, execute_launch_helper, execute_lifecycle_launch_helper,
    CaptureCommand, ControllerCommand, DeployError, Result,
};

fn main() -> ExitCode {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "-h" || argument == "--help")
    {
        print_help();
        return ExitCode::SUCCESS;
    }
    match dispatch(arguments) {
        Ok(message) => {
            if !message.is_empty() {
                println!("{message}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("freshell-deploy: {error}");
            ExitCode::from(match error {
                DeployError::Activation(ref message)
                    if message.starts_with("controller command:") =>
                {
                    2
                }
                DeployError::LegacyCapture(ref message)
                    if message.contains("command")
                        || message.contains("option")
                        || message.contains("subcommand") =>
                {
                    2
                }
                _ => 1,
            })
        }
    }
}

fn dispatch(arguments: Vec<std::ffi::OsString>) -> Result<String> {
    match arguments.first().and_then(|argument| argument.to_str()) {
        Some("capture") => {
            let receipt = execute_capture(CaptureCommand::parse(arguments)?)?;
            Ok(format!(
                "Captured immutable legacy generation {} (running process kept alive).",
                receipt.generation_id
            ))
        }
        Some("launch-helper") => {
            let (journal, attempt) = parse_launch_helper(&arguments)?;
            execute_launch_helper(&journal, &attempt)?;
            Ok(String::new())
        }
        Some("lifecycle-launch-helper") => {
            let record = parse_lifecycle_helper(&arguments)?;
            execute_lifecycle_launch_helper(&record)?;
            Ok(String::new())
        }
        _ => execute_controller(ControllerCommand::parse(arguments)?),
    }
}

fn parse_launch_helper(arguments: &[std::ffi::OsString]) -> Result<(PathBuf, String)> {
    if arguments.len() != 5
        || arguments[1] != OsStr::new("--journal")
        || arguments[3] != OsStr::new("--attempt")
    {
        return Err(DeployError::Activation(
            "launch-helper requires exact --journal PATH --attempt ID options".to_string(),
        ));
    }
    let attempt = arguments[4]
        .clone()
        .into_string()
        .map_err(|_| DeployError::Activation("launch-helper attempt is not UTF-8".to_string()))?;
    if attempt.is_empty() || attempt.contains('/') {
        return Err(DeployError::Activation(
            "launch-helper attempt is malformed".to_string(),
        ));
    }
    Ok((PathBuf::from(&arguments[2]), attempt))
}

fn parse_lifecycle_helper(arguments: &[std::ffi::OsString]) -> Result<PathBuf> {
    if arguments.len() != 3 || arguments[1] != OsStr::new("--record") {
        return Err(DeployError::Activation(
            "lifecycle-launch-helper requires exact --record PATH option".to_string(),
        ));
    }
    Ok(PathBuf::from(&arguments[2]))
}

fn print_help() {
    println!(
        "Usage:\n\
         \x20 freshell-deploy bootstrap-status --checkout PATH --port PORT\n\
         \x20 freshell-deploy deploy --checkout PATH --port PORT --mode MODE ...\n\
         \x20 freshell-deploy start-current --checkout PATH --port PORT\n\
         \x20 freshell-deploy restart-current --checkout PATH --port PORT\n\
         \x20 freshell-deploy stop-current --checkout PATH --port PORT\n\
         \x20 freshell-deploy capture --checkout PATH --port PORT ...\n\
         \n\
         Lifecycle and deployment mutations are receipt- and generation-bound."
    );
}
