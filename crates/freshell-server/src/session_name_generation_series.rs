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
//! A child module of the store so it reads the series internals without
//! widening their visibility.

use super::{generation_retry_delay_ms, GenerationState, GenerationStatus, MAX_GENERATION_STARTS};

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
        series.status = GenerationStatus::Exhausted;
        series.exhausted_at.get_or_insert(now);
        series.next_due = None;
        series.excerpt = None;
    } else {
        series.status = GenerationStatus::Eligible;
        series.next_due = Some(now + generation_retry_delay_ms(series.consumed).unwrap_or(0));
    }
}
