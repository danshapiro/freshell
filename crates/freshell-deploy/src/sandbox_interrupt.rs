use crate::journal::TransactionRecord;

pub(crate) fn interrupt_after(boundary: &str, record: &TransactionRecord) {
    if std::env::var("FRESHELL_DEPLOY_TEST_INTERRUPT_AFTER").as_deref() != Ok(boundary)
        || std::env::var("FRESHELL_DESTRUCTIVE_SANDBOX").as_deref() != Ok("1")
        || record.port.get() == 3002
    {
        return;
    }
    let Ok(port_root) = record.port_root() else {
        return;
    };
    if !port_root.starts_with("/tmp/") {
        return;
    }

    // This seam is deliberately limited to disposable Docker sandboxes. A
    // non-catchable signal models abrupt controller loss without allowing
    // cleanup code to make the durable boundary artificially safer.
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
}
