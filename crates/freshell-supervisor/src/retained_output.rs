use crate::registry::RetainedOutputSource;
use freshell_runtime_protocol::{
    terminal_spool::{
        build_spool_index, encode_spool_index, read_indexed_spool, read_spool_index,
        scan_spool_from, write_spool_index_checkpoint, IndexedSpoolRead, IndexedSpoolReadError,
        IndexedSpoolSegment, TerminalSpoolIndex, TerminalSpoolIndexEntry, MAX_SPOOL_INDEX_BYTES,
        MAX_SPOOL_LINE_BYTES, SPOOL_COMPLETION_FILE, SPOOL_CURRENT_FILE, SPOOL_CURRENT_INDEX_FILE,
        SPOOL_DESCRIPTOR_FILE, SPOOL_INDEX_STRIDE_BYTES, SPOOL_PREVIOUS_FILE,
        SPOOL_PREVIOUS_INDEX_FILE,
    },
    RuntimeOutputBatch, TerminalExitObservation, TerminalSpoolCompletion, TerminalSpoolDescriptor,
};
use std::{
    fs::{File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

#[cfg(test)]
std::thread_local! {
    static FORCED_INDEX_REBUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(crate) fn validate_source(
    source: &RetainedOutputSource,
    runtime_root: &Path,
) -> Result<(), String> {
    let directory = std::fs::canonicalize(&source.runtime_dir)
        .map_err(|_| "retained output directory unavailable")?;
    if directory != runtime_root.join(source.incarnation_id.as_str()) {
        return Err("retained output directory does not belong to the owned incarnation".into());
    }
    for name in [
        SPOOL_DESCRIPTOR_FILE,
        SPOOL_COMPLETION_FILE,
        SPOOL_CURRENT_FILE,
        SPOOL_PREVIOUS_FILE,
        SPOOL_CURRENT_INDEX_FILE,
        SPOOL_PREVIOUS_INDEX_FILE,
    ] {
        match std::fs::symlink_metadata(directory.join(name)) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err("retained output source must be an owned regular file".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("retained output source metadata unavailable".into()),
        }
    }
    Ok(())
}

fn metadata<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = File::open(path).map_err(|_| "retained output metadata unavailable")?;
    let mut bytes = Vec::new();
    file.take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "retained metadata read failed")?;
    if bytes.len() > 16384 {
        return Err("retained output metadata exceeds bound".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid retained output metadata".into())
}
pub(crate) fn read(
    source: RetainedOutputSource,
    after: u64,
    budget: u64,
    expected_epoch: Option<String>,
    verified_empty: bool,
) -> Result<RuntimeOutputBatch, String> {
    let descriptor: TerminalSpoolDescriptor =
        metadata(&source.runtime_dir.join(SPOOL_DESCRIPTOR_FILE))?;
    descriptor.validate()?;
    if descriptor.incarnation_id != source.incarnation_id
        || descriptor.terminal_id != source.terminal.terminal_id
        || !descriptor
            .stream_epoch
            .starts_with(&format!("{}-", source.terminal.stream_id))
    {
        return Err("retained output source association mismatch".into());
    }
    let completion_path = source.runtime_dir.join(SPOOL_COMPLETION_FILE);
    let completion = match metadata::<TerminalSpoolCompletion>(&completion_path) {
        Ok(completion) => Some(completion),
        Err(_) if !completion_path.exists() => None,
        Err(error) => return Err(error),
    };

    let changed = expected_epoch
        .as_deref()
        .is_some_and(|epoch| epoch != descriptor.stream_epoch);
    let read_after = if changed { 0 } else { after };
    let indexed = read_indexed(
        &source,
        &descriptor,
        read_after,
        budget,
        completion.clone(),
        false,
    );
    let indexed = match indexed {
        Err(IndexedSpoolReadError::InvalidIndex(_)) => {
            // Rebuild only when the sidecar's offsets or bounds disagree with
            // the authoritative spool. Page-budget and spool errors must not
            // trigger another full scan.
            read_indexed(&source, &descriptor, read_after, budget, completion, true)
        }
        result => result,
    };
    let mut batch = indexed.map_err(|error| error.to_string())?.batch;
    if changed {
        batch.reset_required = true;
        batch.truncated = true;
    }

    if batch.completion.is_none() && verified_empty {
        let completed = TerminalSpoolCompletion {
            incarnation_id: descriptor.incarnation_id.clone(),
            terminal_id: descriptor.terminal_id.clone(),
            stream_epoch: descriptor.stream_epoch.clone(),
            retained_from_seq: batch.retained_from_seq,
            head_seq: batch.head_seq,
            exit: TerminalExitObservation::Unavailable,
        };
        completed.validate(&descriptor, batch.head_seq)?;
        let temporary = completion_path.with_extension("tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| "completion unavailable")?;
        let bytes = serde_json::to_vec(&completed).map_err(|_| "completion encoding failed")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "completion write failed")?;
        std::fs::rename(temporary, &completion_path).map_err(|_| "completion commit failed")?;
        File::open(&source.runtime_dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "completion parent sync failed")?;
        batch.completion = Some(completed);
        batch.exited = true;
        batch.exit_code = None;
    }
    batch.native_session_id = source.native_session_id;
    Ok(batch)
}

fn read_indexed(
    source: &RetainedOutputSource,
    descriptor: &TerminalSpoolDescriptor,
    after: u64,
    budget: u64,
    completion: Option<TerminalSpoolCompletion>,
    rebuild: bool,
) -> Result<IndexedSpoolRead, IndexedSpoolReadError> {
    #[cfg(test)]
    if rebuild {
        FORCED_INDEX_REBUILDS.with(|count| count.set(count.get() + 1));
    }

    let mut segments = Vec::with_capacity(2);
    for (spool_name, index_name, required) in [
        (SPOOL_PREVIOUS_FILE, SPOOL_PREVIOUS_INDEX_FILE, false),
        (SPOOL_CURRENT_FILE, SPOOL_CURRENT_INDEX_FILE, true),
    ] {
        let spool_path = source.runtime_dir.join(spool_name);
        let file = match File::open(&spool_path) {
            Ok(file) => file,
            Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("retained output spool unavailable".into()),
        };
        let file_bytes = file
            .metadata()
            .map_err(|_| "retained spool metadata unavailable")?
            .len();
        if file_bytes > descriptor.segment_limit_bytes {
            return Err("retained spool exceeds segment bound".into());
        }

        let index_path = source.runtime_dir.join(index_name);
        let indexed = if !rebuild {
            match File::open(&index_path) {
                Ok(index_file) => {
                    let index_bytes = index_file
                        .metadata()
                        .map_err(|_| "retained output index metadata unavailable")?
                        .len();
                    if index_bytes > MAX_SPOOL_INDEX_BYTES as u64 {
                        None
                    } else {
                        match read_spool_index(BufReader::new(index_file), descriptor, file_bytes) {
                            Ok(mut indexed) => {
                                extend_index_if_needed(
                                    &file,
                                    &index_path,
                                    descriptor,
                                    file_bytes,
                                    &mut indexed,
                                )?;
                                Some(indexed)
                            }
                            Err(_) => None,
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("retained output index unavailable".into()),
            }
        } else {
            None
        };
        let indexed = match indexed {
            Some(indexed) => indexed,
            None => {
                let (checkpoints, _, summary) = build_spool_index(
                    BufReader::new(
                        file.try_clone()
                            .map_err(|_| "retained output spool unavailable")?,
                    ),
                    descriptor,
                    0,
                )?;
                let scanned_through_offset = if checkpoints.is_empty() {
                    summary.last_complete_offset
                } else {
                    0
                };
                let torn_tail = summary.torn_tail;
                write_index_atomic(
                    &index_path,
                    descriptor,
                    &checkpoints,
                    file_bytes,
                    scanned_through_offset,
                    torn_tail,
                )?;
                TerminalSpoolIndex {
                    checkpoints,
                    scanned_through_offset,
                    torn_tail,
                }
            }
        };
        segments.push(IndexedSpoolSegment {
            reader: BufReader::new(file),
            file_bytes,
            checkpoints: indexed.checkpoints,
            torn_tail: indexed.torn_tail,
        });
    }
    read_indexed_spool(descriptor.clone(), segments, after, budget, completion)
}

fn extend_index_if_needed(
    spool: &File,
    index_path: &Path,
    descriptor: &TerminalSpoolDescriptor,
    file_bytes: u64,
    indexed: &mut TerminalSpoolIndex,
) -> Result<(), IndexedSpoolReadError> {
    if indexed.checkpoints.is_empty() {
        if file_bytes <= indexed.scanned_through_offset {
            return Ok(());
        }
        let mut reader = BufReader::new(
            spool
                .try_clone()
                .map_err(|_| "retained output spool unavailable")?,
        );
        reader
            .seek(SeekFrom::Start(indexed.scanned_through_offset))
            .map_err(|_| "retained output seek failed")?;
        let (new_checkpoints, _, summary) =
            build_spool_index(&mut reader, descriptor, indexed.scanned_through_offset)?;
        indexed.checkpoints.extend(new_checkpoints);
        let scanned_through_offset = if indexed.checkpoints.is_empty() {
            summary.last_complete_offset
        } else {
            0
        };
        indexed.torn_tail |= summary.torn_tail;
        let spool_bytes = spool
            .metadata()
            .map_err(|_| "retained spool metadata unavailable")?
            .len();
        if spool_bytes > descriptor.segment_limit_bytes {
            return Err("retained spool exceeds segment bound".into());
        }
        write_index_atomic(
            index_path,
            descriptor,
            &indexed.checkpoints,
            spool_bytes,
            scanned_through_offset,
            indexed.torn_tail,
        )?;
        indexed.scanned_through_offset = scanned_through_offset;
        return Ok(());
    }

    let mut last_checkpoint = indexed.checkpoints.last().copied().unwrap();
    if file_bytes.saturating_sub(last_checkpoint.offset)
        <= SPOOL_INDEX_STRIDE_BYTES + MAX_SPOOL_LINE_BYTES as u64
    {
        return Ok(());
    }

    let mut reader = BufReader::new(
        spool
            .try_clone()
            .map_err(|_| "retained output spool unavailable")?,
    );
    reader
        .seek(SeekFrom::Start(last_checkpoint.offset))
        .map_err(|_| "retained output seek failed")?;
    let mut first = true;
    let mut previous_seq = 0_u64;
    let mut appended = Vec::new();
    let mut invalid_index = false;
    let scan = scan_spool_from(
        &mut reader,
        descriptor,
        last_checkpoint.offset,
        |offset, frame| {
            if first {
                first = false;
                if frame.seq_start != last_checkpoint.seq {
                    invalid_index = true;
                    return Err("retained output index does not match its spool".into());
                }
            } else if frame.seq_start != previous_seq.saturating_add(1) {
                return Err("retained output sequences are not contiguous".into());
            }
            previous_seq = frame.seq_end;
            if !first && offset.saturating_sub(last_checkpoint.offset) >= SPOOL_INDEX_STRIDE_BYTES {
                let checkpoint = TerminalSpoolIndexEntry {
                    seq: frame.seq_start,
                    offset,
                };
                appended.push(checkpoint);
                last_checkpoint = checkpoint;
            }
            Ok(false)
        },
    );
    let summary = scan.map_err(|error| {
        if invalid_index {
            IndexedSpoolReadError::InvalidIndex(error)
        } else {
            IndexedSpoolReadError::Other(error)
        }
    })?;
    indexed.torn_tail |= summary.torn_tail;
    if first {
        return Err(IndexedSpoolReadError::InvalidIndex(
            "retained output index checkpoint is missing from its spool".into(),
        ));
    }
    if !appended.is_empty() {
        let mut index = OpenOptions::new()
            .append(true)
            .open(index_path)
            .map_err(|_| "retained output index unavailable")?;
        for checkpoint in &appended {
            write_spool_index_checkpoint(&mut index, *checkpoint)?;
        }
        index
            .sync_data()
            .map_err(|_| "retained output index sync failed")?;
        indexed.checkpoints.extend(appended);
    }
    Ok(())
}

fn write_index_atomic(
    path: &Path,
    descriptor: &TerminalSpoolDescriptor,
    checkpoints: &[freshell_runtime_protocol::terminal_spool::TerminalSpoolIndexEntry],
    spool_bytes: u64,
    scanned_through_offset: u64,
    torn_tail: bool,
) -> Result<(), String> {
    let bytes = encode_spool_index(
        descriptor,
        checkpoints,
        spool_bytes,
        scanned_through_offset,
        torn_tail,
    )?;
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "retained output index unavailable")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "retained output index write failed")?;
    std::fs::rename(&temporary, path).map_err(|_| "retained output index commit failed")?;
    File::open(
        path.parent()
            .ok_or("retained output directory unavailable")?,
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|_| "retained output index parent sync failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{
        terminal_spool::{write_spool_index_header, TerminalSpoolFrame, MAX_OUTPUT_FRAME_BYTES},
        IncarnationId, TerminalLaunchSpec,
    };

    #[test]
    fn legacy_supervisor_fallback_builds_and_reuses_sparse_spool_index() {
        let directory = tempfile::tempdir().unwrap();
        let incarnation_id = IncarnationId::new();
        let terminal_id = "retained-terminal";
        let stream_epoch = "launch-prefix-hostboot-indexed";
        let descriptor = TerminalSpoolDescriptor {
            schema_version: 1,
            incarnation_id,
            terminal_id: terminal_id.into(),
            stream_epoch: stream_epoch.into(),
            segment_limit_bytes: 32 * 1024 * 1024,
        };
        let make_source = || RetainedOutputSource {
            incarnation_id: descriptor.incarnation_id.clone(),
            runtime_dir: directory.path().to_path_buf(),
            terminal: serde_json::from_value::<TerminalLaunchSpec>(serde_json::json!({
                "terminalId":terminal_id,"streamId":"launch-prefix","mode":"shell",
                "program":"/bin/sh","cwd":"/workspace","runAsUid":65534,
                "runAsGid":0,"cols":120,"rows":30,"projectKey":"fixture",
                "workspacePath":"/workspace"
            }))
            .unwrap(),
            native_session_id: None,
        };
        let mut spool = File::create(directory.path().join(SPOOL_CURRENT_FILE)).unwrap();
        let payload = "x".repeat(MAX_OUTPUT_FRAME_BYTES);
        for seq in 1..=96 {
            let frame = freshell_runtime_protocol::RuntimeOutputFrame {
                terminal_id: terminal_id.into(),
                stream_epoch: stream_epoch.into(),
                seq_start: seq,
                seq_end: seq,
                data: payload.clone(),
            };
            serde_json::to_writer(&mut spool, &TerminalSpoolFrame { frame }).unwrap();
            spool.write_all(b"\n").unwrap();
        }
        spool.sync_all().unwrap();
        let spool_bytes = spool.metadata().unwrap().len();
        drop(spool);

        let first = read_indexed(
            &make_source(),
            &descriptor,
            94,
            MAX_OUTPUT_FRAME_BYTES as u64,
            None,
            false,
        )
        .unwrap();
        assert_eq!(first.batch.frames[0].seq_start, 95);
        assert!(directory.path().join(SPOOL_CURRENT_INDEX_FILE).is_file());

        let second = read_indexed(
            &make_source(),
            &descriptor,
            95,
            MAX_OUTPUT_FRAME_BYTES as u64,
            None,
            false,
        )
        .unwrap();
        assert_eq!(second.batch.frames[0].seq_start, 96);
        assert!(
            second.bytes_scanned < spool_bytes / 2,
            "supervisor replay scanned {} of {} spool bytes after indexing",
            second.bytes_scanned,
            spool_bytes
        );
    }

    #[test]
    fn legacy_supervisor_recovers_new_epoch_output_after_indexing_old_epoch_spool() {
        let directory = tempfile::tempdir().unwrap();
        let incarnation_id = IncarnationId::new();
        let terminal_id = "retained-terminal";
        let stream_epoch = "launch-prefix-hostboot-indexed";
        let descriptor = TerminalSpoolDescriptor {
            schema_version: 1,
            incarnation_id,
            terminal_id: terminal_id.into(),
            stream_epoch: stream_epoch.into(),
            segment_limit_bytes: 32 * 1024 * 1024,
        };
        let make_source = || RetainedOutputSource {
            incarnation_id: descriptor.incarnation_id.clone(),
            runtime_dir: directory.path().to_path_buf(),
            terminal: serde_json::from_value::<TerminalLaunchSpec>(serde_json::json!({
                "terminalId":terminal_id,"streamId":"launch-prefix","mode":"shell",
                "program":"/bin/sh","cwd":"/workspace","runAsUid":65534,
                "runAsGid":0,"cols":120,"rows":30,"projectKey":"fixture",
                "workspacePath":"/workspace"
            }))
            .unwrap(),
            native_session_id: None,
        };
        std::fs::write(
            directory.path().join(SPOOL_DESCRIPTOR_FILE),
            serde_json::to_vec(&descriptor).unwrap(),
        )
        .unwrap();
        let old_frame = freshell_runtime_protocol::RuntimeOutputFrame {
            terminal_id: terminal_id.into(),
            stream_epoch: "previous-host-epoch".into(),
            seq_start: 11,
            seq_end: 11,
            data: "old epoch output".into(),
        };
        let mut spool = File::create(directory.path().join(SPOOL_CURRENT_FILE)).unwrap();
        serde_json::to_writer(&mut spool, &TerminalSpoolFrame { frame: old_frame }).unwrap();
        spool.write_all(b"\n").unwrap();
        spool.sync_all().unwrap();
        drop(spool);

        let empty = read(make_source(), 0, MAX_OUTPUT_FRAME_BYTES as u64, None, false).unwrap();
        assert_eq!(empty.head_seq, 0);
        assert!(directory.path().join(SPOOL_CURRENT_INDEX_FILE).is_file());

        let frame = freshell_runtime_protocol::RuntimeOutputFrame {
            terminal_id: terminal_id.into(),
            stream_epoch: stream_epoch.into(),
            seq_start: 1,
            seq_end: 1,
            data: "durable before index checkpoint".into(),
        };
        let mut spool = OpenOptions::new()
            .append(true)
            .open(directory.path().join(SPOOL_CURRENT_FILE))
            .unwrap();
        serde_json::to_writer(&mut spool, &TerminalSpoolFrame { frame }).unwrap();
        spool.write_all(b"\n").unwrap();
        spool.sync_all().unwrap();

        let recovered = read(make_source(), 0, MAX_OUTPUT_FRAME_BYTES as u64, None, true).unwrap();
        assert_eq!(recovered.frames.len(), 1);
        assert_eq!(recovered.frames[0].seq_start, 1);
        assert_eq!(recovered.head_seq, 1);
        assert_eq!(recovered.completion.unwrap().head_seq, 1);
    }

    #[test]
    fn too_small_page_budget_does_not_force_a_full_spool_rebuild() {
        let directory = tempfile::tempdir().unwrap();
        let incarnation_id = IncarnationId::new();
        let terminal_id = "retained-terminal";
        let stream_epoch = "launch-prefix-hostboot-indexed";
        let source = RetainedOutputSource {
            incarnation_id: incarnation_id.clone(),
            runtime_dir: directory.path().to_path_buf(),
            terminal: serde_json::from_value::<TerminalLaunchSpec>(serde_json::json!({
                "terminalId":terminal_id,"streamId":"launch-prefix","mode":"shell",
                "program":"/bin/sh","cwd":"/workspace","runAsUid":65534,
                "runAsGid":0,"cols":120,"rows":30,"projectKey":"fixture",
                "workspacePath":"/workspace"
            }))
            .unwrap(),
            native_session_id: None,
        };
        let descriptor = TerminalSpoolDescriptor {
            schema_version: 1,
            incarnation_id,
            terminal_id: terminal_id.into(),
            stream_epoch: stream_epoch.into(),
            segment_limit_bytes: 32 * 1024 * 1024,
        };
        std::fs::write(
            directory.path().join(SPOOL_DESCRIPTOR_FILE),
            serde_json::to_vec(&descriptor).unwrap(),
        )
        .unwrap();

        let mut spool = File::create(directory.path().join(SPOOL_CURRENT_FILE)).unwrap();
        let make_frame = |seq| freshell_runtime_protocol::RuntimeOutputFrame {
            terminal_id: terminal_id.into(),
            stream_epoch: stream_epoch.into(),
            seq_start: seq,
            seq_end: seq,
            data: "x".repeat(MAX_OUTPUT_FRAME_BYTES),
        };
        let first_offset = 0;
        serde_json::to_writer(
            &mut spool,
            &TerminalSpoolFrame {
                frame: make_frame(1),
            },
        )
        .unwrap();
        spool.write_all(b"\n").unwrap();
        let broken_offset = spool.metadata().unwrap().len();
        spool.write_all(b"not-json\n").unwrap();
        let second_offset = spool.metadata().unwrap().len();
        serde_json::to_writer(
            &mut spool,
            &TerminalSpoolFrame {
                frame: make_frame(2),
            },
        )
        .unwrap();
        spool.write_all(b"\n").unwrap();
        spool.sync_all().unwrap();
        let spool_bytes = spool.metadata().unwrap().len();
        drop(spool);

        let mut index = File::create(directory.path().join(SPOOL_CURRENT_INDEX_FILE)).unwrap();
        write_spool_index_header(&mut index, &descriptor, 0, false).unwrap();
        write_spool_index_checkpoint(
            &mut index,
            TerminalSpoolIndexEntry {
                seq: 1,
                offset: first_offset,
            },
        )
        .unwrap();
        write_spool_index_checkpoint(
            &mut index,
            TerminalSpoolIndexEntry {
                seq: 2,
                offset: second_offset,
            },
        )
        .unwrap();
        index.sync_all().unwrap();
        assert!(broken_offset < second_offset && second_offset < spool_bytes);

        let rebuilds_before = FORCED_INDEX_REBUILDS.with(std::cell::Cell::get);
        let error = read(source, 0, 1, None, false).unwrap_err();
        let rebuilds_after = FORCED_INDEX_REBUILDS.with(std::cell::Cell::get);
        assert!(
            error.contains("output budget cannot hold"),
            "a page-budget error should be returned without rescanning the spool: {error}"
        );
        assert_eq!(
            rebuilds_after, rebuilds_before,
            "a page-budget error must not force an index rebuild"
        );
    }
}
