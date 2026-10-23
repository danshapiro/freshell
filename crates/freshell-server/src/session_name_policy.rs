//! The automatic-naming rules of the name store (name-reliability plan,
//! Task 4; decision D3): which automatic offer may replace which saved name.
//! Pure functions over records and the document — the store's decisions
//! call them, and the sweep pre-checks call the SAME functions, so the
//! pre-check and the apply can never drift.
//!
//! Three rules live here.
//!
//! 1. **The self-heal rule.** A *self-heal record* is an unprotected record
//!    (`directory`, `first_message`, `provider_ai`) whose current name the
//!    shared classifier recognizes as a default or derived label ("Tab 23",
//!    "OpenCode agent", tool wrapper text, the session's own folder name
//!    when the folder is known). It ranks below `directory` for every
//!    automatic offer: an offer whose own text is a real name replaces it
//!    whatever the offer's rank; a default or derived offer never replaces a
//!    name, except hydration's last rung (the folder name, else the provider
//!    label) stepping a junk record above `directory` down to `directory`
//!    once — after which it is an ordinary `directory` record, so two default
//!    labels can never alternate; the same text is always a no-op. Names a
//!    person chose (`manual`), migration-protected labels and accepted
//!    Freshell AI names are never self-heal records. The folder comes from
//!    the offer's own input (the activity's or the index row's cwd); offers
//!    that carry no folder (native observations, binds) recognize only
//!    folder-free labels.
//!
//! 2. **Native observations.** A provider-native title that is a placeholder
//!    or another default label is provenance only. Each record keeps the
//!    last valid native title it saw (`last_native_title`, the baseline): an
//!    observation equal to it is an echo and never changes the name, even
//!    when it would raise rank. A title that differs from the baseline
//!    replaces an unprotected name below `provider_ai`, a self-heal record,
//!    or an older `provider_ai` name once a baseline exists. The first
//!    observation of a record (no baseline yet) only records the baseline:
//!    pre-deploy automation renames were never written back to the provider,
//!    which still reports its older title.
//!
//! 3. **Automation renames.** An automatic rename (omitted or `automatic`
//!    intent) is recorded at `provider_ai` and may replace any unprotected
//!    name, equal rank included, unless its text is a default or derived
//!    label for the target — classified with the best-known folder of the
//!    target, so a rename to the session's own folder name is refused rather
//!    than applied and then healed away. The caller learns which happened.

use freshell_protocol::session_names::{
    NameSource, RenameOutcome, RenameOutcomeReason, SessionNameRecord, SessionNameRef,
};
use freshell_sessions::{is_default_or_derived_name, NameEvidenceContext};

use super::{
    directory_fallback_name, first_message_fallback, name_ref_key, source_is_protected,
    source_rank, validate_name, StoredDocument,
};
use crate::session_name_generation::IndexedNameInput;

/// The classifier context for a record: its provider (a provider placeholder
/// counts only for its own provider) and the folder the caller knows.
fn evidence_context<'a>(
    record: &'a SessionNameRecord,
    cwd: Option<&'a str>,
) -> NameEvidenceContext<'a> {
    let provider = match &record.name_ref {
        SessionNameRef::Session { provider, .. } => Some(provider.as_str()),
        SessionNameRef::Pending { .. } => None,
    };
    NameEvidenceContext {
        cwd,
        provider,
        mode: None,
    }
}

/// Whether `name` is a default or derived label for `record`'s target —
/// the ONE server-side meaning of "default label" (the import bind rule,
/// native observations, automation renames and the self-heal rule all ask
/// this).
pub(super) fn is_default_label_for(
    record: &SessionNameRecord,
    name: &str,
    cwd: Option<&str>,
) -> bool {
    is_default_or_derived_name(name, &evidence_context(record, cwd))
}

/// Rule 1: an unprotected record whose current name is a default or
/// derived label under the known folder.
pub(super) fn is_self_heal_record(record: &SessionNameRecord, cwd: Option<&str>) -> bool {
    !source_is_protected(record.source) && is_default_label_for(record, &record.name, cwd)
}

/// Rule 1 as one predicate: whether an automatic offer replaces a self-heal
/// record. False for every record that is not a self-heal record (the rank
/// rules decide those) and for the same text.
pub(super) fn self_heal_offer_applies(
    record: &SessionNameRecord,
    offer_name: &str,
    offer_source: NameSource,
    cwd: Option<&str>,
) -> bool {
    if offer_name == record.name || !is_self_heal_record(record, cwd) {
        return false;
    }
    if !is_default_label_for(record, offer_name, cwd) {
        return true;
    }
    // Only hydration's last rung offers at `directory`: it may step a junk
    // record that sits above `directory` down to `directory`, once.
    offer_source == NameSource::Directory
        && source_rank(record.source) > source_rank(NameSource::Directory)
}

/// The acceptance rule for the automatic offers that carry their own
/// evidence (the first-message fallback, hydration): a self-heal
/// replacement, else a strict rank raise whose text is a real name. A
/// default or derived offer never replaces a name outside the self-heal
/// exception, and nothing automatic replaces a protected name.
pub(super) fn automatic_offer_applies(
    record: &SessionNameRecord,
    offer_name: &str,
    offer_source: NameSource,
    cwd: Option<&str>,
) -> bool {
    self_heal_offer_applies(record, offer_name, offer_source, cwd)
        || rank_raise_applies(record, offer_name, offer_source, cwd)
}

/// The strict half of [`automatic_offer_applies`]: a real name (not a
/// default or derived label under the known folder) that outranks the saved
/// one. Never the same text, never over a protected name. The fallback of
/// an accepted send that is not the session's first message gets only this
/// half (`session_name_first_message::fallback_may_self_heal`).
pub(super) fn rank_raise_applies(
    record: &SessionNameRecord,
    offer_name: &str,
    offer_source: NameSource,
    cwd: Option<&str>,
) -> bool {
    offer_name != record.name
        && !source_is_protected(record.source)
        && !is_default_label_for(record, offer_name, cwd)
        && source_rank(offer_source) > source_rank(record.source)
}

/// Rule 2's verdict for one valid, current-location, non-own-write native
/// title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NativeOfferPlan {
    /// The title replaces the saved name (at `provider_ai`).
    pub replace: bool,
    /// The baseline to record (`None` = it stays as it is).
    pub new_baseline: Option<String>,
}

/// Rule 2. `baseline` is the record's current baseline (staged or
/// persisted). Native observations carry no folder.
pub(super) fn native_offer_decision(
    record: &SessionNameRecord,
    baseline: Option<&str>,
    title: &str,
) -> NativeOfferPlan {
    let nothing = NativeOfferPlan {
        replace: false,
        new_baseline: None,
    };
    // A placeholder or another default label is never a name and never a
    // baseline (a baseline of "Tab 3" would let the provider's real title,
    // re-reported afterwards, look new and undo a rename).
    if is_default_label_for(record, title, None) {
        return nothing;
    }
    // An echo: provenance only, even when it would raise rank.
    if baseline == Some(title) {
        return nothing;
    }
    let new_baseline = Some(title.to_string());
    if title == record.name || source_is_protected(record.source) {
        return NativeOfferPlan {
            replace: false,
            new_baseline,
        };
    }
    let replace = source_rank(NameSource::ProviderAi) > source_rank(record.source)
        || is_self_heal_record(record, None)
        || (record.source == NameSource::ProviderAi && baseline.is_some());
    NativeOfferPlan {
        replace,
        new_baseline,
    }
}

/// Rule 3's verdict for one automatic rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AutomationRenameVerdict {
    Apply,
    Unchanged,
    Refused(RenameOutcomeReason),
}

impl AutomationRenameVerdict {
    pub(super) fn outcome(self) -> RenameOutcome {
        match self {
            Self::Apply => RenameOutcome {
                applied: true,
                reason: None,
            },
            Self::Unchanged => RenameOutcome {
                applied: true,
                reason: Some(RenameOutcomeReason::Unchanged),
            },
            Self::Refused(reason) => RenameOutcome {
                applied: false,
                reason: Some(reason),
            },
        }
    }
}

/// Rule 3. `name` is already validated; `cwd` is the target's best-known
/// folder.
pub(super) fn automation_rename_decision(
    record: &SessionNameRecord,
    name: &str,
    cwd: Option<&str>,
) -> AutomationRenameVerdict {
    if name == record.name {
        AutomationRenameVerdict::Unchanged
    } else if source_is_protected(record.source) {
        AutomationRenameVerdict::Refused(RenameOutcomeReason::ProtectedName)
    } else if is_default_label_for(record, name, cwd) {
        AutomationRenameVerdict::Refused(RenameOutcomeReason::DefaultLabel)
    } else {
        AutomationRenameVerdict::Apply
    }
}

/// What hydrating one index row would do to the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum HydratePlan {
    /// No record yet: install the ladder's first rung (today's insert).
    Insert { name: String, source: NameSource },
    /// A self-heal record: replace it with the first rung rule 1 allows. No
    /// generation series is created or absorbed on this path.
    Heal { name: String, source: NameSource },
}

/// The ONE hydration plan, shared by the transaction and the sweep's
/// pre-check: no record → the free-fallback ladder (provider title, then the
/// first-message extraction, then the folder name or provider label); a
/// self-heal record → the first ladder rung rule 1 allows; anything else
/// (an established real name, the same text) → `None`, a Read.
pub(super) fn plan_hydrate(
    document: &StoredDocument,
    input: &IndexedNameInput,
) -> Option<HydratePlan> {
    let key = name_ref_key(&SessionNameRef::Session {
        provider: input.provider,
        session_id: input.session_id.clone(),
    });
    let cwd = input.cwd.as_deref();
    match document.record_at(&key) {
        None => hydrate_rungs(input)
            .into_iter()
            .next()
            .map(|(name, source)| HydratePlan::Insert { name, source }),
        // The common case — an established real name — answers before the
        // ladder is computed: the sweep asks this for every indexed session
        // on every pass.
        Some(record) if !is_self_heal_record(record, cwd) => None,
        Some(record) => hydrate_rungs(input)
            .into_iter()
            .find(|(name, source)| self_heal_offer_applies(record, name, *source, cwd))
            .map(|(name, source)| HydratePlan::Heal { name, source }),
    }
}

/// The free-fallback ladder in order. A provider title or first-message
/// extraction that fails accepted-name validation is an unusable rung (the
/// ladder falls through exactly like an absent one); the last rung — the
/// folder name, else the provider label — is always valid.
fn hydrate_rungs(input: &IndexedNameInput) -> Vec<(String, NameSource)> {
    let mut rungs = Vec::with_capacity(3);
    if let Some(title) = input
        .provider_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .filter(|title| validate_name(title).is_ok())
    {
        rungs.push((title.to_string(), NameSource::ProviderAi));
    }
    if let Some(message) = input
        .first_user_message
        .as_deref()
        .and_then(first_message_fallback)
        .filter(|fallback| validate_name(fallback).is_ok())
    {
        rungs.push((message, NameSource::FirstMessage));
    }
    rungs.push((
        directory_fallback_name(input.cwd.as_deref(), &input.provider),
        NameSource::Directory,
    ));
    rungs
}

#[cfg(test)]
#[path = "session_name_policy_tests.rs"]
mod tests;
