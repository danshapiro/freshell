use freshell_runtime_protocol::{
    host_proof, HostBootId, IncarnationId, RuntimeError, RuntimeErrorCode,
};

pub fn authenticate_command(
    secret: &[u8],
    host_boot_id: &HostBootId,
    incarnation_id: &IncarnationId,
    supplied: Option<&str>,
) -> Result<(), RuntimeError> {
    let expected = host_proof(secret, "command-auth", host_boot_id, incarnation_id);
    if supplied != Some(expected.as_str()) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::HostAuthenticationFailed,
            "invalid incarnation command proof",
        ));
    }
    Ok(())
}
