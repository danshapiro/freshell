//! The first-message rules of the name store (name-reliability plan,
//! Task 5; decision D4, root cause RC12, validation V2).
//!
//! - **The fallback.** A session's first user message is its free
//!   first-message name, offered for EVERY activity that carries one — a
//!   newly accepted or indexed message, and an open or resumed session (the
//!   sweep reports a session open in a live terminal as `Opened`, so before
//!   this an open terminal pane kept its folder name whenever AI naming
//!   failed). Text the shared classifier recognizes as a default or derived
//!   label — tool wrapper text above all, "171 saved names are
//!   `<recommended_plugins>`" — is never a fallback. An accepted send
//!   carries the message just sent, so its fallback heals a junk name only
//!   while the store has no input for the session
//!   ([`fallback_may_self_heal`]); later sends only raise the rank.
//! - **Re-absorb at rest.** A real first message never changes; an indexed
//!   one changes only when the extraction rules change (Task 5 re-derives
//!   the cached rows whose message was wrapper text). So a changed message
//!   fed by the index to an Idle, never-attempted series refreshes the
//!   series' input and leaves it Idle: it arms on an explicit open, exactly
//!   like the boot snapshot, and re-deriving history never starts background
//!   AI naming.
//! - **The prompt-input guard.** Wrapper or derived text is never AI-naming
//!   input: an activity without a real first message drops a stored one
//!   (the series rests Idle with no input), the explicit-open hook of a bind
//!   leaves such a series Idle and drops its input instead of arming it, and
//!   the claim refuses one without consuming a start. (Otherwise Gemini
//!   would name a session from wrapper text, and the answer would be a
//!   protected `freshell_ai` name the self-heal rule can never replace.)
//! - **Who still needs a first message.** The sweep's targeted OpenCode
//!   lookup also serves a record that is below `first_message` or is junk
//!   under the row's folder (C5), not only generation input.
//!
//! Pure functions over the document; the store's decisions and the sweep's
//! pre-checks call the same ones, so the pre-check and the apply never
//! drift.

use std::cell::RefCell;

use freshell_freshagent::naming::NameActivityReason;
use freshell_protocol::session_names::{NameSource, SessionNameRecord};
use freshell_sessions::{is_default_or_derived_name, NameEvidenceContext};

use super::session_name_policy::is_self_heal_record;
use super::{
    excerpt_of, fingerprint_message, source_is_protected, source_rank, GenerationState,
    GenerationStatus, StoredDocument,
};

/// Whether an activity's first-message fallback may heal a junk name —
/// replace a self-heal record at equal or lower rank — or may only raise
/// the rank. The sweep's activities (indexed, opened) carry the session
/// index's first user message. An accepted send carries the message the
/// user just sent, which is the session's first only while the store holds
/// no AI-naming input for the session (no series, or one without input):
/// every real user message the store learns for an unprotected record is
/// stored as that input. So a later send only raises a name below
/// `first_message`, and the index heals a junk name with the true first
/// message. Otherwise "continue", sent to a resumed session the sweep had
/// not reached yet, would replace its junk name for good: the true first
/// message no longer outranks it, and it is no longer junk.
pub(super) fn fallback_may_self_heal(
    document: &StoredDocument,
    key: &str,
    reason: NameActivityReason,
) -> bool {
    reason != NameActivityReason::AcceptedUserMessage
        || document
            .generation
            .get(key)
            .is_none_or(|series| series.input_fingerprint.is_none())
}

/// The first-message fallback title (the existing 50-character extraction
/// of the message's first line), or `None` when it is empty or a default or
/// derived label — wrapper text, a provider label, "Tab 3" (folder-free:
/// the folder rule needs the offer's own folder, which the rank rule in
/// `session_name_policy` applies).
pub(super) fn first_message_fallback(message: &str) -> Option<String> {
    let title = freshell_sessions::text::extract_title_from_message(message, 50);
    if title.is_empty() || is_default_or_derived_name(&title, &NameEvidenceContext::default()) {
        None
    } else {
        Some(title)
    }
}

/// Whether `text` is usable AI-naming input: neither empty nor a default or
/// derived label (wrapper text above all). Folder-free.
pub(super) fn is_generation_input(text: &str) -> bool {
    !is_default_or_derived_name(text, &NameEvidenceContext::default())
}

/// The activity's first user message, trimmed, when it is usable AI-naming
/// input.
fn real_first_message(message: Option<&str>) -> Option<&str> {
    message
        .map(str::trim)
        .filter(|message| is_generation_input(message))
}

/// Whether the series stores input the guard refuses (wrapper or derived
/// text).
pub(super) fn holds_refused_input(series: &GenerationState) -> bool {
    series
        .excerpt
        .as_deref()
        .is_some_and(|excerpt| !is_generation_input(excerpt))
}

/// What one activity does to the session's generation series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SeriesPlan {
    /// (Re)arm with this input: the series becomes Eligible (one with a
    /// start in flight takes the input and stays in flight).
    Arm {
        fingerprint: String,
        excerpt: String,
    },
    /// Re-absorb at rest: take this input and stay Idle.
    Rest {
        fingerprint: String,
        excerpt: String,
    },
    /// The prompt-input guard: drop the refused stored input; stay Idle.
    DropInput,
}

impl SeriesPlan {
    pub(super) fn arms(&self) -> bool {
        matches!(self, Self::Arm { .. })
    }
}

/// Plan the series side of one activity on an UNPROTECTED record (the
/// caller skips protected ones: a protected winner keeps generation
/// stopped). The arming rules are the existing ones — an accepted or
/// indexed message (re)arms when its fingerprint differs; accepted sends
/// keep an already captured real first message; an open or
/// resume arms only an unattempted series, including the boot-absorbed Idle
/// series an explicit open may arm with the same message; an exhausted
/// series never re-arms — plus re-absorb at rest and the prompt-input guard
/// above.
pub(super) fn plan_series(
    document: &StoredDocument,
    key: &str,
    reason: NameActivityReason,
    first_user_message: Option<&str>,
) -> Option<SeriesPlan> {
    let series = document.generation.get(key);
    let Some(message) = real_first_message(first_user_message) else {
        return series
            .filter(|series| droppable(series) && holds_refused_input(series))
            .map(|_| SeriesPlan::DropInput);
    };
    let attempt_allowed = match reason {
        NameActivityReason::AcceptedUserMessage | NameActivityReason::IndexUserMessage => true,
        NameActivityReason::Opened | NameActivityReason::Resumed => {
            series.is_none_or(|series| series.consumed == 0)
        }
    };
    if !attempt_allowed {
        return None;
    }
    let fingerprint = fingerprint_message(message);
    let excerpt = || excerpt_of(message);
    let Some(series) = series else {
        return Some(SeriesPlan::Arm {
            fingerprint,
            excerpt: excerpt(),
        });
    };
    // AcceptedUserMessage carries the current send, not a corrected first
    // message from the index. Preserve the original input across later
    // turns, pauses and in-flight requests: otherwise "continue" becomes
    // the input for a protected AI name. Refused old wrapper input may
    // still be replaced by the first real message.
    if reason == NameActivityReason::AcceptedUserMessage
        && series.excerpt.as_deref().is_some_and(is_generation_input)
    {
        return None;
    }
    if series.status == GenerationStatus::Exhausted {
        return None;
    }
    let resting = series.status == GenerationStatus::Idle && series.consumed == 0;
    if series.input_fingerprint.as_deref() != Some(fingerprint.as_str()) {
        return Some(
            if reason == NameActivityReason::IndexUserMessage && resting {
                SeriesPlan::Rest {
                    fingerprint,
                    excerpt: excerpt(),
                }
            } else {
                SeriesPlan::Arm {
                    fingerprint,
                    excerpt: excerpt(),
                }
            },
        );
    }
    // The same message ("explicit open/resume may arm an unattempted
    // series"): the boot snapshot's absorbed series (Idle, never attempted)
    // rests until the user actually opens the session, and the same message
    // then arms it. An attempted series (Eligible retry, InFlight) never
    // resets.
    (reason == NameActivityReason::Opened && resting).then(|| SeriesPlan::Arm {
        fingerprint,
        excerpt: excerpt(),
    })
}

/// A series whose input may be dropped: not mid-attempt and not exhausted.
fn droppable(series: &GenerationState) -> bool {
    matches!(
        series.status,
        GenerationStatus::Idle | GenerationStatus::Eligible
    )
}

/// Apply a planned series change; `true` when the document changed. A
/// guard drop is recorded in `refusals`.
pub(super) fn apply_series_plan(
    document: &mut StoredDocument,
    key: &str,
    plan: SeriesPlan,
    refusals: &InputRefusals,
) -> bool {
    match plan {
        SeriesPlan::Arm {
            fingerprint,
            excerpt,
        } => {
            let series = document
                .generation
                .entry(key.to_string())
                .or_insert_with(new_series);
            if series.status == GenerationStatus::Exhausted {
                return false;
            }
            // A claimed start stays in flight until its fold settles it
            // (refund, retry, or exhaustion at the cap) and boot recovery
            // can still find it; the newer input waits for that settle.
            if series.status != GenerationStatus::InFlight {
                series.status = GenerationStatus::Eligible;
            }
            series.input_fingerprint = Some(fingerprint);
            series.excerpt = Some(excerpt);
            series.next_due = None;
            true
        }
        SeriesPlan::Rest {
            fingerprint,
            excerpt,
        } => {
            let Some(series) = document.generation.get_mut(key) else {
                return false;
            };
            series.input_fingerprint = Some(fingerprint);
            series.excerpt = Some(excerpt);
            series.next_due = None;
            true
        }
        SeriesPlan::DropInput => document
            .generation
            .get_mut(key)
            .is_some_and(|series| drop_refused_input(series, RefusalSite::Activity, refusals)),
    }
}

fn new_series() -> GenerationState {
    GenerationState {
        status: GenerationStatus::Eligible,
        series_id: uuid::Uuid::new_v4().to_string(),
        input_fingerprint: None,
        excerpt: None,
        attempt_ids: Vec::new(),
        attempt_starts: Vec::new(),
        consumed: 0,
        next_due: None,
        exhausted_at: None,
    }
}

/// Which guard refused stored input (the `site` of the
/// `session_names.generation_input_refused` event).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RefusalSite {
    /// An activity (sweep pass or live edge) without a real first message.
    Activity,
    /// A bind's explicit-open hook.
    Bind,
    /// The generation claim, the last line before the model.
    Claim,
}

impl RefusalSite {
    fn as_str(self) -> &'static str {
        match self {
            Self::Activity => "activity",
            Self::Bind => "bind",
            Self::Claim => "claim",
        }
    }
}

/// The prompt-input guard's drop: no input, resting Idle, nothing consumed
/// or refunded. `true` when the series changed; the drop and the guard
/// that fired are recorded in `refusals`, which the transaction logs once
/// it commits.
pub(super) fn drop_refused_input(
    series: &mut GenerationState,
    site: RefusalSite,
    refusals: &InputRefusals,
) -> bool {
    if !droppable(series) || !holds_refused_input(series) {
        return false;
    }
    series.input_fingerprint = None;
    series.excerpt = None;
    series.status = GenerationStatus::Idle;
    series.next_due = None;
    refusals.record(site, series);
    true
}

/// One transaction's prompt-input guard drops. The
/// `session_names.generation_input_refused` line says the input "was
/// dropped", so it is written only after the drop committed
/// ([`InputRefusals::log_committed`]); a transaction whose commit fails
/// writes none (the input is still stored, and a later transaction drops
/// it again).
#[derive(Debug, Default)]
pub(super) struct InputRefusals(RefCell<Vec<InputRefusal>>);

#[derive(Debug)]
struct InputRefusal {
    site: RefusalSite,
    series: String,
    consumed: u32,
}

impl InputRefusals {
    fn record(&self, site: RefusalSite, series: &GenerationState) {
        self.0.borrow_mut().push(InputRefusal {
            site,
            series: series.series_id.clone(),
            consumed: series.consumed,
        });
    }

    /// The transaction committed: log each drop once.
    pub(super) fn log_committed(&self) {
        for refusal in self.0.take() {
            tracing::info!(
                target: "freshell_server::session_names",
                op = "generation_input_refused",
                site = refusal.site.as_str(),
                series = %refusal.series,
                consumed = refusal.consumed,
                "session_names.generation_input_refused: stored AI-naming input is wrapper or derived text; it was dropped and the series rests"
            );
        }
    }
}

/// The bind's explicit-open hook for one series: an Idle, never-attempted
/// series with usable input becomes Eligible (the user opened the session);
/// one holding refused input stays Idle and drops it. `true` when changed.
pub(super) fn explicit_open(series: &mut GenerationState, refusals: &InputRefusals) -> bool {
    if series.status != GenerationStatus::Idle || series.consumed != 0 {
        return false;
    }
    if holds_refused_input(series) {
        return drop_refused_input(series, RefusalSite::Bind, refusals);
    }
    if series.input_fingerprint.is_none() {
        return false;
    }
    series.status = GenerationStatus::Eligible;
    series.next_due = None;
    true
}

/// Whether a record still needs the session's first user message (the
/// sweep's targeted lookup serves it): below `first_message`, or a self-heal
/// record under the row's folder (C5). Protected names never do.
pub(super) fn record_needs_first_message(record: &SessionNameRecord, cwd: Option<&str>) -> bool {
    !source_is_protected(record.source)
        && (source_rank(record.source) < source_rank(NameSource::FirstMessage)
            || is_self_heal_record(record, cwd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_is_never_a_default_label() {
        assert_eq!(
            first_message_fallback("Fix the sardine importer").as_deref(),
            Some("Fix the sardine importer")
        );
        assert_eq!(
            first_message_fallback("<recommended_plugins>\n- github: review pull requests"),
            None
        );
        assert_eq!(
            first_message_fallback(
                "<local-command-caveat>Caveat: The messages below were generated"
            ),
            None
        );
        assert_eq!(first_message_fallback("Claude CLI"), None);
        assert_eq!(first_message_fallback("   "), None);
        // A real sentence that merely mentions a tag stays a name.
        assert_eq!(
            first_message_fallback("Fix <b>bold</b> rendering").as_deref(),
            Some("Fix <b>bold</b> rendering")
        );
    }
}
