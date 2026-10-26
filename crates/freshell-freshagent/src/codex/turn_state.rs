//! Session-local dispatch ownership. RPC replies describe delivery; only native
//! terminal evidence (or confirmed owned exit) describes the end of work.

use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DispatchToken(u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StopDisposition {
    None,
    Latched,
    Interrupt {
        dispatch: DispatchToken,
        turn_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeSettlement {
    Completed,
    Interrupted,
    Failed,
    OwnedExit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    Pending,
    Accepted,
    Ambiguous,
    Refused,
}

#[derive(Clone, Debug)]
pub(crate) struct DispatchFact {
    pub token: DispatchToken,
    pub request_id: String,
    pub turn_id: Option<String>,
    pub delivery: Delivery,
    pub settlement: Option<NativeSettlement>,
}

#[derive(Debug)]
struct StopOperation {
    dispatch: DispatchToken,
    turn_id: Option<String>,
    issued: bool,
}

#[derive(Debug, Default)]
pub(crate) struct CodexTurnState {
    next_dispatch: u64,
    facts: VecDeque<DispatchFact>,
    active: Option<String>,
    stop: Option<StopOperation>,
    user_stop: Option<String>,
    owned_exit: bool,
    pub changed: Arc<Notify>,
    #[cfg(test)]
    pub waiting_for_stop: Arc<Notify>,
}

impl CodexTurnState {
    pub fn begin_dispatch(&mut self, request_id: &str) -> DispatchToken {
        self.next_dispatch = self
            .next_dispatch
            .checked_add(1)
            .expect("dispatch counter exhausted");
        let token = DispatchToken(self.next_dispatch);
        // Keep all unsettled receipts; bound completed history without throwing
        // away the current turn's individual same-ID steer deliveries.
        while self.facts.len() >= 64
            && self
                .facts
                .front()
                .is_some_and(|f| f.settlement.is_some() || f.delivery == Delivery::Refused)
        {
            self.facts.pop_front();
        }
        self.facts.push_back(DispatchFact {
            token,
            request_id: request_id.into(),
            turn_id: self.active.clone(),
            delivery: Delivery::Pending,
            settlement: None,
        });
        token
    }

    pub fn accept(&mut self, token: DispatchToken, turn_id: &str) -> StopDisposition {
        let Some(fact) = self.facts.iter_mut().find(|f| f.token == token) else {
            return StopDisposition::None;
        };
        if fact.delivery == Delivery::Refused {
            return StopDisposition::None;
        }
        fact.delivery = Delivery::Accepted;
        fact.turn_id = Some(turn_id.into());
        if fact.settlement.is_none() {
            self.active = Some(turn_id.into());
        }
        self.issue_latched_stop(token, turn_id)
    }

    pub fn reject(&mut self, token: DispatchToken) -> bool {
        let Some(fact) = self.facts.iter_mut().find(|f| f.token == token) else {
            return false;
        };
        // An observed native start is admission evidence even if a contrary
        // controller response follows it.
        if fact.delivery == Delivery::Accepted {
            return false;
        }
        fact.delivery = Delivery::Refused;
        fact.settlement = None;
        if self
            .stop
            .as_ref()
            .is_some_and(|s| s.dispatch == token && !s.issued)
        {
            self.stop = None;
            self.changed.notify_waiters();
        }
        true
    }

    pub fn mark_ambiguous(&mut self, token: DispatchToken) {
        if let Some(fact) = self.facts.iter_mut().find(|f| f.token == token) {
            if fact.delivery == Delivery::Pending {
                fact.delivery = Delivery::Ambiguous;
            }
        }
    }

    pub fn request_stop(&mut self) -> StopDisposition {
        if self.stop.is_some() {
            return StopDisposition::Latched;
        }
        let Some(fact) = self
            .facts
            .iter()
            .rev()
            .find(|f| f.settlement.is_none() && f.delivery != Delivery::Refused)
        else {
            return StopDisposition::None;
        };
        let dispatch = fact.token;
        let target = self.active.clone().or_else(|| fact.turn_id.clone());
        if target
            .as_ref()
            .is_some_and(|id| self.user_stop.as_ref() == Some(id))
        {
            return StopDisposition::None;
        }
        self.stop = Some(StopOperation {
            dispatch,
            turn_id: target.clone(),
            issued: false,
        });
        match target {
            Some(id) => self.issue_latched_stop(dispatch, &id),
            None => StopDisposition::Latched,
        }
    }

    fn issue_latched_stop(&mut self, token: DispatchToken, turn_id: &str) -> StopDisposition {
        let Some(stop) = self
            .stop
            .as_mut()
            .filter(|s| s.dispatch == token && !s.issued)
        else {
            return StopDisposition::None;
        };
        if !self
            .facts
            .iter()
            .any(|f| f.token == token && f.settlement.is_none() && f.delivery != Delivery::Refused)
        {
            self.stop = None;
            self.changed.notify_waiters();
            return StopDisposition::None;
        }
        stop.issued = true;
        stop.turn_id = Some(turn_id.into());
        self.user_stop = Some(turn_id.into());
        StopDisposition::Interrupt {
            dispatch: token,
            turn_id: turn_id.into(),
        }
    }

    pub fn interrupt_ack(&mut self, token: DispatchToken, turn_id: &str) {
        if self
            .stop
            .as_ref()
            .is_some_and(|s| s.dispatch == token && s.turn_id.as_deref() == Some(turn_id))
        {
            self.stop = None;
            self.changed.notify_waiters();
        }
    }

    /// Only a proven pre-submission refusal retracts a user's Stop intent.
    pub fn interrupt_refused(&mut self, token: DispatchToken, turn_id: &str) -> bool {
        if !self
            .stop
            .as_ref()
            .is_some_and(|s| s.dispatch == token && s.turn_id.as_deref() == Some(turn_id))
        {
            return false;
        }
        self.interrupt_ack(token, turn_id);
        if self.user_stop.as_deref() == Some(turn_id) {
            self.user_stop = None;
        }
        true
    }

    pub fn settle_native(&mut self, turn_id: &str, evidence: NativeSettlement) -> bool {
        let mut settled = false;
        for fact in &mut self.facts {
            if fact.settlement.is_none()
                && fact.delivery != Delivery::Refused
                && (evidence == NativeSettlement::OwnedExit
                    || fact.turn_id.as_deref() == Some(turn_id))
            {
                fact.settlement = Some(evidence);
                settled = true;
            }
        }
        if evidence == NativeSettlement::OwnedExit || self.active.as_deref() == Some(turn_id) {
            self.active = None;
        }
        // A completion does not prove that an outstanding native interrupt has
        // finished its unqualified core submission. Owned exit does.
        if evidence == NativeSettlement::OwnedExit {
            self.owned_exit = true;
            self.stop = None;
            self.user_stop = None;
            self.changed.notify_waiters();
        }
        settled
    }

    pub fn observe_started(&mut self, turn_id: &str) -> StopDisposition {
        if self
            .facts
            .iter()
            .any(|f| f.turn_id.as_deref() == Some(turn_id) && f.settlement.is_some())
        {
            return StopDisposition::None;
        }
        if self.active.as_deref().is_some_and(|id| id != turn_id) {
            return StopDisposition::None;
        }
        let token = self
            .facts
            .iter()
            .rev()
            .find(|f| {
                f.turn_id.is_none() && f.settlement.is_none() && f.delivery != Delivery::Refused
            })
            .map(|f| f.token)
            .or_else(|| {
                self.facts
                    .iter()
                    .find(|f| {
                        f.turn_id.as_deref() == Some(turn_id)
                            && f.settlement.is_none()
                            && f.delivery == Delivery::Accepted
                    })
                    .map(|f| f.token)
            })
            .unwrap_or_else(|| self.begin_dispatch(""));
        self.accept(token, turn_id)
    }

    pub fn has_owed_work(&self) -> bool {
        self.facts
            .iter()
            .any(|f| f.settlement.is_none() && f.delivery != Delivery::Refused)
    }
    pub fn has_unknown_delivery(&self) -> bool {
        self.facts.iter().any(|f| {
            f.settlement.is_none()
                && f.turn_id.is_none()
                && matches!(f.delivery, Delivery::Pending | Delivery::Ambiguous)
        })
    }
    pub fn has_stopping_work(&self) -> bool {
        self.user_stop.as_deref().is_some_and(|id| {
            self.facts.iter().any(|f| {
                f.turn_id.as_deref() == Some(id)
                    && f.settlement.is_none()
                    && f.delivery != Delivery::Refused
            })
        })
    }
    pub fn observe_idle(&mut self) {
        self.active = None;
    }
    pub fn active_turn_id(&self) -> Option<&str> {
        self.active.as_deref()
    }
    pub fn has_unresolved_stop(&self) -> bool {
        self.stop.is_some()
    }
    pub fn has_owned_exit(&self) -> bool {
        self.owned_exit
    }
    pub fn user_stop_turn_id(&self) -> Option<&str> {
        self.user_stop.as_deref()
    }
    pub fn facts(&self) -> &VecDeque<DispatchFact> {
        &self.facts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_acknowledged_stop_stays_deduplicated_through_the_native_idle_gap() {
        let mut s = CodexTurnState::default();
        let old = s.begin_dispatch("old");
        s.accept(old, "old");
        assert_eq!(
            s.request_stop(),
            StopDisposition::Interrupt {
                dispatch: old,
                turn_id: "old".into()
            }
        );
        s.interrupt_ack(old, "old");
        s.observe_idle();
        assert_eq!(
            s.request_stop(),
            StopDisposition::None,
            "thread idle must not re-arm the same acknowledged Stop"
        );
        let new = s.begin_dispatch("new");
        s.accept(new, "new");
        assert_eq!(
            s.request_stop(),
            StopDisposition::Interrupt {
                dispatch: new,
                turn_id: "new".into()
            }
        );
    }

    #[test]
    fn native_completion_during_a_pending_steer_cannot_assign_an_outcome_to_a_later_refusal() {
        let mut s = CodexTurnState::default();
        let old = s.begin_dispatch("old");
        s.accept(old, "old");
        let steer = s.begin_dispatch("steer");
        s.settle_native("old", NativeSettlement::Completed);
        assert!(s.reject(steer));
        assert_eq!(s.facts().back().unwrap().delivery, Delivery::Refused);
        assert_eq!(s.facts().back().unwrap().settlement, None);
        assert!(!s.has_owed_work());
    }

    #[test]
    fn rejected_initial_dispatch_releases_its_latched_stop_without_owing_work() {
        let mut s = CodexTurnState::default();
        let token = s.begin_dispatch("refused");
        assert_eq!(s.request_stop(), StopDisposition::Latched);
        assert!(s.reject(token));
        assert!(!s.has_owed_work());
        assert!(!s.has_unresolved_stop());
        assert_eq!(s.accept(token, "never-admitted"), StopDisposition::None);
        assert_eq!(s.active_turn_id(), None);
    }

    #[test]
    fn a_duplicate_start_cannot_accept_a_rejected_or_ambiguous_same_turn_steer() {
        let mut s = CodexTurnState::default();
        let first = s.begin_dispatch("start");
        s.accept(first, "old");
        let steer = s.begin_dispatch("steer");
        s.observe_started("old");
        assert!(s.reject(steer));
        let ambiguous = s.begin_dispatch("unknown-steer");
        s.mark_ambiguous(ambiguous);
        s.observe_started("old");
        assert_eq!(s.facts().back().unwrap().delivery, Delivery::Ambiguous);
        assert!(s.has_owed_work());
        s.settle_native("old", NativeSettlement::Completed);
        assert!(!s.has_owed_work());
        assert_eq!(
            s.facts()[1].settlement,
            None,
            "a refusal never acquires a native outcome"
        );
    }

    #[test]
    fn same_id_steer_receipts_have_one_terminal_settlement_and_refusal_keeps_the_turn() {
        let mut s = CodexTurnState::default();
        let first = s.begin_dispatch("first");
        s.accept(first, "old");
        let refused = s.begin_dispatch("refused");
        assert!(s.reject(refused));
        assert!(s.has_owed_work());
        assert_eq!(s.active_turn_id(), Some("old"));
        let steer = s.begin_dispatch("steer");
        s.accept(steer, "old");
        assert_eq!(
            s.facts()
                .iter()
                .filter(|f| f.delivery == Delivery::Accepted)
                .count(),
            2
        );
        assert!(s.settle_native("old", NativeSettlement::Completed));
        assert!(!s.has_owed_work());
        assert!(!s.settle_native("old", NativeSettlement::Completed));
    }

    #[test]
    fn stop_latches_before_acceptance_and_ack_does_not_settle() {
        let mut s = CodexTurnState::default();
        let dispatch = s.begin_dispatch("pending");
        assert_eq!(s.request_stop(), StopDisposition::Latched);
        assert_eq!(
            s.accept(dispatch, "old"),
            StopDisposition::Interrupt {
                dispatch,
                turn_id: "old".into()
            }
        );
        assert_eq!(s.accept(dispatch, "old"), StopDisposition::None);
        s.interrupt_ack(dispatch, "old");
        assert!(s.has_owed_work());
        assert!(!s.has_unresolved_stop());
        assert!(s.settle_native("old", NativeSettlement::Interrupted));
        assert!(!s.has_owed_work());
    }

    #[test]
    fn natural_completion_and_ambiguous_stop_do_not_open_the_issuance_gate() {
        let mut s = CodexTurnState::default();
        let old = s.begin_dispatch("old");
        s.accept(old, "old");
        s.request_stop();
        s.settle_native("old", NativeSettlement::Completed);
        assert!(!s.has_owed_work());
        assert!(s.has_unresolved_stop());
        s.mark_ambiguous(old);
        assert!(s.has_unresolved_stop());
        s.interrupt_ack(old, "old");
        let new = s.begin_dispatch("new");
        s.accept(new, "new");
        s.interrupt_ack(old, "old");
        s.settle_native("old", NativeSettlement::Interrupted);
        assert!(s.has_owed_work());
        assert_eq!(s.active_turn_id(), Some("new"));
    }

    #[test]
    fn ambiguous_dispatch_is_not_replayed_or_settled_by_an_empty_startup_ack() {
        let mut s = CodexTurnState::default();
        let dispatch = s.begin_dispatch("receipt");
        s.mark_ambiguous(dispatch);
        assert_eq!(s.request_stop(), StopDisposition::Latched);
        s.interrupt_ack(dispatch, "");
        assert!(s.has_owed_work());
        assert!(s.has_unresolved_stop());
        s.observe_started("native");
        s.settle_native("native", NativeSettlement::Failed);
        assert!(!s.has_owed_work());
        assert!(s.has_unresolved_stop());
        s.settle_native("", NativeSettlement::OwnedExit);
        assert!(!s.has_unresolved_stop());
        assert_eq!(s.facts()[0].request_id, "receipt");
    }

    #[test]
    fn pre_acceptance_events_do_not_resurrect_settled_work() {
        let mut s = CodexTurnState::default();
        let token = s.begin_dispatch("fast");
        s.observe_started("fast");
        s.settle_native("fast", NativeSettlement::Completed);
        s.accept(token, "fast");
        s.observe_started("fast");
        assert!(!s.has_owed_work());
        assert_eq!(s.active_turn_id(), None);
    }
}
