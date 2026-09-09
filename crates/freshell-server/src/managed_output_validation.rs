//! Authenticated transport does not replace per-message ownership validation.
use freshell_runtime_protocol::RuntimeOutputBatch;

pub(super) fn validate(output: &RuntimeOutputBatch, terminal_id: &str) -> Result<(), String> {
    if output.terminal_id != terminal_id || output.stream_epoch.is_empty() {
        return Err("managed output source identity mismatch".into());
    }
    if output.head_seq > i64::MAX as u64
        || output.retained_from_seq == 0
        || output.retained_from_seq > output.head_seq.saturating_add(1)
    {
        return Err("managed output has invalid retained sequence bounds".into());
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
            stream_epoch: "source".into(),
            retained_from_seq: 1,
            head_seq: 2,
            reset_required: false,
            truncated: false,
            exited: false,
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
