use crate::registry::RetainedOutputSource;
use freshell_runtime_protocol::{
    terminal_spool::{
        scan_spool, RetainedOutputPage, SPOOL_COMPLETION_FILE, SPOOL_CURRENT_FILE,
        SPOOL_DESCRIPTOR_FILE, SPOOL_PREVIOUS_FILE,
    },
    RuntimeOutputBatch, TerminalExitObservation, TerminalSpoolCompletion, TerminalSpoolDescriptor,
};
use std::{
    fs::{File, OpenOptions},
    io::{BufReader, Read, Write},
    path::Path,
};

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
fn scan(
    source: &RetainedOutputSource,
    descriptor: &TerminalSpoolDescriptor,
    mut accept: impl FnMut(freshell_runtime_protocol::RuntimeOutputFrame) -> Result<(), String>,
) -> Result<bool, String> {
    let mut torn = false;
    for (name, required) in [(SPOOL_PREVIOUS_FILE, false), (SPOOL_CURRENT_FILE, true)] {
        let file = match File::open(source.runtime_dir.join(name)) {
            Ok(file) => file,
            Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("retained output spool unavailable".into()),
        };
        if file
            .metadata()
            .map_err(|_| "retained spool metadata unavailable")?
            .len()
            > descriptor.segment_limit_bytes
        {
            return Err("retained spool exceeds segment bound".into());
        }
        torn |= scan_spool(BufReader::new(file), descriptor, &mut accept)?;
    }
    Ok(torn)
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
    let mut first = None;
    let mut head = 0;
    scan(&source, &descriptor, |frame| {
        first.get_or_insert(frame.seq_start);
        head = frame.seq_end;
        Ok(())
    })?;
    let retained = first.unwrap_or(head.saturating_add(1));
    let changed = expected_epoch
        .as_deref()
        .is_some_and(|epoch| epoch != descriptor.stream_epoch);
    let reset = changed || after > head || after.saturating_add(1) < retained;
    let effective = if reset {
        retained.saturating_sub(1)
    } else {
        after
    };
    let completion_path = source.runtime_dir.join(SPOOL_COMPLETION_FILE);
    let completion = match metadata::<TerminalSpoolCompletion>(&completion_path) {
        Ok(completion) => Some(completion),
        Err(_) if !completion_path.exists() && !verified_empty => None,
        Err(_) if !completion_path.exists() && verified_empty => {
            // An exact backend empty proof settles a writer whose host could
            // not commit EOF. Freeze its actual retained head; code is unknown.
            let completion = TerminalSpoolCompletion {
                incarnation_id: descriptor.incarnation_id.clone(),
                terminal_id: descriptor.terminal_id.clone(),
                stream_epoch: descriptor.stream_epoch.clone(),
                retained_from_seq: retained,
                head_seq: head,
                exit: TerminalExitObservation::Unavailable,
            };
            let temporary = completion_path.with_extension("tmp");
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)
                .map_err(|_| "completion unavailable")?;
            let bytes =
                serde_json::to_vec(&completion).map_err(|_| "completion encoding failed")?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "completion write failed")?;
            std::fs::rename(temporary, &completion_path).map_err(|_| "completion commit failed")?;
            File::open(&source.runtime_dir)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| "completion parent sync failed")?;
            Some(completion)
        }
        Err(error) => return Err(error),
    };
    let mut page = RetainedOutputPage::new(descriptor.clone(), effective, budget)?;
    let torn = scan(&source, &descriptor, |frame| page.accept(frame))?;
    let mut batch = page.finish(torn, completion)?;
    batch.reset_required |= reset;
    batch.truncated |= reset;
    batch.native_session_id = source.native_session_id;
    Ok(batch)
}
