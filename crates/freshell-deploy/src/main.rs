use std::process::ExitCode;

use freshell_deploy::{execute_capture, CaptureCommand};

fn main() -> ExitCode {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "-h" || argument == "--help")
    {
        println!(
            "Usage: freshell-deploy capture \\\n\
             --checkout PATH --port PORT --pid-file PATH \\\n\
             --client-dir PATH --extensions-dir PATH --dist-server-dir PATH \\\n\
             --mcp-entry-relative PATH --claude-sidecar-dir PATH \\\n\
             --claude-sidecar-entry-relative PATH --package-json PATH \\\n\
             --package-lock PATH --node-modules PATH \\\n\
             --node-executable PATH --node-version VERSION\n\
             \n\
             --node-modules must name controller-private `npm ci --omit=dev` output\n\
             matching both the root and sidecar locks; a development install is rejected."
        );
        return ExitCode::SUCCESS;
    }
    let command = match CaptureCommand::parse(arguments) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("freshell-deploy: {error}");
            return ExitCode::from(2);
        }
    };
    match execute_capture(command) {
        Ok(receipt) => {
            println!(
                "Captured immutable legacy generation {} (running process kept alive).",
                receipt.generation_id
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("freshell-deploy: legacy capture failed closed: {error}");
            ExitCode::FAILURE
        }
    }
}
