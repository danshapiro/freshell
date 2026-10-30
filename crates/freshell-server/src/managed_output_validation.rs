//! Authenticated transport does not replace per-message ownership validation.
use freshell_runtime_protocol::RuntimeOutputBatch;

pub(super) fn validate(output: &RuntimeOutputBatch, terminal_id: &str) -> Result<(), String> {
    if output.terminal_id != terminal_id || output.stream_epoch.is_empty() {
        return Err("managed output source identity mismatch".into());
    }
    if let Some(native) = &output.opencode_activity {
        native.validate().map_err(str::to_string)?;
    }
    if output.head_seq > i64::MAX as u64
        || output.retained_from_seq == 0
        || output.retained_from_seq > output.head_seq.saturating_add(1)
    {
        return Err("managed output has invalid retained sequence bounds".into());
    }
    if let Some(completion) = &output.completion {
        let source = freshell_runtime_protocol::TerminalSpoolDescriptor {
            schema_version: 1,
            incarnation_id: output.incarnation_id.clone(),
            terminal_id: output.terminal_id.clone(),
            stream_epoch: output.stream_epoch.clone(),
            segment_limit_bytes: freshell_runtime_protocol::terminal_spool::MAX_SPOOL_SEGMENT_BYTES,
        };
        completion.validate(&source, output.head_seq)?;
        let expected_code = match completion.exit {
            freshell_runtime_protocol::TerminalExitObservation::Known { code } => Some(code),
            freshell_runtime_protocol::TerminalExitObservation::Unavailable => None,
        };
        if !output.exited
            || completion.retained_from_seq != output.retained_from_seq
            || output.exit_code != expected_code
        {
            return Err("managed output completion disagrees with sampled lifecycle".into());
        }
    }
    let mut previous = None;
    for frame in &output.frames {
        if frame.terminal_id != terminal_id || frame.stream_epoch != output.stream_epoch {
            return Err("managed output frame source identity mismatch".into());
        }
        if frame.seq_start < output.retained_from_seq
            || frame.seq_end < frame.seq_start
            || frame.seq_end > output.head_seq
            || previous.is_some_and(|seq| frame.seq_start <= seq)
        {
            return Err("managed output frame sequence is invalid or out of order".into());
        }
        previous = Some(frame.seq_end);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{IncarnationId, RuntimeOutputFrame};

    fn batch() -> RuntimeOutputBatch {
        RuntimeOutputBatch {
            incarnation_id: IncarnationId::new(),
            terminal_id: "owned".into(),
            codex_activity: None,
            opencode_activity: None,
            stream_epoch: "source".into(),
            retained_from_seq: 1,
            head_seq: 2,
            reset_required: false,
            truncated: false,
            exited: false,
            completion: None,
            exit_code: None,
            native_session_id: Some("native-owned".into()),
            frames: vec![RuntimeOutputFrame {
                terminal_id: "owned".into(),
                stream_epoch: "source".into(),
                seq_start: 1,
                seq_end: 2,
                data: "safe fixture".into(),
            }],
        }
    }

    #[test]
    fn validates_a_bounded_retained_source_and_an_empty_fresh_epoch() {
        assert!(validate(&batch(), "owned").is_ok());
        let mut empty = batch();
        empty.head_seq = 0;
        empty.frames.clear();
        assert!(validate(&empty, "owned").is_ok());
    }

    #[test]
    fn rejects_foreign_or_missing_stream_identity_without_echoing_payloads() {
        let mut malformed = batch();
        malformed.frames[0].stream_epoch = "foreign".into();
        malformed.frames[0].data = "synthetic-secret-never-log".into();
        let error = validate(&malformed, "owned").unwrap_err();
        assert!(!error.contains("synthetic-secret-never-log"));
        malformed = batch();
        malformed.frames[0].terminal_id = "foreign".into();
        assert!(validate(&malformed, "owned").is_err());
        malformed = batch();
        malformed.stream_epoch.clear();
        assert!(validate(&malformed, "owned").is_err());
    }

    #[test]
    fn rejects_completion_from_a_different_source_or_sampled_final_head() {
        use freshell_runtime_protocol::{TerminalExitObservation, TerminalSpoolCompletion};
        let mut complete = batch();
        complete.exited = true;
        complete.exit_code = Some(7);
        complete.completion = Some(TerminalSpoolCompletion {
            incarnation_id: complete.incarnation_id.clone(),
            terminal_id: complete.terminal_id.clone(),
            stream_epoch: complete.stream_epoch.clone(),
            retained_from_seq: 1,
            head_seq: 2,
            exit: TerminalExitObservation::Known { code: 7 },
        });
        assert!(validate(&complete, "owned").is_ok());
        for mutation in 0..7 {
            let mut malformed = complete.clone();
            let completion = malformed.completion.as_mut().unwrap();
            match mutation {
                0 => completion.terminal_id = "foreign".into(),
                1 => completion.incarnation_id = IncarnationId::new(),
                2 => completion.stream_epoch = "foreign-epoch".into(),
                3 => completion.head_seq = 1,
                4 => completion.retained_from_seq = 3,
                5 => malformed.exited = false,
                _ => malformed.exit_code = None,
            }
            assert!(
                validate(&malformed, "owned").is_err(),
                "completion mismatch {mutation} must not complete a facade"
            );
        }
    }

    #[test]
    fn rejects_overflow_duplicate_and_out_of_bounds_sequences() {
        let mut malformed = batch();
        malformed.head_seq = u64::MAX;
        assert!(validate(&malformed, "owned").is_err());
        malformed = batch();
        malformed.retained_from_seq = 0;
        assert!(validate(&malformed, "owned").is_err());
        malformed = batch();
        malformed.frames[0].seq_end = 3;
        assert!(validate(&malformed, "owned").is_err());
        malformed = batch();
        malformed.frames.push(malformed.frames[0].clone());
        assert!(validate(&malformed, "owned").is_err());
    }
}
