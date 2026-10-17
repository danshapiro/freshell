//! Final managed-provider exec limits. Diagnostics carry classifications only.
use std::{collections::BTreeMap, io::Read};

pub const MAX_EXEC_BYTES: usize = 1024 * 1024;
pub const MIN_STACK_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
pub struct Profile {
    pub page_bytes: usize,
    pub pointer_bytes: usize,
    pub soft_stack_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecError {
    NativeProfile,
    Stack,
    String,
    Total,
    Executable,
    Interpreter,
}
impl std::fmt::Display for ExecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "provider exec profile {:?}: repair the launch inputs before dispatch",
            self
        )
    }
}
impl std::error::Error for ExecError {}

#[cfg(target_os = "linux")]
pub fn process_profile() -> Result<Profile, ExecError> {
    let mut stack = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // getrlimit initializes the complete result on success; it changes no
    // process limits. sysconf queries the actual target's page size.
    if unsafe { libc::getrlimit(libc::RLIMIT_STACK, stack.as_mut_ptr()) } != 0 {
        return Err(ExecError::NativeProfile);
    }
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page <= 0 {
        return Err(ExecError::NativeProfile);
    }
    let stack = unsafe { stack.assume_init() };
    Ok(Profile {
        page_bytes: page as usize,
        pointer_bytes: std::mem::size_of::<usize>(),
        soft_stack_bytes: stack.rlim_cur,
    })
}

/// Check the exact standard Command overlay. The caller states whether its
/// command inherits the process environment; Rust exposes overlays separately.
#[cfg(target_os = "linux")]
pub fn check_command(
    command: &std::process::Command,
    inherit_environment: bool,
    additional_programs: &[&str],
) -> Result<(), ExecError> {
    let mut environment = BTreeMap::<String, String>::new();
    if inherit_environment {
        for (name, value) in std::env::vars_os() {
            environment.insert(
                name.into_string().map_err(|_| ExecError::String)?,
                value.into_string().map_err(|_| ExecError::String)?,
            );
        }
    }
    for (name, value) in command.get_envs() {
        let name = name.to_str().ok_or(ExecError::String)?;
        match value {
            Some(value) => {
                environment.insert(name.into(), value.to_str().ok_or(ExecError::String)?.into());
            }
            None => {
                environment.remove(name);
            }
        }
    }
    let program = command
        .get_program()
        .to_str()
        .ok_or(ExecError::Executable)?;
    let args = command
        .get_args()
        .map(|arg| arg.to_str().map(str::to_owned).ok_or(ExecError::String))
        .collect::<Result<Vec<_>, _>>()?;
    check_final_exec(
        program,
        &args,
        &environment,
        additional_programs,
        process_profile()?,
    )
}

struct Accounting {
    profile: Profile,
    bytes: usize,
    strings: usize,
}
impl Accounting {
    fn string(&mut self, bytes: usize) -> Result<(), ExecError> {
        let bytes = bytes.checked_add(1).ok_or(ExecError::String)?;
        if bytes
            > self
                .profile
                .page_bytes
                .checked_mul(32)
                .ok_or(ExecError::NativeProfile)?
        {
            return Err(ExecError::String);
        }
        self.bytes = self.bytes.checked_add(bytes).ok_or(ExecError::Total)?;
        self.strings = self.strings.checked_add(1).ok_or(ExecError::Total)?;
        self.check()
    }
    fn check(&self) -> Result<(), ExecError> {
        let pointers = self
            .strings
            .checked_add(2)
            .and_then(|count| count.checked_mul(self.profile.pointer_bytes))
            .ok_or(ExecError::Total)?;
        if self
            .bytes
            .checked_add(pointers)
            .is_none_or(|bytes| bytes > MAX_EXEC_BYTES)
        {
            return Err(ExecError::Total);
        }
        Ok(())
    }
}

/// `additional_programs` names fixed wrapper/provider executables whose own
/// exec occurs after the first program (for example setpriv -> provider).
/// This inspects only executable headers, never interprets command/argv text.
pub fn check_final_exec(
    program: &str,
    args: &[String],
    environment: &BTreeMap<String, String>,
    additional_programs: &[&str],
    profile: Profile,
) -> Result<(), ExecError> {
    if profile.soft_stack_bytes < MIN_STACK_BYTES {
        return Err(ExecError::Stack);
    }
    if profile.page_bytes == 0 || profile.pointer_bytes == 0 {
        return Err(ExecError::NativeProfile);
    }
    let mut accounting = Accounting {
        profile,
        bytes: 0,
        strings: 0,
    };
    if program.contains('\0') {
        return Err(ExecError::String);
    }
    accounting.string(program.len())?;
    for argument in args {
        if argument.contains('\0') {
            return Err(ExecError::String);
        }
        accounting.string(argument.len())?;
    }
    for (name, value) in environment {
        if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') {
            return Err(ExecError::String);
        }
        accounting.string(
            name.len()
                .checked_add(1)
                .and_then(|bytes| bytes.checked_add(value.len()))
                .ok_or(ExecError::String)?,
        )?;
    }
    for executable in std::iter::once(program).chain(additional_programs.iter().copied()) {
        let resolved = crate::path::resolve_program_via_path(
            executable,
            environment.get("PATH").map(String::as_str),
        )
        .map_err(|_| ExecError::Executable)?;
        account_executable(&resolved, &mut accounting, 0)?;
    }
    accounting.check()
}

fn account_executable(
    program: &str,
    accounting: &mut Accounting,
    depth: usize,
) -> Result<(), ExecError> {
    if depth > 4 {
        return Err(ExecError::Interpreter);
    }
    // execfn and every kernel-added script/interpreter string consume space
    // in addition to the supplied argv and its pointers.
    accounting.string(program.len())?;
    let mut header = [0u8; 256];
    let mut file = std::fs::File::open(program).map_err(|_| ExecError::Executable)?;
    let count = file.read(&mut header).map_err(|_| ExecError::Executable)?;
    if count < 2 || &header[..2] != b"#!" {
        return Ok(());
    }
    let line = &header[2..count];
    let end = line
        .iter()
        .position(|byte| matches!(byte, b'\n' | 0))
        .unwrap_or(line.len());
    let line = std::str::from_utf8(&line[..end])
        .map_err(|_| ExecError::Interpreter)?
        .trim_matches([' ', '\t']);
    let split = line.find([' ', '\t']).unwrap_or(line.len());
    let interpreter = &line[..split];
    if interpreter.is_empty() {
        return Err(ExecError::Interpreter);
    }
    let argument = line[split..].trim_matches([' ', '\t']);
    if !argument.is_empty() {
        accounting.string(argument.len())?;
    }
    account_executable(interpreter, accounting, depth + 1)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            page_bytes: 4096,
            pointer_bytes: 8,
            soft_stack_bytes: MIN_STACK_BYTES,
        }
    }
    #[test]
    fn provider_exec_profile_counts_nul_pointers_and_complete_environment_strings() {
        let arguments = vec!["x".repeat(131_060); 8];
        assert_eq!(
            check_final_exec("/bin/true", &arguments, &BTreeMap::new(), &[], profile()),
            Err(ExecError::Total)
        );
        let environment = BTreeMap::from([("INPUT".into(), "x".repeat(32 * 4096 - 6))]);
        assert_eq!(
            check_final_exec("/bin/true", &[], &environment, &[], profile()),
            Err(ExecError::String)
        );
        assert!(check_final_exec(
            "/bin/true",
            &[],
            &BTreeMap::from([("INPUT".into(), "x".repeat(64 * 1024))]),
            &[],
            profile()
        )
        .is_ok());
        let mut low = profile();
        low.soft_stack_bytes -= 1;
        assert_eq!(
            check_final_exec("/bin/true", &[], &BTreeMap::new(), &[], low),
            Err(ExecError::Stack)
        );
    }
    #[test]
    fn provider_exec_profile_accounts_actual_shebang_additions() {
        let owned = tempfile::tempdir().unwrap();
        let script = owned.path().join("fixture");
        std::fs::write(&script, b"#!/bin/sh -eu\nexit 0\n").unwrap();
        let program = script.to_str().unwrap();
        assert!(check_final_exec(program, &[], &BTreeMap::new(), &[], profile()).is_ok());
        std::fs::write(&script, format!("#!{}\n", script.display())).unwrap();
        assert_eq!(
            check_final_exec(program, &[], &BTreeMap::new(), &[], profile()),
            Err(ExecError::Interpreter)
        );
    }

    #[test]
    fn provider_exec_profile_executes_actual_kernel_capacity_and_checks_process_stack() {
        const CHILD: &str = "FRESHELL_EXEC_CAPACITY_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider_exec::tests::provider_exec_profile_executes_actual_kernel_capacity_and_checks_process_stack",
                    "--nocapture",
                ])
                .env_clear()
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated actual exec/stack qualification failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let observed: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
            println!("provider_exec_capacity {observed}");
            return;
        }
        let mut limits = std::mem::MaybeUninit::<libc::rlimit>::uninit();
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_STACK, limits.as_mut_ptr()) },
            0
        );
        let original = unsafe { limits.assume_init() };
        assert!(original.rlim_max >= MIN_STACK_BYTES);
        let selected = libc::rlimit {
            rlim_cur: MIN_STACK_BYTES,
            rlim_max: original.rlim_max,
        };
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_STACK, &selected) }, 0);
        let native = process_profile().unwrap();
        assert_eq!(native.soft_stack_bytes, MIN_STACK_BYTES);
        let string_bytes = native.page_bytes.checked_mul(32).unwrap();
        let command = |arguments: Vec<String>, environment: Option<(&str, String)>| {
            let mut command = std::process::Command::new("/bin/true");
            command.env_clear().args(arguments);
            if let Some((name, value)) = environment {
                command.env(name, value);
            }
            command
        };
        let mut at_string_limit = command(vec!["x".repeat(string_bytes - 1)], None);
        check_command(&at_string_limit, false, &[]).unwrap();
        assert!(at_string_limit.status().unwrap().success());
        let mut over_string_limit = command(vec!["x".repeat(string_bytes)], None);
        assert_eq!(
            check_command(&over_string_limit, false, &[]),
            Err(ExecError::String)
        );
        assert_eq!(
            over_string_limit.status().unwrap_err().raw_os_error(),
            Some(libc::E2BIG)
        );
        let name = "FRESHELL_EXEC_CAPACITY_VALUE";
        let value_bytes = string_bytes - name.len() - 2;
        let mut at_environment_limit = command(vec![], Some((name, "x".repeat(value_bytes))));
        check_command(&at_environment_limit, false, &[]).unwrap();
        assert!(at_environment_limit.status().unwrap().success());
        let mut over_environment_limit = command(vec![], Some((name, "x".repeat(value_bytes + 1))));
        assert_eq!(
            check_command(&over_environment_limit, false, &[]),
            Err(ExecError::String)
        );
        assert_eq!(
            over_environment_limit.status().unwrap_err().raw_os_error(),
            Some(libc::E2BIG)
        );

        // Find the accepted total through the public command boundary rather
        // than reproducing the internal NUL/interpreter/pointer accounting.
        let arguments = |bytes: usize| {
            (0..8)
                .map(|index| "x".repeat(bytes / 8 + usize::from(index < bytes % 8)))
                .collect::<Vec<_>>()
        };
        let mut accepted = 0;
        let mut rejected = MAX_EXEC_BYTES.min(8 * (string_bytes - 1));
        assert_eq!(
            check_command(&command(arguments(rejected), None), false, &[]),
            Err(ExecError::Total)
        );
        while accepted + 1 < rejected {
            let midpoint = accepted + (rejected - accepted) / 2;
            match check_command(&command(arguments(midpoint), None), false, &[]) {
                Ok(()) => accepted = midpoint,
                Err(ExecError::Total) => rejected = midpoint,
                other => panic!("unexpected finite aggregate qualification: {other:?}"),
            }
        }
        assert!(accepted > MAX_EXEC_BYTES - native.page_bytes);
        let mut at_total_limit = command(arguments(accepted), None);
        check_command(&at_total_limit, false, &[]).unwrap();
        assert!(at_total_limit.status().unwrap().success());
        assert_eq!(
            check_command(&command(arguments(rejected), None), false, &[]),
            Err(ExecError::Total)
        );
        let too_small = libc::rlimit {
            rlim_cur: MIN_STACK_BYTES - 1,
            ..selected
        };
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_STACK, &too_small) },
            0
        );
        assert_eq!(
            process_profile().unwrap().soft_stack_bytes,
            MIN_STACK_BYTES - 1
        );
        assert_eq!(
            check_command(&command(vec![], None), false, &[]),
            Err(ExecError::Stack)
        );
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_STACK, &original) }, 0);
        eprintln!(
            "{}",
            serde_json::json!({
                "severity":"info", "stage":"exec_capacity", "pageBytes":native.page_bytes,
                "queriedStackBytes":native.soft_stack_bytes, "kernelStringBytesWithNul":string_bytes,
                "acceptedArgPayloadBytes":accepted, "rejectedArgPayloadBytes":rejected,
                "singleStringKernelE2big":true, "completeEnvironmentKernelE2big":true,
                "stackBelowMinimumRejected":true
            })
        );
    }
}
