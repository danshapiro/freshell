//! One finite metadata request from an owned parent. No provider is dispatched;
//! request and reply bodies use private pipes, never command arguments or logs.
use freshell_platform::claude_inputs::observation::{
    observe, ObservationReply, ObservationRequest, MAX_REPLY_BYTES, MAX_REQUEST_BYTES,
};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub(crate) fn serve_stdio() -> Result<(), String> {
    exchange(&mut std::io::stdin().lock(), &mut std::io::stdout().lock())
}

pub(crate) fn serve_private() -> Result<(), String> {
    let mut input =
        std::os::unix::net::UnixStream::connect("/run/freshell-source-exchange/reply.sock")
            .map_err(|_| "Claude observation private exchange unavailable")?;
    let timeout = Some(std::time::Duration::from_secs(15));
    input
        .set_read_timeout(timeout)
        .map_err(|_| "Claude observation private timeout unavailable")?;
    input
        .set_write_timeout(timeout)
        .map_err(|_| "Claude observation private timeout unavailable")?;
    let mut output = input
        .try_clone()
        .map_err(|_| "Claude observation private exchange unavailable")?;
    exchange(&mut input, &mut output)
}

fn exchange(input: &mut impl Read, output: &mut impl Write) -> Result<(), String> {
    let mut length = [0; 4];
    input
        .read_exact(&mut length)
        .map_err(|_| "Claude observation request header unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_REQUEST_BYTES {
        return Err(
            "Claude observation request exceeds the metadata profile; retain inputs and reprepare"
                .into(),
        );
    }
    let mut raw = Vec::new();
    raw.try_reserve_exact(length)
        .map_err(|_| "Claude observation request allocation unavailable")?;
    raw.resize(length, 0);
    input
        .read_exact(&mut raw)
        .map_err(|_| "Claude observation request incomplete")?;
    let request: ObservationRequest = serde_json::from_slice(&raw)
        .map_err(|_| "Claude observation request is invalid; retain inputs and reprepare")?;
    request.validate()?;
    let cwd = std::env::current_dir().map_err(|_| {
        "Claude observation native launch cwd is unavailable; retain inputs and repair it"
    })?;
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or("Claude observation native HOME is unavailable; retain inputs and repair it")?;
    if cwd != request.cwd || home != request.home {
        return Err("Claude observation native launch cwd or HOME changed; retain inputs and reprepare before dispatch".into());
    }
    let observation = observe(
        &cwd,
        &home,
        request.native_source_runtime,
        &request.setting_sources,
    )?;
    let reply = ObservationReply {
        request_sha256: format!("{:x}", Sha256::digest(&raw)),
        observation,
    };
    let bytes =
        freshell_runtime_protocol::bounded_json_bytes(&reply, MAX_REPLY_BYTES).map_err(|_| {
            "Claude observation reply exceeds the metadata profile; retain inputs and reprepare"
        })?;
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| "Claude observation response header unavailable")?;
    output
        .write_all(&bytes)
        .map_err(|_| "Claude observation response incomplete")?;
    output
        .flush()
        .map_err(|_| "Claude observation response incomplete")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Error, ErrorKind};

    struct HeaderOnly {
        header: Cursor<[u8; 4]>,
        body_reads: usize,
    }
    impl Read for HeaderOnly {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if self.header.position() == 4 {
                self.body_reads += 1;
                return Err(Error::new(ErrorKind::Other, "body must remain unread"));
            }
            self.header.read(bytes)
        }
    }

    #[test]
    fn claude_observation_rejects_oversized_header_before_reading_or_allocating_body() {
        for length in [MAX_REQUEST_BYTES as u32 + 1, u32::MAX] {
            let mut input = HeaderOnly {
                header: Cursor::new(length.to_be_bytes()),
                body_reads: 0,
            };
            let mut output = Vec::new();
            let error = exchange(&mut input, &mut output).unwrap_err();
            assert!(error.contains("exceeds the metadata profile"));
            assert_eq!(input.body_reads, 0);
            assert!(output.is_empty());
        }
    }

    #[test]
    fn claude_observation_incomplete_request_never_emits_partial_evidence_or_private_input() {
        let private = b"PRIVATE_INCOMPLETE_METADATA_SENTINEL";
        let mut input = Vec::from((private.len() as u32 + 1).to_be_bytes());
        input.extend(private);
        let mut output = Vec::new();
        let error = exchange(&mut Cursor::new(input), &mut output).unwrap_err();
        assert!(error.contains("request incomplete"));
        assert!(!error
            .as_bytes()
            .windows(private.len())
            .any(|window| window == private));
        assert!(output.is_empty());
    }
}
