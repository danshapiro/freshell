//! Test shim binary for `exec_shim::unit_exec_main` (the server runs the same
//! entry point as its hidden `__unit-exec` subcommand).
fn main() {
    std::process::exit(freshell_containment::exec_shim::unit_exec_main(
        std::env::args_os().skip(1).collect(),
    ))
}
