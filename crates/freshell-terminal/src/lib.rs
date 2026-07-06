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
//! | [`stub_3b`] | (deferred) | 3.3b surface stubs (batch, barrier scanner, gaps, resize, snapshot) |
//!
//! ## In scope (3.3a) vs deferred (3.3b, see [`stub_3b`])
//!
//! **In:** PTY spawn via [`freshell_platform`]'s `SpawnSpec`; reading PTY bytes;
//! the byte-measured, seq-numbered [`ReplayRing`](replay_ring::ReplayRing); fragmenting
//! output into `terminal.output`-shaped frames with the code-point-budget splitter;
//! UTF-8 decoding.
//!
//! **Out (3.3b):** `terminal.output.batch` + the stateful VT barrier scanner + UTF-16
//! `endOffset`/`serializedBytes`; the char-measured ChunkRingBuffer attach snapshot;
//! gap emission; resize/geometry-epoch; coding-CLI `turn.complete`.

pub mod decode;
pub mod fragment;
pub mod framing;
pub mod pty;
pub mod registry;
pub mod replay_ring;
pub mod stub_3b;

pub use decode::Utf8StreamDecoder;
pub use framing::{reassemble_stream, OutputFramer};
pub use pty::{build_child_env, build_child_env_from_process, MessageSink, PtyTerminal};
pub use registry::{AttachOutcome, FrameSink, TerminalRegistry};
pub use replay_ring::{ReplayDeque, ReplayFrame, ReplayRing};
