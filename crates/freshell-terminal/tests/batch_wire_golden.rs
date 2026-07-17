//! **Batch-framing fidelity test** — the acceptance gate for the deferred 3.3b work
//! (`terminal.output.batch`).
//!
//! The live-wire batch SEGMENT structure is chunk-nondeterministic (node-pty read
//! boundaries + flush timing vary the frame set boot-to-boot — proven empirically), so
//! the byte-exact original-vs-rust proof cannot be a live capture. Instead it is done
//! HERE, over FIXED frame sequences, against goldens generated from the ORIGINAL's own
//! source-of-truth logic (`port/oracle/baselines/batch/generate-batch-goldens.ts`
//! imports `createTerminalOutputBarrierScanner` + `buildTerminalOutputBatches` +
//! `measureTerminalOutputPayloadBytes`).
//!
//! For every committed scenario this test:
//!   1. verifies the golden file's own sha256 (committed-golden integrity);
//!   2. reconstructs the scenario's fragments, classifies them with the Rust
//!      [`BarrierScanner`], builds batches + the wire projection with the SAME ids and
//!      budgets the generator used;
//!   3. asserts the Rust wire payloads are **byte-identical** (canonical sorted-key
//!      JSON) to the golden payloads — every `endOffset` (UTF-16 code units),
//!      `rawFrameCount`, `barrier` reason, `data`, and `serializedBytes`.
//!
//! A mismatch is a REAL fidelity failure (prints the first differing payload); it never
//! rewrites the golden. This is the deterministic ORIGINAL≡RUST batch-framing proof.

use std::path::PathBuf;

use freshell_terminal::batch::{
    build_batch_wire_payloads, build_terminal_output_batches, BatchBuildInput,
};
use freshell_terminal::{BarrierScanner, BatchInputFrame};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn baseline_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = <worktree>/crates/freshell-terminal
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../port/oracle/baselines/batch")
}

fn read_to_string(path: &PathBuf) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Recursively sort object keys → a stable canonical string form (matches the
/// generator's `sortKeys` + `JSON.stringify`), so the comparison is byte-exact and
/// order-independent regardless of serde_json's `preserve_order`.
fn canonical(value: &Value) -> String {
    fn sort(v: &Value) -> Value {
        match v {
            Value::Array(a) => Value::Array(a.iter().map(sort).collect()),
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                let mut m = serde_json::Map::new();
                for k in keys {
                    m.insert(k.clone(), sort(&o[k]));
                }
                Value::Object(m)
            }
            other => other.clone(),
        }
    }
    serde_json::to_string(&sort(value)).expect("serialize canonical json")
}

/// The generator's `classifyFrames` (`replay-ring.ts:62-79`): run each fragment through
/// one persistent scanner, seqs 1..N, one frame per fragment.
fn classify(fragments: &[String], stream_id: &str) -> Vec<BatchInputFrame> {
    let mut scanner = BarrierScanner::new();
    fragments
        .iter()
        .enumerate()
        .map(|(i, data)| {
            let c = scanner.scan(data);
            BatchInputFrame {
                seq_start: (i + 1) as i64,
                seq_end: (i + 1) as i64,
                data: data.clone(),
                bytes: data.len(),
                stream_id: stream_id.to_string(),
                barrier: c.barrier,
                barrier_reason: c.reason,
                state_before: c.state_before,
                state_after: c.state_after,
            }
        })
        .collect()
}

/// Reproduce the wire payloads for one golden scenario from the Rust port.
fn reproduce(golden: &Value) -> Vec<Value> {
    let terminal_id = golden["terminalId"].as_str().unwrap();
    let stream_id = golden["streamId"].as_str().unwrap();
    let attach_request_id = golden["attachRequestId"].as_str().unwrap();
    let source = golden["source"].as_str().unwrap();
    let merge_max = golden["mergeMaxBytes"].as_i64().unwrap();
    let batch_max = golden["batchMaxBytes"].as_i64().unwrap();
    let fragments: Vec<String> = golden["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    let frames = classify(&fragments, stream_id);
    let batches = build_terminal_output_batches(&BatchBuildInput {
        frames: &frames,
        max_serialized_bytes: merge_max,
        max_total_serialized_bytes: None,
        terminal_id: terminal_id.to_string(),
        attach_request_id: Some(attach_request_id.to_string()),
        source: Some(source.to_string()),
    });
    let mut out = Vec::new();
    for batch in &batches {
        out.extend(build_batch_wire_payloads(
            terminal_id,
            batch,
            attach_request_id,
            source,
            batch_max,
        ));
    }
    out
}

/// Every committed batch golden (kept in lockstep with the generator's SCENARIOS).
const SCENARIOS: &[&str] = &[
    "single-ground",
    "multi-merge",
    "barrier-control-sgr",
    "barrier-turn-complete-bel",
    "barrier-request-mode-dsr",
    "barrier-startup-probe-da",
    "barrier-osc52",
    "multibyte-utf16",
    "stateful-csi-split",
    "over-budget-split",
];

fn load_golden(name: &str) -> Value {
    let dir = baseline_dir();
    let golden_path = dir.join(format!("{name}.batch.json"));
    let meta_path = dir.join(format!("{name}.batch.meta.json"));
    let raw = read_to_string(&golden_path);
    // sha256 is computed over the canonical string WITHOUT the trailing newline.
    let content = raw.trim_end_matches('\n');
    let meta: Value = serde_json::from_str(&read_to_string(&meta_path)).expect("parse meta json");
    let expected = meta["sha256"].as_str().unwrap();
    assert_eq!(
        sha256_hex(content.as_bytes()),
        expected,
        "committed batch golden {name} failed its own sha256 (was it hand-edited?)"
    );
    serde_json::from_str(content).expect("parse golden json")
}

#[test]
fn rust_batch_framing_reproduces_every_committed_golden_byte_for_byte() {
    let mut checked = 0usize;
    for name in SCENARIOS {
        let golden = load_golden(name);
        let expected: &Vec<Value> = golden["payloads"].as_array().unwrap();
        let actual = reproduce(&golden);

        assert_eq!(
            actual.len(),
            expected.len(),
            "[{name}] payload count: rust {} vs golden {}",
            actual.len(),
            expected.len()
        );
        for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            let ca = canonical(a);
            let ce = canonical(e);
            assert_eq!(
                ca, ce,
                "[{name}] payload[{i}] diverged from the ORIGINAL-derived golden.\n  rust  : {ca}\n  golden: {ce}"
            );
        }
        checked += 1;
    }
    assert_eq!(checked, SCENARIOS.len());
}

#[test]
fn multibyte_golden_proves_endoffset_is_utf16_not_bytes() {
    // The dedicated §9.3 Top-risk-#2 assertion on the committed golden: the batch's
    // segment endOffsets are UTF-16 code units (emoji=2, CJK=1), NOT UTF-8 bytes.
    let golden = load_golden("multibyte-utf16");
    let payloads = golden["payloads"].as_array().unwrap();
    assert_eq!(payloads.len(), 1);
    let p = &payloads[0];
    assert_eq!(
        p["data"].as_str().unwrap(),
        "a\u{1F600}b\u{4E2D}\u{6587}\r\n"
    );
    let segs = p["segments"].as_array().unwrap();
    // frame 0 = "a😀b" → 1 + 2 + 1 = 4 UTF-16 units (would be 6 bytes).
    assert_eq!(segs[0]["endOffset"].as_i64().unwrap(), 4);
    // frame 1 = "中文\r\n" → 4 + 1 + 1 + 1 + 1 = 8 UTF-16 units (would be 14 bytes).
    assert_eq!(segs[1]["endOffset"].as_i64().unwrap(), 8);

    // And the Rust port reproduces exactly those UTF-16 offsets.
    let actual = reproduce(&golden);
    let seg0 = &actual[0]["segments"][0];
    let seg1 = &actual[0]["segments"][1];
    assert_eq!(
        seg0["endOffset"].as_i64().unwrap(),
        4,
        "rust emoji endOffset is UTF-16"
    );
    assert_eq!(
        seg1["endOffset"].as_i64().unwrap(),
        8,
        "rust CJK cumulative endOffset is UTF-16"
    );
    // Byte length of the data proves these are NOT byte offsets.
    assert_eq!(
        p["data"].as_str().unwrap().len(),
        14,
        "UTF-8 byte length (≠ the 8 UTF-16 endOffset)"
    );
}
