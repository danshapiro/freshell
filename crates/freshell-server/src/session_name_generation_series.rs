//! Name-reliability Task 6: the generation series' attempt accounting.
//!
//! A claim charges one of the bounded starts and marks the series in flight;
//! it never exhausts and never drops the naming input, because only the
//! fold knows whether the attempt really counted. The fold either refunds
//! the start (a capability or quota failure: the request never had a fair
//! chance) or settles it as consumed (an empty, invalid or failed answer):
//! at the cap that exhausts the series and drops its input, below the cap it
//! schedules the bounded retry. An interrupted start (a crash between claim
//! and fold) is still settled as consumed by boot recovery.
//!
//! A newer first message can re-arm the series while its request is in
//! flight: the series takes the new input but stays in flight, and the fold
//! of the old request ([`settle_superseded_start`]) still settles the
//! charged start — refunded, or counted (exhausting at the cap) — before the
//! newer input is tried.
//!
//! A child module of the store so it reads the series internals without
//! widening their visibility.

use super::{generation_retry_delay_ms, GenerationState, GenerationStatus, MAX_GENERATION_STARTS};
use crate::session_name_generation::GenerationOutcome;

/// Charge one start for `attempt_id` at `now`: consumed +1, the attempt
/// recorded, the series in flight. Returns the consumed count.
pub(super) fn charge_start(series: &mut GenerationState, attempt_id: &str, now: i64) -> u32 {
    series.consumed += 1;
    series.attempt_ids.push(attempt_id.to_string());
    series.attempt_starts.push(now);
    series.status = GenerationStatus::InFlight;
    series.consumed
}

/// Give back the in-flight start of `attempt_id`: consumed −1, its attempt
/// id and start time removed, the series Eligible again with its input and
/// its due time unchanged (the naming pause, not the series, decides when
/// it is tried again). `false` (nothing changed) when the series is not in
/// flight or never recorded that attempt.
pub(super) fn refund_start(series: &mut GenerationState, attempt_id: &str) -> bool {
    if series.status != GenerationStatus::InFlight {
        return false;
    }
    let Some(position) = series.attempt_ids.iter().rposition(|id| id == attempt_id) else {
        return false;
    };
    series.attempt_ids.remove(position);
    // Only the guard-holding worker claims, one attempt at a time, so the
    // refunded claim's start is the latest one recorded.
    if let Some(latest) = series
        .attempt_starts
        .iter()
        .enumerate()
        .max_by_key(|(_, start)| **start)
        .map(|(index, _)| index)
    {
        series.attempt_starts.remove(latest);
    }
    series.consumed = series.consumed.saturating_sub(1);
    series.status = GenerationStatus::Eligible;
    true
}

/// Settle a start that counted: at the cap the series is exhausted (the
/// exhaustion time recorded once) and its input dropped; below it the retry
/// is scheduled from `now`.
pub(super) fn settle_consumed_start(series: &mut GenerationState, now: i64) {
    if series.status == GenerationStatus::Exhausted || series.consumed >= MAX_GENERATION_STARTS {
        exhaust(series, now);
    } else {
        series.status = GenerationStatus::Eligible;
        series.next_due = Some(now + generation_retry_delay_ms(series.consumed).unwrap_or(0));
    }
}

/// Settle the in-flight start of a request built from input that a newer
/// first message has since replaced. The old answer is never accepted, but
/// the start it was charged still resolves: a refusal (`CapabilityUnavailable`
/// / `Throttled`) gives it back by its attempt id; any other outcome counted
/// it, which exhausts the series at the cap (dropping the newer input too)
/// and otherwise leaves the series Eligible with the newer input due at
/// once (it has never been tried). `false` (nothing changed) when the series
/// has no start in flight.
pub(super) fn settle_superseded_start(
    series: &mut GenerationState,
    outcome: &GenerationOutcome,
    now: i64,
) -> bool {
    match outcome {
        GenerationOutcome::CapabilityUnavailable { attempt_id }
        | GenerationOutcome::Throttled { attempt_id } => refund_start(series, attempt_id),
        GenerationOutcome::Answer(_) | GenerationOutcome::Empty | GenerationOutcome::Failed(_) => {
            if series.status != GenerationStatus::InFlight {
                return false;
            }
            if series.consumed >= MAX_GENERATION_STARTS {
                exhaust(series, now);
            } else {
                series.status = GenerationStatus::Eligible;
            }
            true
        }
    }
}

fn exhaust(series: &mut GenerationState, now: i64) {
    series.status = GenerationStatus::Exhausted;
    series.exhausted_at.get_or_insert(now);
    series.next_due = None;
    series.excerpt = None;
}
