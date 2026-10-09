//! One attempt's bounded indexed file publication over private Unix IPC.
//! Frames and acknowledgements contain no payload in diagnostic output.
use serde::{Deserialize, Serialize};

pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Begin {
        source_ids: Vec<u16>,
    },
    Open {
        source_id: u16,
    },
    Chunk {
        #[serde(deserialize_with = "bounded_chunk")]
        bytes: Vec<u8>,
    },
    Finish,
    Seal,
    Release,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Acknowledgement {
    Begun,
    Opened,
    Written,
    Finished,
    Populated,
    Released,
}

#[cfg(unix)]
pub fn serve(root: &std::path::Path, socket: &std::path::Path) -> Result<(), &'static str> {
    use std::{
        collections::BTreeSet,
        io::Write,
        os::unix::{
            fs::{DirBuilderExt, OpenOptionsExt},
            net::UnixStream,
        },
    };
    if std::fs::canonicalize(root).map_err(|_| "indexed input root is unavailable")? != root
        || !std::fs::symlink_metadata(root)
            .map_err(|_| "indexed input root metadata failed")?
            .is_dir()
    {
        return Err("indexed input root must be physical");
    }
    let mut stream =
        UnixStream::connect(socket).map_err(|_| "input publication exchange is unavailable")?;
    let operation_timeout = Some(std::time::Duration::from_secs(20));
    stream
        .set_read_timeout(operation_timeout)
        .map_err(|_| "input publication timeout setup failed")?;
    stream
        .set_write_timeout(operation_timeout)
        .map_err(|_| "input publication timeout setup failed")?;
    let Request::Begin { source_ids } = read_request(&mut stream)? else {
        return Err("input publication must begin with selected source ids");
    };
    let selected = source_ids.iter().copied().collect::<BTreeSet<_>>();
    if selected.len() != source_ids.len()
        || selected.len() > 128
        || selected.iter().any(|id| *id >= 128)
    {
        return Err("input publication source ids exceed profile");
    }
    let files = root.join("files");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&files)
        .map_err(|_| "input publication directory is not fresh")?;
    write_acknowledgement(&mut stream, &Acknowledgement::Begun)?;
    let mut completed = BTreeSet::new();
    let mut active: Option<(u16, std::fs::File, u64)> = None;
    let mut total = 0u64;
    loop {
        let request = read_request(&mut stream)?;
        let acknowledgement = match request {
            Request::Open { source_id } => {
                if active.is_some()
                    || !selected.contains(&source_id)
                    || completed.contains(&source_id)
                {
                    return Err("input publication source order is invalid");
                }
                let file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(files.join(format!("source-{source_id}")))
                    .map_err(|_| "input publication private file creation failed")?;
                active = Some((source_id, file, 0));
                Acknowledgement::Opened
            }
            Request::Chunk { bytes } => {
                let (_, file, written) = active
                    .as_mut()
                    .ok_or("input publication chunk has no selected source")?;
                if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
                    return Err("input publication chunk exceeds profile");
                }
                let next = written
                    .checked_add(bytes.len() as u64)
                    .ok_or("input publication size overflow")?;
                let next_total = total
                    .checked_add(bytes.len() as u64)
                    .ok_or("input publication size overflow")?;
                if next > MAX_FILE_BYTES || next_total > MAX_TOTAL_BYTES {
                    return Err("input publication payload exceeds profile");
                }
                file.write_all(&bytes)
                    .map_err(|_| "input publication private file write failed")?;
                *written = next;
                total = next_total;
                Acknowledgement::Written
            }
            Request::Finish => {
                let (id, file, _) = active
                    .take()
                    .ok_or("input publication completion has no source")?;
                file.sync_all()
                    .map_err(|_| "input publication private file flush failed")?;
                completed.insert(id);
                Acknowledgement::Finished
            }
            Request::Seal => {
                if active.is_some() || completed != selected {
                    return Err("input publication cannot seal incomplete sources");
                }
                write_acknowledgement(&mut stream, &Acknowledgement::Populated)?;
                // This connection keeps the exact helper and its active tmpfs
                // mount alive while the workload mounts and accepts the grant.
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(120)))
                    .map_err(|_| "input publication holding timeout setup failed")?;
                if !matches!(read_request(&mut stream)?, Request::Release) {
                    return Err("sealed input publication accepts only owned release");
                }
                write_acknowledgement(&mut stream, &Acknowledgement::Released)?;
                return Ok(());
            }
            Request::Begin { .. } | Request::Release => {
                return Err("input publication phase is invalid")
            }
        };
        write_acknowledgement(&mut stream, &acknowledgement)?;
    }
}

fn bounded_chunk<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    struct ChunkVisitor;
    impl<'de> serde::de::Visitor<'de> for ChunkVisitor {
        type Value = Vec<u8>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a bounded private byte chunk")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut bytes = Vec::new();
            while let Some(byte) = sequence.next_element::<u8>()? {
                if bytes.len() == MAX_CHUNK_BYTES {
                    return Err(serde::de::Error::custom("private chunk exceeds limit"));
                }
                if bytes.len() == bytes.capacity() {
                    bytes.reserve((MAX_CHUNK_BYTES - bytes.len()).min(bytes.capacity().max(64)));
                }
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }
    deserializer.deserialize_seq(ChunkVisitor)
}

pub fn read_request(reader: &mut impl std::io::Read) -> Result<Request, &'static str> {
    let mut length = [0; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| "input publication frame is unavailable")?;
    let length = u32::from_be_bytes(length) as usize;
    if length >= MAX_FRAME_BYTES {
        return Err("input publication frame exceeds limit");
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| "input publication frame is incomplete")?;
    serde_json::from_slice(&bytes).map_err(|_| "input publication frame is invalid or over-bound")
}

struct FrameBuffer(Vec<u8>);
impl std::io::Write for FrameBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() >= MAX_FRAME_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other(
                "input publication frame exceeds limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn write_request(
    writer: &mut impl std::io::Write,
    request: &Request,
) -> Result<(), &'static str> {
    if matches!(request,Request::Chunk{bytes} if bytes.len()>MAX_CHUNK_BYTES) {
        return Err("input publication chunk exceeds profile");
    }
    write_frame(writer, request)
}
pub fn write_acknowledgement(
    writer: &mut impl std::io::Write,
    acknowledgement: &Acknowledgement,
) -> Result<(), &'static str> {
    write_frame(writer, acknowledgement)
}
fn write_frame(
    writer: &mut impl std::io::Write,
    value: &impl Serialize,
) -> Result<(), &'static str> {
    let mut frame = FrameBuffer(Vec::new());
    serde_json::to_writer(&mut frame, value)
        .map_err(|_| "input publication frame exceeds limit")?;
    writer
        .write_all(&(frame.0.len() as u32).to_be_bytes())
        .map_err(|_| "input publication frame write failed")?;
    writer
        .write_all(&frame.0)
        .map_err(|_| "input publication frame write failed")?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::net::UnixListener,
    };

    fn send(stream: &mut std::os::unix::net::UnixStream, request: &Request) -> Acknowledgement {
        let frame = serde_json::to_vec(request).unwrap();
        assert!(frame.len() < MAX_FRAME_BYTES);
        stream
            .write_all(&(frame.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&frame).unwrap();
        let mut length = [0; 4];
        stream.read_exact(&mut length).unwrap();
        let mut response = vec![0; u32::from_be_bytes(length) as usize];
        stream.read_exact(&mut response).unwrap();
        serde_json::from_slice(&response).unwrap()
    }

    #[test]
    fn provider_input_exchange_publishes_private_files_and_holds_active_generation_until_release() {
        let owned = tempfile::tempdir().unwrap();
        let root = owned.path().join("indexed");
        std::fs::create_dir(&root).unwrap();
        let socket = owned.path().join("exchange.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let published_root = root.clone();
        let worker = std::thread::spawn(move || serve(&published_root, &socket));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(pair) => break pair,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "publisher did not connect to private exchange"
                    );
                    std::thread::yield_now();
                }
                Err(error) => panic!("owned exchange accept failed: {error}"),
            }
        };
        assert!(
            send(
                &mut stream,
                &Request::Begin {
                    source_ids: vec![0, 1]
                }
            ) == Acknowledgement::Begun
        );
        for (source_id, nonce) in [
            (0, b"first-private-nonce".as_slice()),
            (1, b"second-private-nonce".as_slice()),
        ] {
            assert!(send(&mut stream, &Request::Open { source_id }) == Acknowledgement::Opened);
            assert!(
                send(
                    &mut stream,
                    &Request::Chunk {
                        bytes: nonce.to_vec()
                    }
                ) == Acknowledgement::Written
            );
            assert!(send(&mut stream, &Request::Finish) == Acknowledgement::Finished);
        }
        assert!(send(&mut stream, &Request::Seal) == Acknowledgement::Populated);
        assert!(
            !worker.is_finished(),
            "publisher must retain its active mount until workload acceptance"
        );
        use std::os::unix::fs::PermissionsExt;
        for (source_id, nonce) in [
            (0, b"first-private-nonce".as_slice()),
            (1, b"second-private-nonce".as_slice()),
        ] {
            let file = root.join(format!("files/source-{source_id}"));
            assert_eq!(std::fs::read(&file).unwrap(), nonce);
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(send(&mut stream, &Request::Release) == Acknowledgement::Released);
        assert!(worker.join().unwrap().is_ok());
    }

    #[test]
    fn provider_input_exchange_rejects_actual_oversized_chunks_and_frames_before_publication() {
        let too_large = serde_json::to_vec(&Request::Chunk {
            bytes: vec![255; MAX_CHUNK_BYTES + 1],
        })
        .unwrap();
        let mut wire = (too_large.len() as u32).to_be_bytes().to_vec();
        wire.extend(too_large);
        let error = read_request(&mut std::io::Cursor::new(wire)).err().unwrap();
        assert!(!error.contains("255"));
        let mut frame_header = std::io::Cursor::new((MAX_FRAME_BYTES as u32).to_be_bytes());
        assert!(read_request(&mut frame_header).is_err());
        let mut encoded = Vec::new();
        assert!(write_request(
            &mut encoded,
            &Request::Chunk {
                bytes: vec![0; MAX_CHUNK_BYTES + 1]
            }
        )
        .is_err());
        assert!(encoded.is_empty());
        let mut accepted = Vec::new();
        write_request(
            &mut accepted,
            &Request::Chunk {
                bytes: vec![255; MAX_CHUNK_BYTES],
            },
        )
        .unwrap();
        let Request::Chunk { bytes } = read_request(&mut std::io::Cursor::new(accepted)).unwrap()
        else {
            panic!("expected private chunk");
        };
        assert_eq!(bytes.len(), MAX_CHUNK_BYTES);
    }

    #[test]
    fn provider_input_exchange_actual_capacity_and_overflow_preserve_prior_generation() {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let prior = owned.path().join("prior");
        std::fs::create_dir(&prior).unwrap();
        std::fs::write(prior.join("nonce"), b"prior-indexed-generation").unwrap();
        for (case, ids, payloads, expected_success) in [
            ("exact", 128u16, vec![MAX_FILE_BYTES, MAX_FILE_BYTES], true),
            ("file-over", 1, vec![MAX_FILE_BYTES + 1], false),
            (
                "total-over",
                3,
                vec![MAX_FILE_BYTES, MAX_FILE_BYTES, 1],
                false,
            ),
            ("source-over", 129, vec![], false),
        ] {
            let root = owned.path().join(case);
            std::fs::create_dir(&root).unwrap();
            let socket = owned.path().join(format!("{case}.sock"));
            let listener = UnixListener::bind(&socket).unwrap();
            listener.set_nonblocking(true).unwrap();
            let outcome = std::thread::scope(|scope| {
                let worker = scope.spawn(|| serve(&root, &socket));
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(pair) => break pair,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "private capacity publisher did not connect"
                            );
                            std::thread::yield_now();
                        }
                        Err(_) => panic!("private capacity accept failed"),
                    }
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(20)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(std::time::Duration::from_secs(20)))
                    .unwrap();
                let acknowledged = |stream: &mut std::os::unix::net::UnixStream,
                                    request: Request,
                                    expected: Acknowledgement| {
                    write_request(stream, &request).unwrap();
                    let mut length = [0; 4];
                    if stream.read_exact(&mut length).is_err() {
                        return false;
                    }
                    let length = u32::from_be_bytes(length) as usize;
                    assert!(length < MAX_FRAME_BYTES);
                    let mut response = vec![0; length];
                    stream.read_exact(&mut response).unwrap();
                    serde_json::from_slice::<Acknowledgement>(&response).unwrap() == expected
                };
                let mut accepted = acknowledged(
                    &mut stream,
                    Request::Begin {
                        source_ids: (0..ids).collect(),
                    },
                    Acknowledgement::Begun,
                );
                for id in 0..ids {
                    if !accepted {
                        break;
                    }
                    accepted = acknowledged(
                        &mut stream,
                        Request::Open { source_id: id },
                        Acknowledgement::Opened,
                    );
                    let mut remaining = payloads.get(id as usize).copied().unwrap_or(0);
                    while accepted && remaining != 0 {
                        let length = remaining.min(MAX_CHUNK_BYTES as u64) as usize;
                        accepted = acknowledged(
                            &mut stream,
                            Request::Chunk {
                                bytes: vec![0x5a; length],
                            },
                            Acknowledgement::Written,
                        );
                        remaining -= length as u64;
                    }
                    if accepted {
                        accepted =
                            acknowledged(&mut stream, Request::Finish, Acknowledgement::Finished);
                    }
                }
                if accepted {
                    accepted = acknowledged(&mut stream, Request::Seal, Acknowledgement::Populated);
                    assert!(
                        !worker.is_finished(),
                        "exact full generation must remain leased until release"
                    );
                    if accepted {
                        accepted =
                            acknowledged(&mut stream, Request::Release, Acknowledgement::Released);
                    }
                }
                drop(stream);
                let result = worker.join().unwrap();
                (accepted, result)
            });
            assert_eq!(outcome.0, expected_success, "capacity case {case}");
            assert_eq!(outcome.1.is_ok(), expected_success, "capacity case {case}");
            if expected_success {
                assert_eq!(std::fs::read_dir(root.join("files")).unwrap().count(), 128);
                for id in 0..128 {
                    let path = root.join(format!("files/source-{id}"));
                    assert_eq!(
                        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                    let mut input = std::fs::File::open(path).unwrap();
                    let mut bytes = 0u64;
                    let mut block = [0; MAX_CHUNK_BYTES];
                    loop {
                        let length = input.read(&mut block).unwrap();
                        if length == 0 {
                            break;
                        }
                        assert!(block[..length].iter().all(|byte| *byte == 0x5a));
                        bytes += length as u64;
                    }
                    assert_eq!(bytes, payloads.get(id as usize).copied().unwrap_or(0));
                }
            } else {
                assert!(
                    outcome.1.unwrap_err().len() < 128,
                    "failure remains a fixed diagnostic without payload"
                );
                match case {
                    "file-over" => {
                        assert_eq!(
                            std::fs::metadata(root.join("files/source-0"))
                                .unwrap()
                                .len(),
                            MAX_FILE_BYTES
                        );
                    }
                    "total-over" => {
                        for id in 0..2 {
                            assert_eq!(
                                std::fs::metadata(root.join(format!("files/source-{id}")))
                                    .unwrap()
                                    .len(),
                                MAX_FILE_BYTES
                            );
                        }
                        assert_eq!(
                            std::fs::metadata(root.join("files/source-2"))
                                .unwrap()
                                .len(),
                            0,
                            "over-budget byte must not be written"
                        );
                    }
                    "source-over" => assert!(
                        !root.join("files").exists(),
                        "source-count overflow must precede private-file allocation"
                    ),
                    _ => unreachable!(),
                }
            }
            assert_eq!(
                std::fs::read(prior.join("nonce")).unwrap(),
                b"prior-indexed-generation"
            );
            std::fs::remove_dir_all(&root).unwrap();
            assert!(
                !root.exists(),
                "failed attempt's indexed files are removable without prior-generation mutation"
            );
        }
    }
}
