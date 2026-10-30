//! Test-only: a child process parked between fork and exec.
//!
//! Every descriptor of a process is duplicated into a child at fork and
//! closed (close-on-exec) only when the child execs. A lock or socket that
//! a test thread "releases" by closing its descriptor therefore stays alive
//! while ANY concurrently forked child sits in that window — which is how
//! PTY, sidecar and Git spawns on other threads kept the session-names
//! sidecar lock held and a retired listener listening. Tests use a parked
//! child to hold that window open deterministically.

/// A child process forked by ANY thread of this process, parked between fork
/// and exec. Until it execs it holds a duplicate of every descriptor this
/// process had open at the fork — a sidecar lock a naming transaction held,
/// a listening socket about to be retired — exactly the window every PTY,
/// sidecar or Git spawn opens on another thread.
pub(crate) struct ParkedChild {
    release: std::os::unix::net::UnixStream,
    spawner: Option<std::thread::JoinHandle<std::io::Result<std::process::ExitStatus>>>,
}

impl ParkedChild {
    /// Fork a child now and return once it is parked before its exec.
    pub(crate) fn fork_now() -> Self {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;

        let (mut parent_end, child_end) =
            std::os::unix::net::UnixStream::pair().expect("parked-child socket pair");
        let child_fd = child_end.as_raw_fd();
        let mut command = std::process::Command::new("true");
        // SAFETY: the closure runs in the forked child before exec and only
        // makes write(2)/read(2) calls on an inherited socket — both
        // async-signal-safe, with no allocation and no locks.
        unsafe {
            command.pre_exec(move || {
                let parked = *b"p";
                libc::write(child_fd, parked.as_ptr().cast(), 1);
                let mut go = [0u8];
                libc::read(child_fd, go.as_mut_ptr().cast(), 1);
                Ok(())
            });
        }
        // `spawn` returns only once the child has exec'd, so it runs on its
        // own thread while the test holds the child parked.
        let spawner = std::thread::spawn(move || {
            let status = command.spawn()?.wait();
            drop(child_end);
            status
        });
        let mut parked = [0u8];
        parent_end
            .read_exact(&mut parked)
            .expect("the forked child reports that it is parked before exec");
        Self {
            release: parent_end,
            spawner: Some(spawner),
        }
    }

    /// Let the child exec (closing its inherited descriptors) and exit.
    pub(crate) fn release(mut self) {
        self.unpark();
        let status = self
            .spawner
            .take()
            .expect("a parked child is released once")
            .join()
            .expect("parked-child spawner thread")
            .expect("the parked child runs to completion");
        assert!(status.success(), "the parked child exits cleanly");
    }

    fn unpark(&mut self) {
        use std::io::Write;
        // The child holds its own copy of this end, so it would never see
        // EOF: it is released only by this byte.
        let _ = self.release.write_all(b"g");
    }
}

impl Drop for ParkedChild {
    /// A test that fails before `release` still lets its child exec and exit
    /// (the spawner thread reaps it) instead of leaving it parked forever.
    fn drop(&mut self) {
        if self.spawner.is_some() {
            self.unpark();
        }
    }
}
