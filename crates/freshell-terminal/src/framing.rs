//! Output framing — an **identical port** of `appendOutputFrames`
//! (`broker.ts:803-826`) and `buildTerminalOutputPayload` (`broker.ts:2132-2152`).
//!
//! Raw PTY output (a decoded UTF-8 string, spec `§9.1`) becomes seq-numbered
//! [`ReplayFrame`]s via the [`fragment`](crate::fragment) code-point budget splitter
//! and the authoritative [`ReplayRing`](crate::replay_ring), then each frame is
//! projected to a frozen [`ServerMessage::TerminalOutput`] wire message
//! (`terminal.output`, batchV1 off — one frame per message, spec `§4.1`).
//!
//! ## 3.3a scope
//!
//! `terminal.output.batch` (the merge/segments/serializedBytes path) is deferred to
//! 3.3b; this module emits only the legacy per-frame `terminal.output`, which is the
//! variant a client that advertises no `terminalOutputBatchV1` capability receives —
//! exactly what the T1 capture harness uses (`pty-capture.ts:33-36,314-315`).

use freshell_protocol::{OutputSource, ServerMessage, TerminalOutput};

use crate::fragment::{
    fragment_terminal_output_for_payload_budget, measure_terminal_output_budget_payload_bytes,
    terminal_stream_batch_max_bytes,
};
use crate::replay_ring::{ReplayFrame, ReplayRing};

/// Frames one terminal's live output stream into `terminal.output` messages.
///
/// Owns the authoritative [`ReplayRing`] and the stable `terminalId` / `streamId`.
/// (In 3.3b, `streamId` becomes replaceable via the stream-identity generation
/// counter; here it is fixed for the terminal's lifetime.)
#[derive(Debug)]
pub struct OutputFramer {
    ring: ReplayRing,
    terminal_id: String,
    stream_id: String,
    batch_max_bytes: usize,
}

impl OutputFramer {
    pub fn new(terminal_id: String, stream_id: String, ring_max_bytes: Option<i64>) -> Self {
        Self {
            ring: ReplayRing::new(ring_max_bytes),
            terminal_id,
            stream_id,
            batch_max_bytes: terminal_stream_batch_max_bytes(),
        }
    }

    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn head_seq(&self) -> i64 {
        self.ring.head_seq()
    }

    /// `appendOutputFrames` (`broker.ts:803-826`): fragment `data` to the payload
    /// budget, then append each fragment to the ring (one seq per fragment).
    ///
    /// # Panics
    /// Only if the batch budget (>= 16 KiB) cannot fit a single code point — an
    /// impossible invariant violation for the real budget (the reference `throw`s
    /// here too, `output-fragments.ts:52`).
    pub fn append_output_frames(&mut self, data: &str) -> Vec<ReplayFrame> {
        // Clone ids into locals so the measure closure borrows them, not `self`,
        // leaving `self.ring` free to mutate in the append loop below.
        let terminal_id = self.terminal_id.clone();
        let stream_id = self.stream_id.clone();

        let fragments =
            fragment_terminal_output_for_payload_budget(data, self.batch_max_bytes, |chunk| {
                measure_terminal_output_budget_payload_bytes(&terminal_id, &stream_id, chunk)
            })
            .expect("terminal.output batch budget (>= 16 KiB) always fits one code point");

        let mut frames = Vec::with_capacity(fragments.len());
        for fragment in &fragments {
            frames.push(self.ring.append(fragment, &stream_id));
        }
        frames
    }

    /// Frame `data` and project the resulting frames to frozen `terminal.output`
    /// wire messages. Live output uses `source: 'live'` (`onTerminalOutputRaw` ->
    /// live flush). `attachRequestId`/replay-source (attach path) are 3.3b.
    pub fn append_output(&mut self, data: &str) -> Vec<ServerMessage> {
        let terminal_id = self.terminal_id.clone();
        self.append_output_frames(data)
            .into_iter()
            .map(|frame| frame_to_terminal_output(&terminal_id, frame, OutputSource::Live))
            .collect()
    }
}

/// `buildTerminalOutputPayload` (`broker.ts:2132-2152`) for one frame: raw UTF-8
/// `data`, `seqStart == seqEnd` (one frame per message), `source` set, and
/// `attachRequestId` omitted-when-falsy (`None` here — no attach in 3.3a).
pub fn frame_to_terminal_output(
    terminal_id: &str,
    frame: ReplayFrame,
    source: OutputSource,
) -> ServerMessage {
    ServerMessage::TerminalOutput(TerminalOutput {
        data: frame.data,
        seq_start: frame.seq_start,
        seq_end: frame.seq_end,
        stream_id: frame.stream_id,
        terminal_id: terminal_id.to_string(),
        attach_request_id: None,
        source: Some(source),
    })
}

/// Reassemble a set of captured server messages into the terminal's byte stream, the
/// way the T1 capture harness does (`pty-capture.ts:139-144` `reassemble` +
/// `collectOutput`): keep this terminal's `terminal.output` frames for `stream_id`,
/// order by `seqStart`, concatenate `data`. Real PTY read-chunk boundaries are
/// nondeterministic; this reassembled byte stream is not (the T1 thesis).
pub fn reassemble_stream(messages: &[ServerMessage], stream_id: &str) -> String {
    let mut frames: Vec<(&i64, &str)> = messages
        .iter()
        .filter_map(|m| match m {
            ServerMessage::TerminalOutput(o) if o.stream_id == stream_id => {
                Some((&o.seq_start, o.data.as_str()))
            }
            _ => None,
        })
        .collect();
    frames.sort_by_key(|(seq, _)| **seq);
    frames.into_iter().map(|(_, data)| data).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_of(msg: &ServerMessage) -> &str {
        match msg {
            ServerMessage::TerminalOutput(o) => &o.data,
            _ => panic!("expected terminal.output"),
        }
    }

    fn seqs_of(msg: &ServerMessage) -> (i64, i64) {
        match msg {
            ServerMessage::TerminalOutput(o) => (o.seq_start, o.seq_end),
            _ => panic!("expected terminal.output"),
        }
    }

    #[test]
    fn small_output_is_one_frame_seq_one() {
        let mut framer = OutputFramer::new("term".into(), "stream".into(), None);
        let msgs = framer.append_output("hello\r\n");
        assert_eq!(msgs.len(), 1);
        assert_eq!(seqs_of(&msgs[0]), (1, 1));
        assert_eq!(data_of(&msgs[0]), "hello\r\n");
        match &msgs[0] {
            ServerMessage::TerminalOutput(o) => {
                assert_eq!(o.stream_id, "stream");
                assert_eq!(o.terminal_id, "term");
                assert_eq!(o.source, Some(OutputSource::Live));
                assert_eq!(o.attach_request_id, None);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn successive_appends_increment_seq_contiguously() {
        let mut framer = OutputFramer::new("term".into(), "stream".into(), None);
        let a = framer.append_output("1\r\n");
        let b = framer.append_output("2\r\n");
        let c = framer.append_output("3\r\n");
        assert_eq!(seqs_of(&a[0]), (1, 1));
        assert_eq!(seqs_of(&b[0]), (2, 2));
        assert_eq!(seqs_of(&c[0]), (3, 3));
        assert_eq!(framer.head_seq(), 3);
    }

    #[test]
    fn reassembly_ignores_chunk_boundaries_and_other_streams() {
        let mut framer = OutputFramer::new("term".into(), "stream".into(), None);
        // Arbitrary read-chunk boundaries splitting "line-1\r\nline-2\r\n".
        let mut all = Vec::new();
        for chunk in ["li", "ne-1\r", "\nline-2", "\r\n"] {
            all.extend(framer.append_output(chunk));
        }
        // A frame from a different stream must be excluded by reassembly.
        all.push(ServerMessage::TerminalOutput(TerminalOutput {
            data: "GHOST".into(),
            seq_start: 1,
            seq_end: 1,
            stream_id: "other-stream".into(),
            terminal_id: "term".into(),
            attach_request_id: None,
            source: Some(OutputSource::Live),
        }));
        assert_eq!(reassemble_stream(&all, "stream"), "line-1\r\nline-2\r\n");
    }

    #[test]
    fn oversize_output_splits_but_reassembles_exactly() {
        let mut framer = OutputFramer::new("term".into(), "stream".into(), None);
        let data = "A".repeat(40_000);
        let msgs = framer.append_output(&data);
        assert!(msgs.len() >= 3, "40k splits across several 16 KiB budgets");
        // Seqs are contiguous 1..=n.
        for (i, m) in msgs.iter().enumerate() {
            assert_eq!(seqs_of(m), (i as i64 + 1, i as i64 + 1));
        }
        assert_eq!(reassemble_stream(&msgs, "stream"), data);
    }
}
