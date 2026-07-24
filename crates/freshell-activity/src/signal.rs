//! Port of `shared/turn-complete-signal.ts` (frozen parity reference).
//!
//! The turn-complete signal is a bare BEL (`\x07`) the provider CLIs emit at a
//! positive turn end (claude via the Stop-hook bell `--settings` payload,
//! codex via `tui.notification_method=bel` + `tui.notifications=
//! ['agent-turn-complete']` — both already installed by
//! `freshell-platform::cli_launch`). BELs inside OSC/DCS escape sequences are
//! terminators/payload, not signals; a stray bell sandwiched between visible
//! output (a sub-tool ringing) is not a tracker-eligible signal either.

pub const TURN_COMPLETE_SIGNAL: char = '\u{07}';
const ESC: char = '\u{1b}';
const C1_ST: char = '\u{9c}';
const C1_CSI: char = '\u{9b}';
const C1_DCS: char = '\u{90}';
const C1_OSC: char = '\u{9d}';

/// `TurnCompleteSignalParserState` — carried across output chunks so an escape
/// sequence split over two PTY reads is still recognized.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParserState {
    pub in_osc: bool,
    pub in_csi: bool,
    pub in_dcs: bool,
    pub pending_esc: bool,
}

impl ParserState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `isSubmitInput` (`shared/turn-complete-signal.ts:125-127`): the input is
/// ONLY a run of CR/LF bytes — an Enter keypress, possibly repeated.
pub fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

/// JS `/[\u0000-\u001f\u007f-\u009f]/` — C0 + DEL + C1 controls.
fn is_control(ch: char) -> bool {
    matches!(ch, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}')
}

/// `isIgnorableLeadingTurnCompleteChar`: whitespace or control chars (other
/// than the BEL itself) never count as "visible output" around a signal.
/// JS `/\s/` additionally matches U+FEFF (ZWNBSP), which Rust's
/// `char::is_whitespace` does not — matched explicitly.
fn is_ignorable_leading_char(ch: char) -> bool {
    ch != TURN_COMPLETE_SIGNAL && (ch.is_whitespace() || ch == '\u{feff}' || is_control(ch))
}

/// `countTrackerTurnCompleteSignals`: counts only BELs that are
/// "tracker-eligible" — leading (no visible output before it in the chunk) or
/// with no visible output after it. Reads (copies) the parser state without
/// mutating it, exactly like the reference.
pub fn count_tracker_turn_complete_signals(data: &str, state: &ParserState) -> usize {
    let mut in_osc = state.in_osc;
    let mut pending_esc = state.pending_esc;
    let mut in_csi = state.in_csi;
    let mut in_dcs = state.in_dcs;
    let mut saw_visible_output = false;

    struct Candidate {
        leading_eligible: bool,
        has_visible_after: bool,
    }
    let mut candidates: Vec<Candidate> = Vec::new();

    for ch in data.chars() {
        if pending_esc {
            if in_osc && ch == '\\' {
                in_osc = false;
            } else if in_dcs && ch == '\\' {
                in_dcs = false;
            } else if !in_osc && !in_dcs && ch == ']' {
                in_osc = true;
            } else if !in_osc && !in_dcs && ch == '[' {
                in_csi = true;
            } else if !in_osc && !in_dcs && ch == 'P' {
                in_dcs = true;
            }
            pending_esc = false;
            continue;
        }

        if ch == ESC {
            pending_esc = true;
            continue;
        }

        if in_osc {
            if ch == TURN_COMPLETE_SIGNAL || ch == C1_ST {
                in_osc = false;
            }
            continue;
        }

        if in_dcs {
            if ch == C1_ST {
                in_dcs = false;
            }
            continue;
        }

        if in_csi {
            if ('@'..='~').contains(&ch) {
                in_csi = false;
            }
            continue;
        }

        if ch == C1_CSI {
            in_csi = true;
            continue;
        }
        if ch == C1_DCS {
            in_dcs = true;
            continue;
        }
        if ch == C1_OSC {
            in_osc = true;
            continue;
        }
        if ch == TURN_COMPLETE_SIGNAL {
            candidates.push(Candidate {
                leading_eligible: !saw_visible_output,
                has_visible_after: false,
            });
            continue;
        }
        if is_ignorable_leading_char(ch) {
            continue;
        }
        // Visible output: marks every prior candidate as "has visible after".
        saw_visible_output = true;
        for candidate in &mut candidates {
            candidate.has_visible_after = true;
        }
    }

    candidates
        .iter()
        .filter(|c| c.leading_eligible || !c.has_visible_after)
        .count()
}

/// Does this terminal mode carry the turn-complete BEL contract?
fn supports_turn_signal(mode: &str) -> bool {
    mode == "claude" || mode == "codex"
}

/// `extractTurnCompleteSignals`: strips bare turn-complete BELs from the
/// output (returning the cleaned text) and counts them, updating `state`
/// across chunks. For non-signal modes the data passes through unchanged
/// (with the reference's pending-ESC reset quirk preserved).
pub fn extract_turn_complete_signals(
    data: &str,
    mode: &str,
    state: &mut ParserState,
) -> (String, usize) {
    if !supports_turn_signal(mode) {
        if state.pending_esc {
            state.pending_esc = false;
            state.in_osc = false;
            state.in_csi = false;
            state.in_dcs = false;
            return (format!("{ESC}{data}"), 0);
        }
        return (data.to_string(), 0);
    }

    let mut in_osc = state.in_osc;
    let mut in_csi = state.in_csi;
    let mut in_dcs = state.in_dcs;
    let mut pending_esc = state.pending_esc;
    let mut cleaned = String::with_capacity(data.len());
    let mut count = 0usize;

    for ch in data.chars() {
        if pending_esc {
            if in_osc && ch == '\\' {
                cleaned.push(ESC);
                cleaned.push('\\');
                in_osc = false;
            } else if in_dcs && ch == '\\' {
                cleaned.push(ESC);
                cleaned.push('\\');
                in_dcs = false;
            } else if !in_osc && !in_dcs && ch == ']' {
                cleaned.push(ESC);
                cleaned.push(']');
                in_osc = true;
            } else if !in_osc && !in_dcs && ch == '[' {
                cleaned.push(ESC);
                cleaned.push('[');
                in_csi = true;
            } else if !in_osc && !in_dcs && ch == 'P' {
                cleaned.push(ESC);
                cleaned.push('P');
                in_dcs = true;
            } else {
                cleaned.push(ESC);
                cleaned.push(ch);
            }
            pending_esc = false;
            continue;
        }

        if ch == ESC {
            pending_esc = true;
            continue;
        }

        if ch == C1_CSI {
            cleaned.push(ch);
            in_csi = true;
            continue;
        }
        if ch == C1_DCS {
            cleaned.push(ch);
            in_dcs = true;
            continue;
        }
        if ch == C1_OSC {
            cleaned.push(ch);
            in_osc = true;
            continue;
        }

        if in_csi {
            cleaned.push(ch);
            if ('@'..='~').contains(&ch) {
                in_csi = false;
            }
            continue;
        }

        if ch == TURN_COMPLETE_SIGNAL {
            if in_osc {
                cleaned.push(ch);
                in_osc = false;
            } else if in_dcs {
                cleaned.push(ch);
            } else {
                count += 1;
            }
            continue;
        }

        if ch == C1_ST {
            if in_osc {
                cleaned.push(ch);
                in_osc = false;
            } else if in_dcs {
                cleaned.push(ch);
                in_dcs = false;
            } else {
                cleaned.push(ch);
            }
            continue;
        }

        if in_dcs {
            cleaned.push(ch);
            continue;
        }

        cleaned.push(ch);
    }

    state.in_osc = in_osc;
    state.in_csi = in_csi;
    state.in_dcs = in_dcs;
    state.pending_esc = pending_esc;
    (cleaned, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_submit_input_matches_the_reference_regex() {
        assert!(is_submit_input("\r"));
        assert!(is_submit_input("\n"));
        assert!(is_submit_input("\r\n"));
        assert!(is_submit_input("\r\r\n\n"));
        assert!(!is_submit_input(""));
        assert!(!is_submit_input("a\r"));
        assert!(!is_submit_input("\ra"));
        assert!(!is_submit_input(" \r"));
    }

    #[test]
    fn extract_counts_a_bare_bel_and_strips_it() {
        let mut state = ParserState::new();
        let (cleaned, count) =
            extract_turn_complete_signals("hello\u{07}world", "claude", &mut state);
        assert_eq!(count, 1);
        assert_eq!(cleaned, "helloworld");
    }

    #[test]
    fn extract_ignores_bels_inside_osc_sequences() {
        let mut state = ParserState::new();
        // OSC 0;title BEL — a title-set sequence, its BEL is a terminator.
        let (cleaned, count) =
            extract_turn_complete_signals("\u{1b}]0;title\u{07}after", "claude", &mut state);
        assert_eq!(count, 0);
        assert_eq!(cleaned, "\u{1b}]0;title\u{07}after");
    }

    #[test]
    fn extract_tracks_osc_state_across_chunks() {
        let mut state = ParserState::new();
        let (_, count1) = extract_turn_complete_signals("\u{1b}]0;tit", "codex", &mut state);
        assert_eq!(count1, 0);
        assert!(state.in_osc);
        // The BEL that arrives in the NEXT chunk terminates the OSC — no signal.
        let (_, count2) = extract_turn_complete_signals("le\u{07}", "codex", &mut state);
        assert_eq!(count2, 0);
        assert!(!state.in_osc);
        // A bare BEL after that IS a signal.
        let (_, count3) = extract_turn_complete_signals("\u{07}", "codex", &mut state);
        assert_eq!(count3, 1);
    }

    #[test]
    fn extract_passes_through_for_non_signal_modes() {
        let mut state = ParserState::new();
        let (cleaned, count) = extract_turn_complete_signals("hi\u{07}", "shell", &mut state);
        assert_eq!(count, 0);
        assert_eq!(cleaned, "hi\u{07}");
    }

    #[test]
    fn tracker_count_accepts_leading_and_trailing_bels() {
        let state = ParserState::new();
        // Leading BEL (whitespace/controls before it are ignorable).
        assert_eq!(
            count_tracker_turn_complete_signals("\r\n\u{07}done", &state),
            1
        );
        // Trailing BEL (no visible output after).
        assert_eq!(
            count_tracker_turn_complete_signals("done\u{07} \r\n", &state),
            1
        );
    }

    #[test]
    fn tracker_count_rejects_a_sandwiched_bell() {
        let state = ParserState::new();
        // Visible output on BOTH sides: a stray sub-tool bell, not a signal.
        assert_eq!(
            count_tracker_turn_complete_signals("out\u{07}more-out", &state),
            0
        );
    }

    #[test]
    fn tracker_count_skips_escape_enclosed_bels() {
        let state = ParserState::new();
        assert_eq!(
            count_tracker_turn_complete_signals("\u{1b}]0;t\u{07}", &state),
            0
        );
        // CSI sequences don't eat a following bare BEL.
        assert_eq!(
            count_tracker_turn_complete_signals("\u{1b}[2K\u{07}", &state),
            1
        );
    }

    #[test]
    fn tracker_count_respects_carried_state() {
        let mut state = ParserState::new();
        let _ = extract_turn_complete_signals("\u{1b}]0;tit", "claude", &mut state);
        // Still inside the OSC from the previous chunk: this BEL terminates it.
        assert_eq!(count_tracker_turn_complete_signals("le\u{07}", &state), 0);
    }
}
