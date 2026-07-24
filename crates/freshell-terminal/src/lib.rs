//! # freshell-terminal (Phase 3.3a CORE)
//!
//! The PTY core the equivalence oracle's **T1** rung grades: real pseudo-terminal
//! spawn + the authoritative seq'd replay buffer + `terminal.output` framing, exact
//! enough to reproduce the committed goldens (`port/oracle/baselines/pty/*.golden`)
//! **byte-for-byte** at the crate level.
//!
//! This is the **highest fidelity-risk crate** (`port/machine/specs/terminal-core.md`).
//! Every module is an identical port of a reference file, cited at `file:line`:
//!
//! | Module | Ports | Role |
//! |---|---|---|
//! | [`fragment`] | `output-fragments.ts` + `serialized-budget.ts` | code-point payload-budget splitter |
//! | [`replay_ring`] | `replay-deque.ts` + `replay-ring.ts` (byte slice) | the seq'd, byte-measured authoritative buffer |
//! | [`decode`] | node-pty's `StringDecoder` role | streaming UTF-8 decode of raw PTY bytes |
//! | [`framing`] | `broker.ts` `appendOutputFrames` / `buildTerminalOutputPayload` | raw output -> `terminal.output` messages |
//! | [`pty`] | `terminal-registry.ts` spawn + `onData` path | real portable-pty spawn/read/write/reap |
//! | [`barrier_scanner`] | `output-barrier-scanner.ts` | stateful VT parser (batch merge boundaries) |
//! | [`batch`] | `output-batch.ts` + broker wire projection | `terminal.output.batch` framing (UTF-16 offsets, `serializedBytes`) |
//! | [`chunk_ring`] | `ChunkRingBuffer` (`terminal-registry.ts:810-853`) | char-measured scrollback + snapshot seed |
//!
//! ## Two framing variants (capability-gated, `§4.1`/`§4.2`)
//!
//! - **`terminal.output`** (batchV1 OFF, the default) — one frame per message, raw
//!   UTF-8 `data`. This is what a client advertising no capability receives, and it is
//!   the byte-exact path the oracle's **T1** rung grades. [`framing`].
//! - **`terminal.output.batch`** (batchV1 ON) — contiguous transparent-ground frames
//!   merged, each carrying a UTF-16 `endOffset` + `rawFrameCount`, the batch a
//!   self-referential `serializedBytes`. The stateful [`barrier_scanner`] decides merge
//!   boundaries. [`batch`]. Gated by `hello.capabilities.terminalOutputBatchV1`.
//!
//! **In:** PTY spawn via [`freshell_platform`]'s `SpawnSpec`; reading PTY bytes;
//! the byte-measured, seq-numbered [`ReplayRing`](replay_ring::ReplayRing); fragmenting
//! output into frames with the code-point-budget splitter; UTF-8 decoding; both output
//! framing variants; the char-measured [`ChunkRingBuffer`](chunk_ring::ChunkRingBuffer).

pub mod barrier_scanner;
pub mod batch;
pub mod chunk_ring;
pub mod decode;
pub mod fragment;
pub mod framing;
pub mod output_queue;
pub mod pty;
pub mod registry;
pub mod replay_ring;

pub use barrier_scanner::{
    BarrierClassification, BarrierReason, BarrierScanner, ScannerMode, ScannerState,
};
pub use batch::{
    build_terminal_output_batches, frames_to_wire_payloads, slice_utf16, utf16_len,
    BatchBuildInput, BatchInputFrame, OutputBatch,
};
pub use chunk_ring::{snapshot_seed_if_ring_empty, ChunkRingBuffer};
pub use decode::Utf8StreamDecoder;
pub use framing::{reassemble_stream, OutputFramer};
pub use pty::{build_child_env, build_child_env_from_process, MessageSink, PtyTerminal};
pub use registry::{
    compute_scrollback_max_bytes, ActivityEvent, ActivityObserver, AttachOutcome, FrameSink,
    TerminalRegistry,
};
pub use replay_ring::{ReplayDeque, ReplayFrame, ReplayRing};
