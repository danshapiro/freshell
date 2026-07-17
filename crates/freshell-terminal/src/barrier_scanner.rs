//! Stateful VT barrier scanner — an **identical port** of
//! `server/terminal-stream/output-barrier-scanner.ts`.
//!
//! **[PORT RISK — highest]** (`port/machine/specs/terminal-core.md §4.4/§9.3`): this
//! scanner is byte-exact and **stateful across frames** (`scannerStateBefore/After`
//! persist in the ring, `replay-ring.ts:62-78`). It decides `terminal.output.batch`
//! merge boundaries, so `segments[]`, `endOffset`, and `rawFrameCount` all depend on
//! it. A faithful port must reproduce this state machine exactly or batch framing
//! diverges. Plain `terminal.output` (batchV1 off) is immune — one frame per message.
//!
//! The scanner walks **code points** (Unicode scalar values). A Rust `&str` is always
//! valid UTF-8, and `str::chars()` yields scalar values, so iteration matches the
//! reference's `codePointAt`/`fromCodePoint` walk. The one UTF-16-flavoured detail —
//! the CSI payload-suffix cap — is faithfully bounded below (§ `append_csi_payload`).

/// Barrier reasons, highest-priority-wins (`output-barrier-scanner.ts:1-6`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarrierReason {
    Control,
    Osc52,
    RequestMode,
    TurnComplete,
    StartupProbe,
}

impl BarrierReason {
    /// The exact wire string (`terminal.output.batch` segment `barrier` value —
    /// `broker.ts:1517` emits the reason STRING, not a boolean).
    pub fn as_str(self) -> &'static str {
        match self {
            BarrierReason::Control => "control",
            BarrierReason::Osc52 => "osc52",
            BarrierReason::RequestMode => "request_mode",
            BarrierReason::TurnComplete => "turn_complete",
            BarrierReason::StartupProbe => "startup_probe",
        }
    }

    /// `REASON_PRIORITY` (`output-barrier-scanner.ts:46-52`).
    fn priority(self) -> u8 {
        match self {
            BarrierReason::Control => 1,
            BarrierReason::TurnComplete => 2,
            BarrierReason::StartupProbe => 3,
            BarrierReason::RequestMode => 4,
            BarrierReason::Osc52 => 5,
        }
    }
}

/// Scanner mode (`TerminalOutputScannerMode`, `output-barrier-scanner.ts:8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScannerMode {
    Ground,
    Esc,
    Csi,
    Osc,
    Dcs,
    Apc,
}

impl ScannerMode {
    /// The wire string used in `scannerStateBefore/After.mode` (kept for parity with
    /// the reference's `{ mode }` snapshot object).
    pub fn as_str(self) -> &'static str {
        match self {
            ScannerMode::Ground => "ground",
            ScannerMode::Esc => "esc",
            ScannerMode::Csi => "csi",
            ScannerMode::Osc => "osc",
            ScannerMode::Dcs => "dcs",
            ScannerMode::Apc => "apc",
        }
    }
}

/// `TerminalOutputScannerState` (`output-barrier-scanner.ts:10-12`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScannerState {
    pub mode: ScannerMode,
}

/// `TerminalOutputBarrierClassification` (`output-barrier-scanner.ts:14-27`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BarrierClassification {
    pub barrier: bool,
    /// Present iff `barrier` (highest-priority reason seen in the frame).
    pub reason: Option<BarrierReason>,
    pub ground: bool,
    pub state_before: ScannerState,
    pub state_after: ScannerState,
}

// Control-code constants (`output-barrier-scanner.ts:34-44`).
const ESC: u32 = 0x1b;
const BEL: u32 = 0x07;
const CSI: u32 = 0x9b;
const OSC: u32 = 0x9d;
const DCS: u32 = 0x90;
const SOS: u32 = 0x98;
const ST: u32 = 0x9c;
const PM: u32 = 0x9e;
const APC: u32 = 0x9f;
const REPLACEMENT_CHARACTER: u32 = 0xfffd;
const CSI_PAYLOAD_SUFFIX_LIMIT: usize = 64;

fn is_csi_final_byte(cp: u32) -> bool {
    (0x40..=0x7e).contains(&cp)
}
fn is_esc_intermediate_byte(cp: u32) -> bool {
    (0x20..=0x2f).contains(&cp)
}
fn is_esc_final_byte(cp: u32) -> bool {
    (0x30..=0x7e).contains(&cp)
}
fn is_transparent_ground_control(cp: u32) -> bool {
    cp == 0x09 || cp == 0x0a || cp == 0x0d
}
fn is_ground_control_barrier(cp: u32) -> bool {
    if is_transparent_ground_control(cp) {
        return false;
    }
    cp < 0x20 || cp == 0x7f || (0x80..=0x9f).contains(&cp)
}
fn default_reason_for_mode(mode: ScannerMode) -> BarrierReason {
    if mode == ScannerMode::Osc {
        BarrierReason::Osc52
    } else {
        BarrierReason::Control
    }
}

/// `classifyCsiFinal` (`output-barrier-scanner.ts:83-92`).
fn classify_csi_final(payload: &str, final_char: char) -> BarrierReason {
    // payload.replace(/[ -/]/gu, '') — strip 0x20..=0x2f.
    let normalized: String = payload
        .chars()
        .filter(|c| !(' '..='/').contains(c))
        .collect();
    if final_char == 'n' && normalized.ends_with('6') {
        return BarrierReason::RequestMode;
    }
    if final_char == 'c' {
        return BarrierReason::StartupProbe;
    }
    BarrierReason::Control
}

/// `createTerminalOutputBarrierScanner` (`output-barrier-scanner.ts:94-353`).
///
/// Instantiate ONE per terminal stream and call [`scan`](Self::scan) per produced
/// frame; the mode/CSI/string-terminator state persists across calls.
#[derive(Debug, Clone)]
pub struct BarrierScanner {
    mode: ScannerMode,
    csi_payload_suffix: String,
    string_esc_pending: bool,
}

impl Default for BarrierScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl BarrierScanner {
    pub fn new() -> Self {
        Self {
            mode: ScannerMode::Ground,
            csi_payload_suffix: String::new(),
            string_esc_pending: false,
        }
    }

    pub fn is_ground(&self) -> bool {
        self.mode == ScannerMode::Ground
    }

    fn enter_csi(&mut self) {
        self.mode = ScannerMode::Csi;
        self.csi_payload_suffix.clear();
        self.string_esc_pending = false;
    }
    fn enter_string_mode(&mut self, next: ScannerMode) {
        self.mode = next;
        self.csi_payload_suffix.clear();
        self.string_esc_pending = false;
    }
    fn enter_esc(&mut self) {
        self.mode = ScannerMode::Esc;
        self.csi_payload_suffix.clear();
        self.string_esc_pending = false;
    }
    fn enter_ground(&mut self) {
        self.mode = ScannerMode::Ground;
        self.csi_payload_suffix.clear();
        self.string_esc_pending = false;
    }

    /// `appendCsiPayload` (`output-barrier-scanner.ts:146-151`): append then keep the
    /// last `CSI_PAYLOAD_SUFFIX_LIMIT` code units. CSI params/intermediates are ASCII
    /// (1 code unit each) in practice, so the char-count cap matches the reference's
    /// UTF-16 `.slice(-64)` for every real payload.
    fn append_csi_payload(&mut self, ch: char) {
        self.csi_payload_suffix.push(ch);
        let len = self.csi_payload_suffix.chars().count();
        if len > CSI_PAYLOAD_SUFFIX_LIMIT {
            let start = len - CSI_PAYLOAD_SUFFIX_LIMIT;
            self.csi_payload_suffix = self.csi_payload_suffix.chars().skip(start).collect();
        }
    }

    /// `scan(data)` (`output-barrier-scanner.ts:134-345`): classify one produced frame
    /// and advance the persistent parser state.
    pub fn scan(&mut self, data: &str) -> BarrierClassification {
        let state_before = ScannerState { mode: self.mode };
        let mut barrier_reason: Option<BarrierReason> = if self.mode != ScannerMode::Ground {
            Some(default_reason_for_mode(self.mode))
        } else {
            None
        };

        let mark = |current: &mut Option<BarrierReason>, reason: BarrierReason| match *current {
            Some(cur) if reason.priority() <= cur.priority() => {}
            _ => *current = Some(reason),
        };

        for ch in data.chars() {
            let cp = ch as u32;
            match self.mode {
                ScannerMode::Ground => {
                    if cp == REPLACEMENT_CHARACTER {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        continue;
                    }
                    if cp == BEL {
                        mark(&mut barrier_reason, BarrierReason::TurnComplete);
                        continue;
                    }
                    if cp == ESC {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        self.enter_esc();
                        continue;
                    }
                    if cp == CSI {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        self.enter_csi();
                        continue;
                    }
                    if cp == OSC {
                        mark(&mut barrier_reason, BarrierReason::Osc52);
                        self.enter_string_mode(ScannerMode::Osc);
                        continue;
                    }
                    if cp == DCS {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        self.enter_string_mode(ScannerMode::Dcs);
                        continue;
                    }
                    if cp == SOS || cp == PM {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        self.enter_string_mode(ScannerMode::Apc);
                        continue;
                    }
                    if cp == APC {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        self.enter_string_mode(ScannerMode::Apc);
                        continue;
                    }
                    if is_ground_control_barrier(cp) {
                        mark(&mut barrier_reason, BarrierReason::Control);
                    }
                    continue;
                }
                ScannerMode::Esc => {
                    mark(&mut barrier_reason, BarrierReason::Control);
                    if cp == 0x5b {
                        self.enter_csi();
                        continue;
                    }
                    if cp == 0x58 || cp == 0x5e {
                        self.enter_string_mode(ScannerMode::Apc);
                        continue;
                    }
                    if cp == 0x5d {
                        mark(&mut barrier_reason, BarrierReason::Osc52);
                        self.enter_string_mode(ScannerMode::Osc);
                        continue;
                    }
                    if cp == 0x50 {
                        self.enter_string_mode(ScannerMode::Dcs);
                        continue;
                    }
                    if cp == 0x5f {
                        self.enter_string_mode(ScannerMode::Apc);
                        continue;
                    }
                    if cp == ESC {
                        self.enter_esc();
                        continue;
                    }
                    if cp == CSI {
                        self.enter_csi();
                        continue;
                    }
                    if cp == OSC {
                        mark(&mut barrier_reason, BarrierReason::Osc52);
                        self.enter_string_mode(ScannerMode::Osc);
                        continue;
                    }
                    if cp == DCS {
                        self.enter_string_mode(ScannerMode::Dcs);
                        continue;
                    }
                    if cp == SOS || cp == PM {
                        self.enter_string_mode(ScannerMode::Apc);
                        continue;
                    }
                    if cp == APC {
                        self.enter_string_mode(ScannerMode::Apc);
                        continue;
                    }
                    if is_esc_intermediate_byte(cp) {
                        continue;
                    }
                    if is_esc_final_byte(cp) {
                        self.enter_ground();
                    }
                    continue;
                }
                ScannerMode::Csi => {
                    mark(&mut barrier_reason, BarrierReason::Control);
                    if cp == REPLACEMENT_CHARACTER {
                        mark(&mut barrier_reason, BarrierReason::Control);
                        continue;
                    }
                    if cp == ESC {
                        self.enter_esc();
                        continue;
                    }
                    if cp == BEL {
                        mark(&mut barrier_reason, BarrierReason::TurnComplete);
                        continue;
                    }
                    if cp == ST {
                        self.enter_ground();
                        continue;
                    }
                    if is_csi_final_byte(cp) {
                        let reason = classify_csi_final(&self.csi_payload_suffix, ch);
                        mark(&mut barrier_reason, reason);
                        self.enter_ground();
                        continue;
                    }
                    self.append_csi_payload(ch);
                    continue;
                }
                ScannerMode::Osc | ScannerMode::Dcs | ScannerMode::Apc => {
                    self.process_string_mode(cp, self.mode, &mut barrier_reason, &mark);
                }
            }
        }

        let state_after = ScannerState { mode: self.mode };
        let ground = self.mode == ScannerMode::Ground;
        BarrierClassification {
            barrier: barrier_reason.is_some(),
            reason: barrier_reason,
            ground,
            state_before,
            state_after,
        }
    }

    /// `processStringMode` (`output-barrier-scanner.ts:153-187`) — OSC/DCS/APC bodies,
    /// with the two-char `ESC \` (ST) terminator and OSC's `BEL` terminator.
    fn process_string_mode(
        &mut self,
        cp: u32,
        string_mode: ScannerMode,
        barrier_reason: &mut Option<BarrierReason>,
        mark: &impl Fn(&mut Option<BarrierReason>, BarrierReason),
    ) {
        mark(barrier_reason, default_reason_for_mode(string_mode));

        if cp == REPLACEMENT_CHARACTER {
            mark(barrier_reason, BarrierReason::Control);
        }

        if self.string_esc_pending {
            if cp == 0x5c {
                self.enter_ground();
                return;
            }
            if cp == ESC {
                self.string_esc_pending = true;
                return;
            }
            self.string_esc_pending = false;
            return;
        }

        if cp == ESC {
            self.string_esc_pending = true;
            return;
        }
        if cp == ST {
            self.enter_ground();
            return;
        }
        if string_mode == ScannerMode::Osc && cp == BEL {
            self.enter_ground();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan1(data: &str) -> BarrierClassification {
        BarrierScanner::new().scan(data)
    }

    #[test]
    fn plain_text_and_ground_whitespace_is_transparent() {
        let c = scan1("hello\r\n\tworld");
        assert!(!c.barrier);
        assert_eq!(c.reason, None);
        assert!(c.ground);
        assert_eq!(c.state_after.mode, ScannerMode::Ground);
    }

    #[test]
    fn bel_is_turn_complete() {
        let c = scan1("done\u{0007}");
        assert!(c.barrier);
        assert_eq!(c.reason, Some(BarrierReason::TurnComplete));
        assert!(c.ground, "BEL returns to ground");
    }

    #[test]
    fn c0_control_is_control_barrier() {
        // 0x01 (SOH) is a ground control barrier.
        let c = scan1("a\u{0001}b");
        assert!(c.barrier);
        assert_eq!(c.reason, Some(BarrierReason::Control));
    }

    #[test]
    fn csi_dsr_6n_is_request_mode() {
        // ESC [ 6 n — device status report (cursor position request).
        let c = scan1("\u{001b}[6n");
        assert!(c.barrier);
        assert_eq!(c.reason, Some(BarrierReason::RequestMode));
        assert!(c.ground, "CSI final returns to ground");
    }

    #[test]
    fn csi_da_c_is_startup_probe() {
        // ESC [ c — primary device attributes.
        let c = scan1("\u{001b}[c");
        assert!(c.barrier);
        assert_eq!(c.reason, Some(BarrierReason::StartupProbe));
    }

    #[test]
    fn csi_sgr_is_plain_control() {
        // ESC [ 3 1 m — SGR red. A barrier, reason 'control' (not a probe/request).
        let c = scan1("\u{001b}[31m");
        assert!(c.barrier);
        assert_eq!(c.reason, Some(BarrierReason::Control));
        assert!(c.ground);
    }

    #[test]
    fn osc_is_osc52_and_priority_wins() {
        // ESC ] 52 ; ... BEL — an OSC sequence. Reason osc52 (priority 5) beats the
        // control seen entering esc mode.
        let c = scan1("\u{001b}]52;c;AAA\u{0007}");
        assert!(c.barrier);
        assert_eq!(c.reason, Some(BarrierReason::Osc52));
        assert!(c.ground, "BEL terminates the OSC string");
    }

    #[test]
    fn stateful_across_frames_csi_split() {
        // A CSI sequence split across two frames: state must persist.
        let mut s = BarrierScanner::new();
        let a = s.scan("\u{001b}[6"); // enters csi, still open
        assert!(a.barrier);
        assert_eq!(a.state_after.mode, ScannerMode::Csi);
        assert!(!a.ground);
        let b = s.scan("n"); // completes DSR 6n across the frame boundary
        assert!(b.barrier);
        assert_eq!(b.reason, Some(BarrierReason::RequestMode));
        assert_eq!(b.state_before.mode, ScannerMode::Csi);
        assert!(b.ground);
    }

    #[test]
    fn osc_terminated_by_st_esc_backslash_across_frames() {
        let mut s = BarrierScanner::new();
        let a = s.scan("\u{001b}]0;title"); // open OSC
        assert_eq!(a.state_after.mode, ScannerMode::Osc);
        let b = s.scan("\u{001b}\\rest"); // ESC \ = ST, back to ground, then "rest"
        assert!(b.barrier, "still carries the osc52 barrier for the frame");
        assert_eq!(b.state_after.mode, ScannerMode::Ground);
    }
}
