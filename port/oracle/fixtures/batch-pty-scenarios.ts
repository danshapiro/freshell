/**
 * Deterministic PTY scenarios for the equivalence oracle's T1 **batch-framing** rung
 * (`terminal.output.batch`, capability `terminalOutputBatchV1`).
 *
 * Reuses the four simple `PTY_SCENARIOS` (so batch-on is proven to deliver identical
 * bytes to batch-off) and adds scenarios that exercise the batch path specifically:
 *   - a multi-line merge burst (contiguous transparent-ground frames coalesce);
 *   - a MULTIBYTE-UTF-8 payload (emoji + CJK) so the UTF-8-bytes vs UTF-16-offset
 *     distinction bites on the live wire (`terminal-core.md §9.3`, Top risk #2);
 *   - an ANSI barrier sequence (SGR color = control barriers) so the stateful scanner
 *     splits the stream (`§4.4`).
 *
 * DETERMINISM: as with the base scenarios, every payload is byte-stable ASCII/UTF-8
 * with fixed output (no clock/pid/path). The multibyte bytes are written verbatim by
 * `printf '\xNN'`, and node-pty's StringDecoder reassembles partial UTF-8 sequences, so
 * the REASSEMBLED data is deterministic even though raw read-chunk boundaries are not.
 *
 * NOTE (why the batch SEGMENT structure is NOT a golden): the live batch segment set is
 * chunk-nondeterministic (proven empirically — two boots of the ORIGINAL produce
 * different batch groupings). So the live rung asserts the reassembled DATA (byte-exact
 * original≡rust≡golden) + per-batch structural INVARIANTS + the UTF-16 offset proof; the
 * byte-exact batch STRUCTURE proof is the deterministic crate golden test
 * (`crates/freshell-terminal/tests/batch_wire_golden.rs`).
 */
import { PTY_SCENARIOS, type PtyScenario } from './pty-scenarios.js'

/** Extra batch-specific scenarios (appended to the four base scenarios). */
export const BATCH_EXTRA_SCENARIOS: readonly PtyScenario[] = [
  {
    name: 'merge-burst',
    description: 'a four-line burst from one printf — contiguous transparent-ground frames coalesce',
    shell: 'system',
    mode: 'shell',
    inputLines: [String.raw`printf 'aa\nbb\ncc\ndd\n'`],
    expectedGolden: 'aa\r\nbb\r\ncc\r\ndd\r\n',
  },
  {
    name: 'multibyte-utf16',
    description: 'emoji (4 bytes / 2 UTF-16 units) + CJK (3 bytes / 1 unit) — proves endOffset is UTF-16, not bytes',
    shell: 'system',
    mode: 'shell',
    // printf writes the raw UTF-8 bytes for "a😀b中文": a f0 9f 98 80 b e4 b8 ad e6 96 87
    inputLines: [String.raw`printf 'a\xf0\x9f\x98\x80b\xe4\xb8\xad\xe6\x96\x87\n'`],
    expectedGolden: 'a\u{1F600}b\u4e2d\u6587\r\n',
  },
  {
    name: 'barrier-sgr',
    description: 'ANSI SGR color escapes (ESC[..m) = control barriers — the stateful scanner splits the stream',
    shell: 'system',
    mode: 'shell',
    inputLines: [String.raw`printf '\033[31mRED\033[0m\n'`],
    expectedGolden: '\u001b[31mRED\u001b[0m\r\n',
  },
] as const

/** The full batch scenario set: the four base scenarios + the batch-specific extras. */
export const BATCH_PTY_SCENARIOS: readonly PtyScenario[] = [
  ...PTY_SCENARIOS,
  ...BATCH_EXTRA_SCENARIOS,
] as const
