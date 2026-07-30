use crate::activation::{
    require_matching_receipt, require_prior_ordinary, require_target, validate_port_state,
    ActivationDriver, ActivationReceiptObservation, PortState, ServiceState,
};
use crate::error::{DeployError, Result};
use crate::journal::{TransactionJournal, TransactionPhase, TransactionRecord, UpdateMode};
use crate::receipts::LiveReceipt;
use crate::rollback::{rollback, validate_relaunched_process};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOutcome {
    RolledBack,
    Activated,
    ClientSelected,
}

pub(crate) fn recover_transaction<J, D>(journal: &mut J, driver: &mut D) -> Result<RecoveryOutcome>
where
    J: TransactionJournal,
    D: ActivationDriver,
{
    let mut record = journal
        .load()?
        .ok_or_else(|| DeployError::Recovery("no durable transaction to recover".to_string()))?;
    record.validate()?;
    if record.mode.changes_server()
        && record.launch_protocol_version.is_none()
        && record.phase >= TransactionPhase::StartTargetIntent
        && record.phase != TransactionPhase::RollbackComplete
    {
        return Err(DeployError::Recovery(
            "legacy transaction lacks durable pre-spawn launch evidence".to_string(),
        ));
    }
    record = reconcile_pending_launch(journal, driver, &record)?;
    if record.mode == UpdateMode::ClientOnly {
        return recover_client(journal, driver, &record);
    }
    if record.phase == TransactionPhase::RollbackComplete {
        return Ok(RecoveryOutcome::RolledBack);
    }
    if record.phase == TransactionPhase::ActivationConfirmed {
        roll_forward_confirmed(journal, driver, &record)?;
        return Ok(RecoveryOutcome::Activated);
    }
    if record.phase == TransactionPhase::Activated {
        require_selected(driver, &record.target_generation_id)?;
        let state = driver.observe_port(&record)?;
        validate_port_state(&record, &state)?;
        match state {
            PortState::Target {
                candidate,
                service: ServiceState::Ordinary,
            } => {
                driver.verify_running(&candidate.process)?;
                driver.verify_ordinary(&candidate.process)?;
            }
            PortState::Free => verify_owned_predecessors_exited(driver, &record)?,
            _ => {
                return Err(DeployError::Recovery(
                    "durably activated target has unsafe pointer or process drift".to_string(),
                ))
            }
        }
        require_selected(driver, &record.target_generation_id)?;
        let confirmed = record.advanced(TransactionPhase::ActivationConfirmed)?;
        journal.save(&confirmed)?;
        roll_forward_confirmed(journal, driver, &confirmed)?;
        return Ok(RecoveryOutcome::Activated);
    }

    let receipt = driver.activation_receipt(&record)?;
    if record.phase >= TransactionPhase::ActivationAuthorized {
        match receipt {
            ActivationReceiptObservation::Present(receipt) => {
                require_selected(driver, &record.target_generation_id)?;
                let candidate = record.candidate.as_ref().ok_or_else(|| {
                    DeployError::Recovery(
                        "activation receipt exists without durable candidate evidence".to_string(),
                    )
                })?;
                require_matching_receipt(&record, candidate, &receipt)?;
                let state = driver.observe_port(&record)?;
                validate_port_state(&record, &state)?;
                let process = require_target(&state, &record, ServiceState::Ordinary)?;
                driver.verify_running(process)?;
                driver.verify_ordinary(process)?;
                let activated = record.advanced(TransactionPhase::Activated)?;
                require_selected(driver, &record.target_generation_id)?;
                journal.save(&activated)?;
                let confirmed = activated.advanced(TransactionPhase::ActivationConfirmed)?;
                require_selected(driver, &record.target_generation_id)?;
                journal.save(&confirmed)?;
                roll_forward_confirmed(journal, driver, &confirmed)?;
                return Ok(RecoveryOutcome::Activated);
            }
            ActivationReceiptObservation::Absent => {
                let candidate = record.candidate.as_ref().ok_or_else(|| {
                    DeployError::Recovery(
                        "authorization intent exists without durable candidate evidence"
                            .to_string(),
                    )
                })?;
                let selected = driver.selected_generation()?;
                if selected == record.prior_generation_id {
                    let cancelled = driver.cancellation_receipt(&record)?;
                    let activated = driver.activation_receipt(&record)?;
                    match (activated, cancelled) {
                        (
                            ActivationReceiptObservation::Absent,
                            ActivationReceiptObservation::Present(receipt),
                        ) => {
                            require_matching_receipt(&record, candidate, &receipt)?;
                            driver.verify_exited(&candidate.process)?;
                            require_selected(driver, &record.prior_generation_id)?;
                        }
                        (
                            ActivationReceiptObservation::Absent,
                            ActivationReceiptObservation::Absent,
                        ) => {
                            driver.verify_exited(&candidate.process)?;
                            require_selected(driver, &record.prior_generation_id)?;
                        }
                        _ => return Err(DeployError::Recovery(
                            "prior pointer is accepted only for a durably cancelled, exited target"
                                .to_string(),
                        )),
                    }
                } else {
                    require_selected(driver, &record.target_generation_id)?;
                    driver.request_activation_cancellation(candidate, &record.controls)?;
                    let deadline = Instant::now() + Duration::from_secs(5);
                    loop {
                        let activated = driver.activation_receipt(&record)?;
                        let cancelled = driver.cancellation_receipt(&record)?;
                        match (activated, cancelled) {
                            (
                                ActivationReceiptObservation::Present(receipt),
                                ActivationReceiptObservation::Absent,
                            ) => {
                                require_matching_receipt(&record, candidate, &receipt)?;
                                require_selected(driver, &record.target_generation_id)?;
                                let state = driver.observe_port(&record)?;
                                let process =
                                    match require_target(&state, &record, ServiceState::Ordinary) {
                                        Ok(process) => process,
                                        Err(_)
                                            if matches!(
                                                state,
                                                PortState::Target {
                                                    service: ServiceState::Gated,
                                                    ..
                                                }
                                            ) && Instant::now() < deadline =>
                                        {
                                            std::thread::sleep(Duration::from_millis(25));
                                            continue;
                                        }
                                        Err(error) => return Err(error),
                                    };
                                driver.verify_running(process)?;
                                driver.verify_ordinary(process)?;
                                let activated = record.advanced(TransactionPhase::Activated)?;
                                require_selected(driver, &record.target_generation_id)?;
                                journal.save(&activated)?;
                                let confirmed =
                                    activated.advanced(TransactionPhase::ActivationConfirmed)?;
                                require_selected(driver, &record.target_generation_id)?;
                                journal.save(&confirmed)?;
                                roll_forward_confirmed(journal, driver, &confirmed)?;
                                return Ok(RecoveryOutcome::Activated);
                            }
                            (
                                ActivationReceiptObservation::Absent,
                                ActivationReceiptObservation::Present(receipt),
                            ) => {
                                require_matching_receipt(&record, candidate, &receipt)?;
                                if driver.verify_exited(&candidate.process).is_ok() {
                                    break;
                                }
                                if Instant::now() >= deadline {
                                    return Err(DeployError::Recovery(
                                    "cancelled target did not exit before the recovery deadline"
                                        .to_string(),
                                ));
                                }
                            }
                            (
                                ActivationReceiptObservation::Absent,
                                ActivationReceiptObservation::Absent,
                            ) => {
                                if driver.verify_exited(&candidate.process).is_ok() {
                                    break;
                                }
                                if Instant::now() >= deadline {
                                    return Err(DeployError::Recovery(
                                    "target has not durably accepted cancellation or activation"
                                        .to_string(),
                                ));
                                }
                            }
                            _ => return Err(DeployError::Recovery(
                                "activation cancellation outcome is contradictory or unreadable"
                                    .to_string(),
                            )),
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
            }
            ActivationReceiptObservation::Malformed
            | ActivationReceiptObservation::StorageAmbiguous => {
                return Err(DeployError::Recovery(
                    "activation receipt state is unreadable or storage-ambiguous".to_string(),
                ))
            }
        }
    } else if !matches!(receipt, ActivationReceiptObservation::Absent) {
        return Err(DeployError::Recovery(
            "activation receipt appeared before durable authorization intent".to_string(),
        ));
    }

    rollback(journal, driver, &record)?;
    Ok(RecoveryOutcome::RolledBack)
}

pub(crate) fn reconcile_pending_launch<J, D>(
    journal: &mut J,
    driver: &mut D,
    record: &TransactionRecord,
) -> Result<TransactionRecord>
where
    J: TransactionJournal,
    D: ActivationDriver,
{
    let Some(attempt) = record.pending_launch_attempt().cloned() else {
        return Ok(record.clone());
    };
    let mut observation = ensure_launch_attempt(driver, &attempt, record, false)?;
    if matches!(
        observation,
        crate::activation::LaunchAttemptObservation::Unclaimed
    ) {
        if !matches!(attempt.state, crate::journal::LaunchAttemptState::Unclaimed) {
            return Err(DeployError::Recovery(
                "journaled launch owner disappeared".to_string(),
            ));
        }
        require_unclaimed_launch_safety(driver, record, attempt.lane)?;
        observation = ensure_launch_attempt(driver, &attempt, record, true)?;
    }
    let observed_claim = match &observation {
        crate::activation::LaunchAttemptObservation::Owned(claim)
        | crate::activation::LaunchAttemptObservation::DefinitelyNotStarted(claim)
        | crate::activation::LaunchAttemptObservation::Gated { claim, .. }
        | crate::activation::LaunchAttemptObservation::Ordinary { claim, .. } => {
            Some(claim.clone())
        }
        crate::activation::LaunchAttemptObservation::Unclaimed
        | crate::activation::LaunchAttemptObservation::Malformed
        | crate::activation::LaunchAttemptObservation::StorageAmbiguous => None,
    };

    let mut working = record.clone();
    if matches!(attempt.state, crate::journal::LaunchAttemptState::Unclaimed) {
        let claim = observed_claim.clone().ok_or_else(|| {
            DeployError::Recovery(
                "launch executor did not publish an exact durable ownership claim".to_string(),
            )
        })?;
        working = working.with_launch_owned(claim)?;
        journal.save(&working)?;
    } else if attempt.claim() != observed_claim.as_ref() {
        return Err(DeployError::Recovery(
            "launch ownership changed or disappeared during recovery".to_string(),
        ));
    }

    match observation {
        crate::activation::LaunchAttemptObservation::Owned(_) => Err(DeployError::Recovery(
            "launch executor still owns the attempt; waiting for a terminal outcome".to_string(),
        )),
        crate::activation::LaunchAttemptObservation::DefinitelyNotStarted(claim) => {
            let resolved = working.with_launch_definitely_not_started(claim)?;
            journal.save(&resolved)?;
            Ok(resolved)
        }
        crate::activation::LaunchAttemptObservation::Gated { claim, candidate }
            if attempt.lane == crate::journal::LaunchLane::TargetGated =>
        {
            crate::journal::validate_candidate(&working, &candidate)?;
            let bound = working.with_bound_gated_candidate(claim, candidate)?;
            journal.save(&bound)?;
            Ok(bound)
        }
        crate::activation::LaunchAttemptObservation::Ordinary { claim, process }
            if matches!(
                attempt.lane,
                crate::journal::LaunchLane::PriorRollback
                    | crate::journal::LaunchLane::TargetRollForward
            ) =>
        {
            crate::journal::validate_generation_process(
                &working,
                &process,
                attempt.lane == crate::journal::LaunchLane::PriorRollback,
            )?;
            let bound = working.with_bound_relaunch_attempt(claim, process)?;
            journal.save(&bound)?;
            Ok(bound)
        }
        _ => Err(DeployError::Recovery(
            "launch attempt state is ambiguous, malformed, or belongs to the wrong lane"
                .to_string(),
        )),
    }
}

fn require_unclaimed_launch_safety<D: ActivationDriver>(
    driver: &mut D,
    record: &TransactionRecord,
    lane: crate::journal::LaunchLane,
) -> Result<()> {
    let expected = match lane {
        crate::journal::LaunchLane::TargetGated | crate::journal::LaunchLane::PriorRollback => {
            &record.prior_generation_id
        }
        crate::journal::LaunchLane::TargetRollForward => &record.target_generation_id,
    };
    require_selected(driver, expected)?;
    let state = driver.observe_port(record)?;
    validate_port_state(record, &state)?;
    if !matches!(state, PortState::Free) {
        return Err(DeployError::Recovery(
            "unclaimed launch attempt requires an exactly free port".to_string(),
        ));
    }
    verify_owned_predecessors_exited(driver, record)?;
    require_selected(driver, expected)
}

fn ensure_launch_attempt<D: ActivationDriver>(
    driver: &mut D,
    attempt: &crate::journal::LaunchAttempt,
    record: &TransactionRecord,
    claim_if_unclaimed: bool,
) -> Result<crate::activation::LaunchAttemptObservation> {
    let spec = crate::activation::LaunchSpec::for_attempt(record, attempt)?;
    driver.ensure_launch_attempt(&spec, attempt, claim_if_unclaimed)
}

pub(crate) fn roll_forward_confirmed<J, D>(
    journal: &mut J,
    driver: &mut D,
    record: &TransactionRecord,
) -> Result<()>
where
    J: TransactionJournal,
    D: ActivationDriver,
{
    if record.phase != TransactionPhase::ActivationConfirmed {
        return Err(DeployError::Recovery(
            "roll-forward requires durable activation_confirmed".to_string(),
        ));
    }
    let mut working = record.clone();
    let selected = driver.selected_generation()?;
    if selected != working.target_generation_id {
        return Err(DeployError::Recovery(format!(
            "current pointer {selected} does not select the durably confirmed target; refusing roll-forward mutation"
        )));
    }
    let state = driver.observe_port(&working)?;
    validate_port_state(&working, &state)?;
    let (process, relaunched) = match state {
        PortState::Target {
            candidate,
            service: ServiceState::Ordinary,
        } => {
            if working.active_relaunch_process().is_some() {
                return Err(DeployError::Recovery(
                    "original target candidate reappeared after ordinary relaunch binding"
                        .to_string(),
                ));
            }
            require_selected(driver, &working.target_generation_id)?;
            (candidate.process, false)
        }
        PortState::Target {
            service: ServiceState::Gated,
            ..
        } => {
            return Err(DeployError::Recovery(
                "confirmed target unexpectedly remains gated".to_string(),
            ))
        }
        PortState::TargetRelaunch { process } => {
            require_selected(driver, &working.target_generation_id)?;
            (process, true)
        }
        PortState::Free => {
            verify_owned_predecessors_exited(driver, &working)?;
            require_selected(driver, &working.target_generation_id)?;
            let created = working.pending_launch_attempt().is_none();
            if created {
                working = working
                    .with_new_launch_attempt(crate::journal::LaunchLane::TargetRollForward)?;
                journal.save(&working)?;
            }
            working = reconcile_pending_launch(journal, driver, &working)?;
            let process = working.active_relaunch_process().cloned().ok_or_else(|| {
                DeployError::Recovery(
                    "target launch executor did not produce a started outcome".to_string(),
                )
            })?;
            validate_relaunched_process(&working, &process, false)?;
            (process, true)
        }
        PortState::Prior { .. } | PortState::Foreign => {
            return Err(DeployError::Recovery(
                "foreign or non-ordinary live port blocks confirmed roll-forward".to_string(),
            ))
        }
    };
    if relaunched {
        require_selected(driver, &working.target_generation_id)?;
        if let Some(expected) = working.active_relaunch_process() {
            if expected != &process {
                driver.verify_exited(expected)?;
                require_selected(driver, &working.target_generation_id)?;
                let rebound = working.with_relaunch_process(process.clone())?;
                journal.save(&rebound)?;
                working = rebound;
            }
        } else {
            let rebound = working.with_relaunch_process(process.clone())?;
            journal.save(&rebound)?;
            working = rebound;
        }
    }
    driver.verify_running(&process)?;
    driver.verify_ordinary(&process)?;
    require_selected(driver, &working.target_generation_id)?;
    let live = LiveReceipt::new(
        working.target_generation_id.clone(),
        Some(working.target_generation_id.clone()),
        false,
        Some(process),
    );
    driver.write_live(&live)?;
    if !working.finalized {
        require_selected(driver, &working.target_generation_id)?;
        journal.save(&working.finalized()?)?;
    }
    Ok(())
}

pub(crate) fn verify_owned_predecessors_exited<D: ActivationDriver>(
    driver: &mut D,
    record: &TransactionRecord,
) -> Result<()> {
    let mut processes = vec![record.expected_prior_process()];
    if let Some(candidate) = &record.candidate {
        processes.push(&candidate.process);
    }
    processes.extend(record.relaunch_attempts.iter());
    for (index, process) in processes.iter().enumerate() {
        if processes[..index].contains(process) {
            continue;
        }
        driver.verify_exited(process)?;
    }
    Ok(())
}

fn recover_client<J, D>(
    journal: &mut J,
    driver: &mut D,
    record: &TransactionRecord,
) -> Result<RecoveryOutcome>
where
    J: TransactionJournal,
    D: ActivationDriver,
{
    let selected = driver.selected_generation()?;
    if matches!(
        record.phase,
        TransactionPhase::Activated | TransactionPhase::ActivationConfirmed
    ) && selected != record.target_generation_id
    {
        return Err(DeployError::Recovery(
            "client-only confirmed transaction requires the target pointer".to_string(),
        ));
    }
    if selected == record.prior_generation_id {
        let state = driver.observe_port(record)?;
        validate_port_state(record, &state)?;
        let process = require_prior_ordinary(&state, record)?;
        driver.verify_running(process)?;
        driver.verify_ordinary(process)?;
        require_selected(driver, &record.prior_generation_id)?;
        driver.write_live(&record.prior_live)?;
        require_selected(driver, &record.prior_generation_id)?;
        let complete = record
            .advanced(TransactionPhase::RollbackComplete)?
            .finalized()?;
        journal.save(&complete)?;
        return Ok(RecoveryOutcome::RolledBack);
    }
    if selected == record.target_generation_id {
        finish_client_selection(journal, driver, record)?;
        return Ok(RecoveryOutcome::ClientSelected);
    }
    Err(DeployError::Recovery(format!(
        "client-only pointer selects foreign generation {selected}"
    )))
}

pub(crate) fn finish_client_selection<J, D>(
    journal: &mut J,
    driver: &mut D,
    record: &TransactionRecord,
) -> Result<()>
where
    J: TransactionJournal,
    D: ActivationDriver,
{
    if driver.selected_generation()? != record.target_generation_id {
        return Err(DeployError::Recovery(
            "client-only target pointer is not selected".to_string(),
        ));
    }
    let state = driver.observe_port(record)?;
    validate_port_state(record, &state)?;
    let process = require_prior_ordinary(&state, record)?;
    driver.verify_running(process)?;
    driver.verify_ordinary(process)?;
    require_selected(driver, &record.target_generation_id)?;
    let live = LiveReceipt::new(
        record.target_generation_id.clone(),
        Some(record.prior_running_generation_id().to_string()),
        record.prior_live.legacy,
        Some(process.clone()),
    );
    driver.write_live(&live)?;
    require_selected(driver, &record.target_generation_id)?;
    let confirmed = match record.phase {
        TransactionPhase::ActivationConfirmed => record.clone(),
        TransactionPhase::Activated | TransactionPhase::SwitchCurrentIntent => {
            let activated = if record.phase == TransactionPhase::SwitchCurrentIntent {
                record.advanced(TransactionPhase::Activated)?
            } else {
                record.clone()
            };
            if activated.phase != record.phase {
                require_selected(driver, &record.target_generation_id)?;
                journal.save(&activated)?;
            }
            let confirmed = activated.advanced(TransactionPhase::ActivationConfirmed)?;
            require_selected(driver, &record.target_generation_id)?;
            journal.save(&confirmed)?;
            confirmed
        }
        _ => {
            return Err(DeployError::Recovery(
                "client-only target pointer has an invalid journal phase".to_string(),
            ))
        }
    };
    if !confirmed.finalized {
        require_selected(driver, &record.target_generation_id)?;
        journal.save(&confirmed.finalized()?)?;
    }
    Ok(())
}

fn require_selected<D: ActivationDriver>(driver: &mut D, expected: &str) -> Result<()> {
    let selected = driver.selected_generation()?;
    if selected != expected {
        return Err(DeployError::Recovery(format!(
            "current pointer changed to {selected}; expected {expected} during recovery"
        )));
    }
    Ok(())
}
