use std::os::unix::process::CommandExt;
use std::process::Command;

trait ParentDeathOps {
    fn arm_kill(&self) -> std::io::Result<()>;
    fn parent_pid(&self) -> libc::pid_t;
}

struct LibcParentDeathOps;

impl ParentDeathOps for LibcParentDeathOps {
    fn arm_kill(&self) -> std::io::Result<()> {
        // SAFETY: prctl is called in the post-fork child with scalar
        // arguments only.
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn parent_pid(&self) -> libc::pid_t {
        // SAFETY: getppid has no preconditions.
        unsafe { libc::getppid() }
    }
}

fn arm_parent_death(
    ops: &impl ParentDeathOps,
    expected_parent: libc::pid_t,
) -> std::io::Result<()> {
    ops.arm_kill()?;
    if ops.parent_pid() != expected_parent {
        return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
    }
    Ok(())
}

pub(crate) fn arm_parent_death_on_spawn(command: &mut Command) {
    // SAFETY: getpid has no preconditions.
    let expected_parent = unsafe { libc::getpid() };
    // SAFETY: the closure performs only prctl/getppid and constructs an
    // errno-backed io::Error; it does not allocate or acquire locks.
    unsafe {
        command.pre_exec(move || arm_parent_death(&LibcParentDeathOps, expected_parent));
    }
}

pub(crate) fn contain_process_group_spawn(command: &mut Command) {
    // Each validation launch owns a process group. Keeping that group separate
    // lets normal and error cleanup terminate descendants as one unit.
    command.process_group(0);
    arm_parent_death_on_spawn(command);
}

pub(crate) fn signal_process_group(pid: u32) -> std::io::Result<()> {
    let pgid = libc::pid_t::try_from(pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "process-group pid exceeds pid_t",
        )
    })?;
    // SAFETY: contain_spawn places the child in a process group whose id is
    // its pid. A negative pid addresses that exact group. ESRCH means the
    // group is already gone.
    if unsafe { libc::kill(-pgid, libc::SIGKILL) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct FakeOps {
        parent: libc::pid_t,
        arm_error: bool,
        events: RefCell<Vec<&'static str>>,
    }

    impl ParentDeathOps for FakeOps {
        fn arm_kill(&self) -> std::io::Result<()> {
            self.events.borrow_mut().push("arm");
            if self.arm_error {
                Err(std::io::Error::other("injected prctl failure"))
            } else {
                Ok(())
            }
        }

        fn parent_pid(&self) -> libc::pid_t {
            self.events.borrow_mut().push("parent");
            self.parent
        }
    }

    #[test]
    fn parent_death_is_armed_before_the_fork_parent_race_check() {
        let ops = FakeOps {
            parent: 41,
            arm_error: false,
            events: RefCell::new(Vec::new()),
        };
        arm_parent_death(&ops, 41).unwrap();
        assert_eq!(&*ops.events.borrow(), &["arm", "parent"]);
    }

    #[test]
    fn changed_parent_after_arming_fails_the_child_exec() {
        let ops = FakeOps {
            parent: 42,
            arm_error: false,
            events: RefCell::new(Vec::new()),
        };
        let error = arm_parent_death(&ops, 41).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ECHILD));
        assert_eq!(&*ops.events.borrow(), &["arm", "parent"]);
    }

    #[test]
    fn arm_failure_does_not_claim_containment() {
        let ops = FakeOps {
            parent: 41,
            arm_error: true,
            events: RefCell::new(Vec::new()),
        };
        assert!(arm_parent_death(&ops, 41).is_err());
        assert_eq!(&*ops.events.borrow(), &["arm"]);
    }
}
