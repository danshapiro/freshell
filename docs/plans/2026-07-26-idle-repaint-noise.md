# Idle Repaint-Noise Reaping Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the idle auto-kill sweep reap detached terminals whose only "activity" is self-generated repaint noise (spinner frames, ticking elapsed-time counters, status-bar redraws), while never reaping detached terminals doing genuine work.

**Architecture:** Add a small, self-contained, stateful per-terminal `NoiseScanner` (new module `crates/freshell-terminal/src/idle_noise.rs`) that fingerprints each PTY output frame's escape-stripped, digit/spinner-glyph-stripped text. `ingest()` keeps bumping the wire-visible `last_activity_at` on every frame (unchanged legacy semantics), but only frames the scanner classifies as *meaningful* refresh a new private field `last_meaningful_activity_at`, which becomes the clock `enforce_idle_kills()` reads. Detection fails open: anything not provably a repeat of recent content counts as activity.

**Tech Stack:** Rust (crates/freshell-terminal), std-only (no new dependencies), FNV-1a hashing inline, colocated `#[cfg(test)]` unit tests, `cargo test` / `cargo clippy`.

## Global Constraints

- Rust server only: all code changes under `crates/`. The legacy `server/` tree is FROZEN — never modify it.
- Do NOT touch the client, and do NOT change attach/detach semantics (fixed in PR #534).
- Do NOT modify `crates/freshell-terminal/src/barrier_scanner.rs` — its module doc declares it "[PORT RISK — highest]"; batch-framing goldens depend on byte-exact behavior. The new scanner is a separate module.
- Wire-visible `lastActivityAt` semantics are UNCHANGED: still bumped on **every** PTY output frame and **every** input write (`port/machine/specs/terminal-core.md` §1.3). Only the reaper's clock changes; that deviation from legacy is recorded as DEV-0009 in `port/oracle/DEVIATIONS.md` (Task 3).
- `autoKillIdleMinutes <= 0` remains a disabled no-op, unchanged.
- No new settings field: `SettingsSafety` keeps exactly one field. All tuning knobs (fingerprint ring size, spinner-glyph set) are module constants.
- TDD Red-Green mandatory: write the failing test, run it, watch it fail, then implement.
- Test/build commands: `cargo test -p freshell-terminal` and `cargo clippy` run directly (no coordinator gate needed — that gate is only for broad Node suites, which this plan never touches).
- Many agents share this repo: never kill processes you don't own; do NOT restart the user's self-hosted freshell server.
- Conventional commits with crate scope, ending with the Amplifier trailer (exact text):

  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

---

## Background (read before any task)

**The bug.** `enforce_idle_kills()` (`crates/freshell-terminal/src/registry.rs`, `pub fn enforce_idle_kills`, currently ~line 731) reaps every DETACHED (`subscribers.is_empty()`) RUNNING terminal with `now - last_activity_at >= autoKillIdleMinutes * 60_000`. But `ingest()` (same file, free fn `fn ingest`, ~line 2139) bumps `s.last_activity_at = now_ms()` unconditionally on **every** PTY output frame. A detached coding-CLI TUI that merely repaints — codex's braille spinner plus its ticking `(Ns • esc to interrupt)` counter, claude's ticking `✻ Crunched for Ns` line, any status-bar clock — refreshes the stamp forever and is exempt from the reaper. This is inherited from legacy (`server/terminal-registry.ts:1684`), so the fix is a deliberate deviation requiring a `port/oracle/DEVIATIONS.md` entry (DEV-0009, Task 3). It caused the 2026-07-25 orphaned-terminal incident (10 detached CLIs alive 10–22h against a 3h threshold); the client-side half was fixed in PR #534.

**Why a new module and a new field (investigated alternatives):**
- The existing per-terminal `BarrierScanner` (`s.scanner.scan(&frame.data)` inside `ingest()`) is a VT *parser-state* classifier for batch merge boundaries — a spinner frame classifies identically to real output (`barrier: true, reason: Control`), so it cannot distinguish noise, and its file is the highest port risk in the crate (must not be perturbed).
- The TERM-15/TERM-16 CLI busy detection (`ActivityEvent::Output` tap → `freshell-ws/src/activity.rs`) is a separate mechanism, skipped entirely for `mode == "shell"`, and only does BEL turn-complete detection — no content-noise classification exists anywhere. We leave that tap completely untouched (no busy-status regression by construction).
- `last_activity_at` is wire-visible (`inventory()`, `DirectoryEntry`, sorting/pagination in `crates/freshell-server/src/terminals.rs`) and spec-pinned to "bumped on every PTY output". So the reaper gets its own private field instead of changing that one.

**Frame delivery facts the design relies on:** one PTY reader thread per terminal invokes the sink once per framed message; frames are split (never truncated) at `MAX_REALTIME_MESSAGE_BYTES = 16 * 1024`. A single spinner repaint normally arrives as ONE frame; a large redraw splits into a repeating *cycle* of frames. Hence the scanner (a) keeps its escape-parsing state across frames, and (b) compares each frame's fingerprint against a small ring of *recent* fingerprints, not just the previous frame.

**Detection model (what "meaningful" means):** For each frame, walk its chars with a minimal VT state machine (Ground / Esc / Csi / StringBody / StringEsc — mirrors the barrier scanner's modes without touching it). Only Ground-mode chars can contribute. A Ground char is *significant* unless it is whitespace, an ASCII digit, a Braille pattern (U+2800–U+28FF, codex's spinner), or one of a small explicit spinner-glyph set (claude's `✻`-family, the classic `|/-\` cycle). Fold significant chars into an FNV-1a 64-bit hash + count. A frame is **noise** when its significant count is 0 (pure cursor motion / erase / spinner glyph) OR its (hash, count) fingerprint matches one of the 8 most recent distinct fingerprints (a ticking counter differs only in digits → identical fingerprint; a split big redraw cycles within the ring). Otherwise it is **meaningful** and its fingerprint enters the ring. First occurrence of any status line therefore counts as activity (fail-open — correct: the reap clock starts at "last genuinely-new content").

**Test conventions in `registry.rs`'s `#[cfg(test)] mod tests`** (~line 2243): headless terminals via `reg.insert_headless("T", "S")` (mode `"shell"`, `pty: None`); frames built by the local helper `frame(seq, data, stream_id)` and driven through `reg.feed(id, frame)` which calls `ingest()` directly; `reg.set_auto_kill_idle_minutes(1)`; `reg.backdate_last_activity("T", ts)` avoids real sleeps; sinks via `collector()`. The existing idle-kill test block sits at ~lines 3392–3482.

Line numbers throughout this plan are current as of branch creation and may drift a few lines — always anchor by the quoted symbol/code, not the number.

---

### Task 1: `NoiseScanner` module (`idle_noise.rs`)

**Files:**
- Create: `crates/freshell-terminal/src/idle_noise.rs`
- Modify: `crates/freshell-terminal/src/lib.rs` (one line: declare the module)

**Interfaces:**
- Consumes: nothing (std-only, self-contained).
- Produces (Task 2 relies on these exact names):
  - `pub(crate) struct NoiseScanner`
  - `pub(crate) fn NoiseScanner::new() -> NoiseScanner`
  - `pub(crate) fn NoiseScanner::observe(&mut self, data: &str) -> bool` — `true` = meaningful activity, `false` = repaint noise. Stateful across calls (escape state and fingerprint ring persist).

- [ ] **Step 1: Declare the module**

Open `crates/freshell-terminal/src/lib.rs` and add, alongside the existing private module declarations (next to the line declaring the `barrier_scanner` module, matching its visibility style):

```rust
mod idle_noise;
```

Create `crates/freshell-terminal/src/idle_noise.rs` containing ONLY the skeleton below (so the failing tests compile-fail on missing behavior, not missing files):

```rust
//! Repaint-noise fingerprinting for the idle auto-kill sweep (DEV-0009).
//!
//! Distinguishes MEANINGFUL PTY output (genuinely new content: log lines,
//! streamed response text) from self-generated repaint noise (spinner frames,
//! ticking elapsed-time counters, status-bar redraws) so `enforce_idle_kills`
//! can reap detached terminals that are merely repainting. Detection fails
//! open: anything not provably a repeat of recent content counts as activity.
//!
//! Deliberately SEPARATE from `barrier_scanner.rs` ([PORT RISK — highest]):
//! that scanner decides `terminal.output.batch` merge boundaries and must stay
//! byte-exact with legacy; this one is a port-only addition (no wire-visible
//! output) and must never be merged into it.

/// How many recent distinct frame fingerprints to remember. A full-screen
/// redraw larger than the 16 KiB frame budget splits into a repeating CYCLE
/// of frames; membership in a small ring (rather than equality with only the
/// previous frame) still classifies the cycle as noise. 8 also absorbs small
/// spinner-word rotations without meaningfully delaying recognition of
/// genuine new output.
const RECENT_FINGERPRINTS: usize = 8;
```

- [ ] **Step 2: Write the failing tests**

Append to `crates/freshell-terminal/src/idle_noise.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_frame_with_new_text_is_meaningful() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("compiling freshell-terminal v0.1.0\n"));
    }

    #[test]
    fn repeated_identical_status_line_is_noise() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("\r\x1b[2Kbuilding... please wait"));
        assert!(!n.observe("\r\x1b[2Kbuilding... please wait"));
        assert!(!n.observe("\r\x1b[2Kbuilding... please wait"));
    }

    #[test]
    fn codex_style_spinner_and_ticking_counter_is_noise_after_first_frame() {
        let mut n = NoiseScanner::new();
        // First paint of the status line is genuinely new content.
        assert!(n.observe("\r\x1b[2K⠋ (1s • esc to interrupt)"));
        // Subsequent repaints differ only in braille glyph + digits.
        assert!(!n.observe("\r\x1b[2K⠙ (2s • esc to interrupt)"));
        assert!(!n.observe("\r\x1b[2K⠹ (3s • esc to interrupt)"));
        assert!(!n.observe("\r\x1b[2K⠸ (12s • esc to interrupt)"));
    }

    #[test]
    fn claude_style_ticking_crunch_line_is_noise_after_first_frame() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("\r\x1b[2K✻ Crunched for 5s · 1.2k tokens · esc to interrupt"));
        assert!(!n.observe("\r\x1b[2K✽ Crunched for 6s · 1.3k tokens · esc to interrupt"));
        assert!(!n.observe("\r\x1b[2K✻ Crunched for 17s · 2.0k tokens · esc to interrupt"));
    }

    #[test]
    fn status_bar_clock_redraw_is_noise_after_first_frame() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("\x1b[1;70Hbash | 12:34:56"));
        assert!(!n.observe("\x1b[1;70Hbash | 12:34:57"));
        assert!(!n.observe("\x1b[1;70Hbash | 12:35:03"));
    }

    #[test]
    fn pure_cursor_motion_frame_is_noise_even_when_first() {
        let mut n = NoiseScanner::new();
        assert!(!n.observe("\x1b[2K\x1b[1;1H\x1b[?25l"));
    }

    #[test]
    fn braille_only_spinner_frame_is_noise_even_when_first() {
        let mut n = NoiseScanner::new();
        assert!(!n.observe("\r⠋"));
        assert!(!n.observe("\r⠙"));
    }

    #[test]
    fn empty_frame_is_noise() {
        let mut n = NoiseScanner::new();
        assert!(!n.observe(""));
    }

    #[test]
    fn distinct_log_lines_are_each_meaningful() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("compiling freshell-terminal v0.1.0\n"));
        assert!(n.observe("warning: unused variable `x`\n"));
        assert!(n.observe("    Finished dev profile\n"));
    }

    #[test]
    fn streamed_response_text_chunks_are_meaningful() {
        // A coding CLI mid-turn streaming a response: every chunk is new prose.
        let mut n = NoiseScanner::new();
        assert!(n.observe("The registry keeps a per-terminal "));
        assert!(n.observe("replay ring whose frames are "));
        assert!(n.observe("classified by a persistent scanner."));
    }

    #[test]
    fn osc_title_payload_never_contributes_to_the_fingerprint() {
        // Terminal-title clock updates are string-body content, not Ground text.
        let mut n = NoiseScanner::new();
        assert!(!n.observe("\x1b]0;bash — 12:34\x07"));
        assert!(!n.observe("\x1b]0;bash — 12:35\x07"));
    }

    #[test]
    fn osc_split_across_frames_does_not_leak_payload_into_fingerprint() {
        let mut n = NoiseScanner::new();
        // Frame boundary lands MID-OSC: a stateless scanner would treat
        // "ock" in the second frame as Ground text and call it meaningful.
        assert!(!n.observe("\x1b]0;my title — cl"));
        assert!(!n.observe("ock\x07"));
    }

    #[test]
    fn csi_split_across_frames_does_not_corrupt_ground_text() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("hello"));
        // "\x1b[2" then "Khello": the K is the CSI final byte, so the second
        // frame's Ground text is exactly "hello" — already in the ring.
        assert!(!n.observe("\x1b[2"));
        assert!(!n.observe("Khello"));
    }

    #[test]
    fn alternating_repaint_cycle_is_noise_via_recent_ring() {
        // A big redraw split into two frames A, B repeating: A B A B ...
        // Comparing only against the immediately-previous frame would see
        // alternation as forever-new; ring membership must not.
        let mut n = NoiseScanner::new();
        let a = "\x1b[1;1Hpane one contents";
        let b = "\x1b[2;1Hstatus bar | ready";
        assert!(n.observe(a));
        assert!(n.observe(b));
        for _ in 0..5 {
            assert!(!n.observe(a));
            assert!(!n.observe(b));
        }
    }

    #[test]
    fn digits_only_change_is_noise() {
        let mut n = NoiseScanner::new();
        assert!(n.observe("Downloading 45% complete"));
        assert!(!n.observe("Downloading 46% complete"));
        assert!(!n.observe("Downloading 99% complete"));
    }

    #[test]
    fn ring_evicts_oldest_after_capacity() {
        // Pins FIFO eviction: after RECENT_FINGERPRINTS distinct newer
        // frames, the oldest fingerprint is forgotten and counts as new
        // again (fail-open by design). Fillers must differ in LETTERS
        // (digits are stripped from fingerprints). The array length is
        // 8 == RECENT_FINGERPRINTS; if the constant changes, change this
        // test with it — that is intentional pinning.
        let mut n = NoiseScanner::new();
        assert!(n.observe("line zero"));
        for word in ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] {
            assert!(n.observe(&format!("filler {word}")));
        }
        assert!(n.observe("line zero"));
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p freshell-terminal idle_noise -- --nocapture`
Expected: **compilation FAILURE** — `NoiseScanner` not found in `idle_noise` (the skeleton has no struct yet). A compile error on the missing type is the RED state for a brand-new module.

- [ ] **Step 4: Implement `NoiseScanner`**

Insert between the `RECENT_FINGERPRINTS` constant and the `#[cfg(test)]` module in `crates/freshell-terminal/src/idle_noise.rs`:

```rust
/// Minimal VT escape-consumption state, persisted ACROSS frames so an escape
/// sequence split at the 16 KiB frame boundary never leaks bytes into the
/// fingerprint. Mirrors the mode set of `barrier_scanner.rs` without touching
/// that file: OSC/DCS/APC/PM/SOS all share one string-body state because we
/// only need "not Ground", never which string it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoiseMode {
    Ground,
    Esc,
    Csi,
    /// Inside an OSC/DCS/APC/PM/SOS string body (until BEL or ESC `\`).
    StringBody,
    /// Saw ESC inside a string body (possible ST terminator).
    StringEsc,
}

/// One frame's content fingerprint: FNV-1a 64 over the frame's significant
/// Ground-mode code points, plus their count (collision belt-and-braces).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    hash: u64,
    count: u32,
}

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Significant = printable Ground content NOT expected to vary between
/// repaints of the same status line. Excluded: whitespace (padding/alignment
/// shifts), ASCII digits (ticking counters, clocks, percentages, token
/// counts), the Braille Patterns block (codex's spinner glyphs), and a small
/// explicit spinner-glyph set (claude's ✻-family, the classic `|/-\` cycle).
/// Stripping affects only the fingerprint — real content always carries
/// letters/punctuation that survive the strip and change the hash.
fn is_significant(ch: char) -> bool {
    if ch.is_whitespace() || ch.is_ascii_digit() {
        return false;
    }
    let cp = ch as u32;
    if (0x2800..=0x28ff).contains(&cp) {
        return false; // Braille Patterns block (braille spinners)
    }
    !matches!(
        ch,
        '✻' | '✽' | '✳' | '✢' | '·' | '∗' | '*' | '|' | '/' | '-' | '\\'
            | '●' | '○' | '◐' | '◓' | '◑' | '◒' | '◴' | '◵' | '◶' | '◷'
    )
}

/// Per-terminal repaint-noise fingerprinter. See module docs.
#[derive(Debug)]
pub(crate) struct NoiseScanner {
    mode: NoiseMode,
    /// Ring of the most recent distinct frame fingerprints (FIFO, cap
    /// [`RECENT_FINGERPRINTS`]).
    recent: std::collections::VecDeque<Fingerprint>,
}

impl NoiseScanner {
    pub(crate) fn new() -> Self {
        Self {
            mode: NoiseMode::Ground,
            recent: std::collections::VecDeque::with_capacity(RECENT_FINGERPRINTS),
        }
    }

    /// Feed one PTY output frame. Returns `true` when the frame carries
    /// meaningful new content (refresh the idle reap clock), `false` when it
    /// is repaint noise.
    pub(crate) fn observe(&mut self, data: &str) -> bool {
        let mut hash: u64 = FNV_OFFSET_BASIS;
        let mut count: u32 = 0;
        for ch in data.chars() {
            let cp = ch as u32;
            match self.mode {
                NoiseMode::Ground => {
                    if cp == 0x1b {
                        self.mode = NoiseMode::Esc;
                    } else if cp < 0x20 || cp == 0x7f || (0x80..=0x9f).contains(&cp) {
                        // C0/C1 control (incl. \r \n \t): never significant.
                    } else if is_significant(ch) {
                        let mut buf = [0u8; 4];
                        for b in ch.encode_utf8(&mut buf).bytes() {
                            hash ^= u64::from(b);
                            hash = hash.wrapping_mul(FNV_PRIME);
                        }
                        count = count.saturating_add(1);
                    }
                }
                NoiseMode::Esc => {
                    self.mode = match cp {
                        0x1b => NoiseMode::Esc,
                        c if c == u32::from(b'[') => NoiseMode::Csi,
                        // OSC ] / DCS P / APC _ / PM ^ / SOS X
                        c if c == u32::from(b']')
                            || c == u32::from(b'P')
                            || c == u32::from(b'_')
                            || c == u32::from(b'^')
                            || c == u32::from(b'X') =>
                        {
                            NoiseMode::StringBody
                        }
                        _ => NoiseMode::Ground, // two-char ESC sequence done
                    };
                }
                NoiseMode::Csi => {
                    if (0x40..=0x7e).contains(&cp) {
                        self.mode = NoiseMode::Ground; // final byte
                    }
                    // else: parameter/intermediate byte — stay in Csi.
                }
                NoiseMode::StringBody => {
                    if cp == 0x07 {
                        self.mode = NoiseMode::Ground; // BEL terminator
                    } else if cp == 0x1b {
                        self.mode = NoiseMode::StringEsc;
                    }
                }
                NoiseMode::StringEsc => {
                    self.mode = match cp {
                        c if c == u32::from(b'\\') => NoiseMode::Ground, // ST
                        0x1b => NoiseMode::StringEsc,
                        _ => NoiseMode::StringBody,
                    };
                }
            }
        }

        if count == 0 {
            return false; // pure control/erase/spinner-glyph repaint
        }
        let fp = Fingerprint { hash, count };
        if self.recent.contains(&fp) {
            return false; // same normalized content as a recent frame
        }
        if self.recent.len() == RECENT_FINGERPRINTS {
            self.recent.pop_front();
        }
        self.recent.push_back(fp);
        true
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p freshell-terminal idle_noise`
Expected: PASS — all 16 tests, 0 failures. (An `unused` warning for `NoiseScanner` outside tests is acceptable at this point; Task 2 wires it in. If the crate denies unused warnings, silence with `#[allow(dead_code)]` on the struct and remove that attribute in Task 2.)

- [ ] **Step 6: Quality gates**

Run: `cargo clippy -p freshell-terminal --all-targets`
Expected: no new warnings from `idle_noise.rs`. If clippy raises `new_without_default`, satisfy it with exactly:

```rust
impl Default for NoiseScanner {
    fn default() -> Self {
        Self::new()
    }
}
```

Run: `cargo fmt --all` then `git diff --stat` — only files you touched should be reformatted (if others change, revert them: `git checkout -- <path>`).

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/idle-repaint-noise
git add crates/freshell-terminal/src/idle_noise.rs crates/freshell-terminal/src/lib.rs
git commit -m "feat(terminal): add NoiseScanner repaint-noise fingerprinter for the idle reap clock

Stateful per-terminal frame classifier: escape-stripped, digit/spinner-
glyph-stripped FNV-1a fingerprints checked against a ring of the 8 most
recent frames. Repaint noise (spinners, ticking counters, status-bar
redraws) classifies false; genuinely new content classifies true.
Groundwork for keying enforce_idle_kills on meaningful activity
(DEV-0009). Fails open: unrecognized content counts as activity.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Key the idle sweep on meaningful activity

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` — `TerminalShared` struct (~line 169), `enforce_idle_kills()` (~line 731), `input()` (~line 1086), `finish_pty_exit()` (~line 1382), `ingest()` (~line 2139), the two `TerminalShared { ... }` literal initializers (in `create()` ~line 821 and `register_headless()` ~line 1581), the test helper `backdate_last_activity` (~line 2599), and new tests in the idle-kill test block (~line 3392).

**Interfaces:**
- Consumes (from Task 1): `crate::idle_noise::NoiseScanner` — `NoiseScanner::new() -> NoiseScanner`, `NoiseScanner::observe(&mut self, data: &str) -> bool` (true = meaningful).
- Produces: private field `TerminalShared::last_meaningful_activity_at: i64` (epoch ms) and field `TerminalShared::noise: NoiseScanner`. `enforce_idle_kills()` reads `last_meaningful_activity_at` instead of `last_activity_at`. NO public/wire API changes; `inventory()` and `DirectoryEntry` keep projecting `last_activity_at` exactly as today.

- [ ] **Step 1: Write the failing tests**

Add to the idle-kill test block in `registry.rs`'s `mod tests` (directly after the existing test `enforce_idle_kills_never_kills_an_attached_terminal`, ~line 3453):

```rust
    #[test]
    fn enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        // Warm-up: the FIRST paint of a status line is genuinely new content
        // and legitimately counts as activity.
        reg.feed("T", frame(1, "\r\x1b[2K⠋ (1s • esc to interrupt)", "S"));
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        // Codex-style repaint noise after the backdate: same status line,
        // only the braille glyph and the digits tick. Each frame still bumps
        // the wire-visible last_activity_at (unchanged legacy semantics) but
        // must NOT refresh the reap clock.
        for (i, paint) in [
            "\r\x1b[2K⠙ (2s • esc to interrupt)",
            "\r\x1b[2K⠹ (3s • esc to interrupt)",
            "\r\x1b[2K⠸ (14s • esc to interrupt)",
            "\r\x1b[2K⠼ (65s • esc to interrupt)",
        ]
        .iter()
        .enumerate()
        {
            reg.feed("T", frame(i as i64 + 2, paint, "S"));
        }

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T".to_string()]);
        assert!(reg.inventory().is_empty());
    }

    #[test]
    fn enforce_idle_kills_spares_detached_terminal_streaming_genuine_output() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        // A long build streaming REAL new log lines: genuine work, must
        // survive the sweep even while detached.
        reg.feed("T", frame(1, "   Compiling freshell-terminal v0.1.0\n", "S"));
        reg.feed("T", frame(2, "warning: unused variable `x` in registry.rs\n", "S"));

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }

    #[test]
    fn input_write_resets_the_idle_reap_clock() {
        // User keystrokes are always activity (headless => the PTY write is
        // skipped but the activity bump still happens, matching input()).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.set_auto_kill_idle_minutes(1);
        reg.backdate_last_activity("T", now_ms() - 10 * 60_000);
        reg.input("T", b"ls\n");

        let killed = reg.enforce_idle_kills();

        assert!(killed.is_empty());
        assert_eq!(reg.inventory().len(), 1);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-terminal enforce_idle_kills -- --nocapture && cargo test -p freshell-terminal input_write_resets`
Expected: `enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise` **FAILS** — `killed` is empty because every `feed()` bumped `last_activity_at` to now (the bug, reproduced). `..._spares_detached_terminal_streaming_genuine_output` and `input_write_resets_the_idle_reap_clock` PASS for the wrong reason today (any frame/input exempts); they become regression guards once the reaper switches clocks. All PRE-EXISTING idle tests must still pass.

- [ ] **Step 3: Implement the wiring**

All edits in `crates/freshell-terminal/src/registry.rs`.

3a. Import the scanner near the other crate-internal imports at the top of the file:

```rust
use crate::idle_noise::NoiseScanner;
```

3b. In `struct TerminalShared`, add two fields — the clock next to `last_activity_at`, the scanner next to `scanner: BarrierScanner`:

```rust
    created_at: i64,
    last_activity_at: i64,
    /// The idle-kill reap clock (DEV-0009): last MEANINGFUL activity — user
    /// input, or PTY output carrying genuinely new content per
    /// [`NoiseScanner`]. Unlike `last_activity_at` (wire-visible via
    /// `inventory()`/`DirectoryEntry` and spec-pinned to bump on EVERY
    /// output frame, terminal-core.md §1.3), repaint noise (spinner frames,
    /// ticking counters, status-bar redraws) does not refresh this.
    /// Read ONLY by `enforce_idle_kills`.
    last_meaningful_activity_at: i64,
```

```rust
    scanner: BarrierScanner,
    /// Per-terminal repaint-noise fingerprinter feeding
    /// `last_meaningful_activity_at` (DEV-0009). Independent of the barrier
    /// scanner: separate state, separate concern (reaping, not batching).
    noise: NoiseScanner,
```

3c. Initializers — the compiler now flags every `TerminalShared { ... }` literal; there are exactly two. In `create()` (~line 821), next to `last_activity_at: now,` add:

```rust
            last_meaningful_activity_at: now,
```

and next to the `scanner:` initializer add:

```rust
            noise: NoiseScanner::new(),
```

In `register_headless()` (~line 1581), next to `last_activity_at: created_at,` add:

```rust
            last_meaningful_activity_at: created_at,
```

and likewise `noise: NoiseScanner::new(),` next to its `scanner:` initializer.

3d. `ingest()` — replace the unconditional bump:

```rust
    let mut s = shared.lock().expect("terminal lock");
    s.head_seq = s.head_seq.max(frame.seq_end);
    s.last_activity_at = now_ms();
```

with:

```rust
    let mut s = shared.lock().expect("terminal lock");
    s.head_seq = s.head_seq.max(frame.seq_end);
    s.last_activity_at = now_ms();
    // DEV-0009: only genuinely-new content refreshes the idle-kill reap
    // clock. Spinner repaints / ticking counters / status-bar redraws still
    // bump the wire-visible last_activity_at above (terminal-core.md §1.3
    // holds for every consumer except the reaper) but must not exempt a
    // detached terminal from enforce_idle_kills forever.
    if s.noise.observe(&frame.data) {
        s.last_meaningful_activity_at = s.last_activity_at;
    }
```

3e. `input()` — replace `s.last_activity_at = now_ms();` with:

```rust
                        let now = now_ms();
                        s.last_activity_at = now;
                        // User keystrokes are always meaningful (DEV-0009).
                        s.last_meaningful_activity_at = now;
```

3f. `finish_pty_exit()` — next to the existing `s.last_activity_at = now;` add (consistency; status is Exited so the reaper ignores it either way):

```rust
        s.last_meaningful_activity_at = now;
```

3g. `enforce_idle_kills()` — swap the clock. Replace:

```rust
                    if now.saturating_sub(s.last_activity_at) < idle_threshold_ms {
                        return None; // not idle long enough yet
                    }
```

with:

```rust
                    // DEV-0009: idleness is measured against the MEANINGFUL
                    // activity clock, not the every-frame last_activity_at —
                    // otherwise a detached animated TUI (spinner / ticking
                    // counter) is exempt from this sweep forever.
                    if now.saturating_sub(s.last_meaningful_activity_at) < idle_threshold_ms {
                        return None; // not idle long enough yet
                    }
```

Also update the function's doc comment: after the sentence about the disabled state, add the line:

```rust
    /// Idleness is measured against `last_meaningful_activity_at` (DEV-0009):
    /// self-generated repaint noise does not keep a detached terminal alive.
```

3h. Test helper `backdate_last_activity` — backdate BOTH clocks so every existing idle test keeps its meaning (they were written when the two clocks were one):

```rust
        /// Test-only: force a terminal's `lastActivityAt` AND its DEV-0009
        /// meaningful-activity reap clock to an arbitrary value so idle-kill
        /// sweep tests don't need to sleep for real minutes.
        fn backdate_last_activity(&self, terminal_id: &str, last_activity_at: i64) {
            let inner = self.inner.lock().unwrap();
            let handle = inner.terminals.get(terminal_id).unwrap();
            let mut s = handle.shared.lock().unwrap();
            s.last_activity_at = last_activity_at;
            s.last_meaningful_activity_at = last_activity_at;
        }
```

- [ ] **Step 4: Run the full crate test suite**

Run: `cargo test -p freshell-terminal`
Expected: PASS — all three new tests green AND every pre-existing test green, in particular the existing idle block (`enforce_idle_kills_kills_detached_terminal_past_threshold`, `..._leaves_terminal_under_threshold_running`, `..._never_kills_an_attached_terminal`, `..._disabled_when_minutes_zero`, `..._disabled_when_minutes_negative`, and the DIAG tracing pair) and the batch/replay golden tests (the barrier scanner is untouched, so any failure there means you modified the wrong thing — stop and revert).

- [ ] **Step 5: Quality gates**

Run: `cargo clippy -p freshell-terminal --all-targets`
Expected: no new warnings.
Run: `cargo test -p freshell-ws -p freshell-server`
Expected: PASS (these crates consume the registry; `spawn_idle_monitor` wiring is untouched but this proves no cross-crate breakage).
Run: `cargo fmt --all` then `git diff --stat` — revert any files you didn't touch.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/idle-repaint-noise
git add crates/freshell-terminal/src/registry.rs
git commit -m "fix(terminal): key idle auto-kill on meaningful activity so repaint noise can't exempt detached terminals

enforce_idle_kills now reads a new private last_meaningful_activity_at
clock, refreshed by input writes and by output frames the NoiseScanner
classifies as genuinely new content. Spinner frames, ticking elapsed
counters, and status-bar redraws no longer reset the reap clock, so an
abandoned detached animated TUI is reaped after autoKillIdleMinutes
(DEV-0009; second server-side hole behind the 2026-07-25 orphaned-
terminal incident — the client-side hole was PR #534).

Wire-visible lastActivityAt semantics are unchanged: still bumped on
every PTY output frame and every input write (terminal-core.md §1.3).
Attached terminals stay exempt; autoKillIdleMinutes <= 0 stays a no-op.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Record deviation DEV-0009 in the oracle ledger

**Files:**
- Modify: `port/oracle/DEVIATIONS.md` — append a new entry after the `### DEV-0008` block, immediately BEFORE the `## E2E-discovered intentional divergences (EDEV-xx)` heading (~line 655 of that file).

**Interfaces:**
- Consumes: the test names from Task 2 and module path from Task 1 (referenced verbatim in the entry's `pinning_test`).
- Produces: ledger entry `DEV-0009`, status `proposed` (the antagonist reviewer, not the implementer, adjudicates acceptance — do not mark it `accepted`).

- [ ] **Step 1: Verify the pinning tests exist and pass (the ledger references them)**

Run: `cargo test -p freshell-terminal enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise enforce_idle_kills_spares_detached_terminal_streaming_genuine_output`
Expected: PASS (2 tests). If either name errs, fix the entry text below to match reality — never reference a test that does not exist.

- [ ] **Step 2: Append the ledger entry**

Insert into `port/oracle/DEVIATIONS.md`, after the end of the DEV-0008 block and before the `## E2E-discovered intentional divergences (EDEV-xx)` heading:

```markdown
### DEV-0009 — idle auto-kill reap clock ignores self-generated repaint noise (original never reaps an animated detached TUI)

- **objective_defect:** *resource leak* — `server/terminal-registry.ts:1684` bumps `lastActivityAt`
  on **every** PTY output frame, and `enforceIdleKills` (`terminal-registry.ts:1406-1425`) keys
  idleness on that stamp. Any detached terminal whose program merely repaints (codex's braille
  spinner + ticking `(Ns • esc to interrupt)` counter, claude's ticking `✻ Crunched for Ns` line,
  any status-bar clock) refreshes the stamp continuously, so `settings.safety.autoKillIdleMinutes`
  can never reap it: the PTY, its child process tree, and its replay buffer are retained
  indefinitely — precisely the leak the setting exists to prevent. Observed in production
  2026-07-25: 10 detached CLIs alive 10-22h against a 3h threshold (the client-side half of that
  incident was PR #534; this entry is the server-side half).
- **original_behavior:** idleness = `now - lastActivityAt`, where `lastActivityAt` is refreshed by
  every PTY output frame regardless of content; a detached animated TUI is exempt from the idle
  sweep forever.
- **port_behavior:** the port keeps `lastActivityAt`'s wire semantics identical (still bumped on
  every output frame and every input write — terminal-core.md §1.3 holds for `inventory`, the
  directory projection, and sorting) but gives `enforce_idle_kills` its own reap clock,
  `last_meaningful_activity_at` (`crates/freshell-terminal/src/registry.rs`), refreshed by input
  writes and by output frames carrying genuinely new content per the stateful per-terminal
  `NoiseScanner` (`crates/freshell-terminal/src/idle_noise.rs`): a frame whose escape-stripped
  text — minus whitespace, ASCII digits, Braille spinner glyphs (U+2800-U+28FF), and a small
  spinner-glyph set — is empty or fingerprint-identical to one of the 8 most recent frames counts
  as repaint noise and does not refresh the reap clock. Detection fails open (anything not
  provably a repeat counts as activity); attached terminals stay exempt and
  `autoKillIdleMinutes <= 0` stays disabled, both unchanged.
- **fingerprint:** behavior/timing-only — no wire message, field, or schema change; the only
  observable divergence is that the port's idle sweep reaps a detached repaint-only terminal after
  the threshold where the original never would (surfaces as a `terminal.killed by=idle` /
  `terminal.exit` for such a terminal, and its absence from subsequent inventories).
- **pinning_test:** `crates/freshell-terminal/src/registry.rs` tests
  `enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise` and
  `enforce_idle_kills_spares_detached_terminal_streaming_genuine_output`, plus the `NoiseScanner`
  unit suite in `crates/freshell-terminal/src/idle_noise.rs` (split-escape statefulness, ring
  membership, digits-only ticks, first-paint-counts semantics).
- **adjudicated_by:** pending antagonist review.
- **status:** proposed.
```

- [ ] **Step 3: Final full verification**

Run: `cargo test -p freshell-terminal -p freshell-ws -p freshell-server`
Expected: PASS, zero failures.
Run: `cargo clippy -p freshell-terminal --all-targets`
Expected: no new warnings.

- [ ] **Step 4: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/idle-repaint-noise
git add port/oracle/DEVIATIONS.md
git commit -m "docs(oracle): record DEV-0009 idle-reap repaint-noise deviation

Ledger entry (status: proposed) for keying enforce_idle_kills on the
meaningful-activity clock instead of the every-frame lastActivityAt.
Objective defect bar: resource leak (detached animated TUIs were never
reapable, 2026-07-25 incident). Pinning tests referenced and passing.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Acceptance-contract traceability

| Spec requirement | Proven by |
|---|---|
| 1. Detached + repaint-noise-only >= threshold → reaped | Task 2 `enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise` (production `ingest()` + production `enforce_idle_kills()`, real frames through `feed`); Task 1 noise classification suite (codex spinner, claude tick line, status-bar clock, alternating split redraw) |
| 2. Detached + genuine work → NOT reaped (build logs, mid-turn streaming) | Task 2 `enforce_idle_kills_spares_detached_terminal_streaming_genuine_output`; Task 1 `distinct_log_lines_are_each_meaningful`, `streamed_response_text_chunks_are_meaningful`, fail-open ring eviction test |
| 3. Input counts as activity; attached terminals stay exempt (unchanged) | Task 2 `input_write_resets_the_idle_reap_clock`; existing `enforce_idle_kills_never_kills_an_attached_terminal` kept green (Task 2 Step 4) |
| 4. `autoKillIdleMinutes <= 0` stays a disabled no-op | Existing `..._disabled_when_minutes_zero` / `..._disabled_when_minutes_negative` kept green (Task 2 Step 4) — the disabled short-circuit is untouched |
| No regression to busy-status classification (TERM-15/16) | The `ActivityEvent::Output` tap and `freshell-ws/src/activity.rs` are not modified anywhere in this plan; `cargo test -p freshell-ws` in Task 2 Step 5 |
| Resilient to frame batching/splitting | `NoiseScanner` state persists across frames (Task 1 cycle-B split-OSC/split-CSI tests) and ring membership handles split-redraw cycles (`alternating_repaint_cycle_is_noise_via_recent_ring`) |
| Legacy `server/` frozen; deviation recorded per oracle conventions | Only `crates/` and `port/oracle/DEVIATIONS.md` are modified; DEV-0009 (Task 3) follows the eight-field DEV schema, next free ID after DEV-0008, status `proposed` |

**Semantics note (intentional, fail-open):** the FIRST paint of any status line counts as meaningful — so the reap clock effectively starts at "last genuinely-new content", and an abandoned animated TUI is reaped ~one threshold after its last real content, exactly the product intent. A TUI that continuously emits *fresh prose* (letters changing, not just digits/spinner glyphs) is treated as genuine work and never reaped — that is requirement 2's side of the contract and the deliberate failure direction.
