use crate::journal::TransactionRecord;

pub(crate) fn interrupt_after(boundary: &str, record: &TransactionRecord) {
    let Ok(port_root) = record.port_root() else {
        return;
    };
    interrupt_in_disposable_sandbox(boundary, record.port.get(), &port_root);
}

pub(crate) fn interrupt_lifecycle_after(
    boundary: &str,
    port: crate::paths::DeployPort,
    port_root: &std::path::Path,
) {
    interrupt_in_disposable_sandbox(boundary, port.get(), port_root);
}

fn interrupt_in_disposable_sandbox(boundary: &str, port: u16, port_root: &std::path::Path) {
    if std::env::var("FRESHELL_DEPLOY_TEST_INTERRUPT_AFTER").as_deref() != Ok(boundary)
        || std::env::var("FRESHELL_DESTRUCTIVE_SANDBOX").as_deref() != Ok("1")
        || port == 3002
        || !port_root.starts_with("/tmp/")
    {
        return;
    }

    // This seam is deliberately limited to disposable Docker sandboxes. A
    // non-catchable signal models abrupt controller loss without allowing
    // cleanup code to make the durable boundary artificially safer.
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
}
