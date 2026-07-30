use crate::activation::{
    require_matching_receipt, require_prior_ordinary, require_target, validate_port_state,
    ActivationDriver, ActivationReceiptObservation, PortState, ServiceState,
};
use crate::error::{DeployError, Result};
use crate::journal::{TransactionJournal, TransactionPhase, TransactionRecord, UpdateMode};
use crate::receipts::LiveReceipt;
use crate::rollback::{rollback, validate_relaunched_process};

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
    let record = journal
        .load()?
        .ok_or_else(|| DeployError::Recovery("no durable transaction to recover".to_string()))?;
    record.validate()?;
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
                let activated = if record.phase == TransactionPhase::Activated {
                    record.clone()
                } else {
                    record.advanced(TransactionPhase::Activated)?
                };
                if activated.phase != record.phase {
                    require_selected(driver, &record.target_generation_id)?;
                    journal.save(&activated)?;
                }
                let confirmed = activated.advanced(TransactionPhase::ActivationConfirmed)?;
                require_selected(driver, &record.target_generation_id)?;
                journal.save(&confirmed)?;
                roll_forward_confirmed(journal, driver, &confirmed)?;
                return Ok(RecoveryOutcome::Activated);
            }
            ActivationReceiptObservation::Absent if record.phase < TransactionPhase::Activated => {}
            ActivationReceiptObservation::Absent => {
                return Err(DeployError::Recovery(
                    "observed activation evidence disappeared before controller confirmation"
                        .to_string(),
                ))
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
    if selected != working.prior_generation_id && selected != working.target_generation_id {
        return Err(DeployError::Recovery(format!(
            "foreign current pointer {selected}; refusing roll-forward mutation"
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
            if selected == working.prior_generation_id {
                driver.switch_generation(
                    &working.prior_generation_id,
                    &working.target_generation_id,
                )?;
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
            if selected == working.prior_generation_id {
                driver.switch_generation(
                    &working.prior_generation_id,
                    &working.target_generation_id,
                )?;
            }
            require_selected(driver, &working.target_generation_id)?;
            (process, true)
        }
        PortState::Free => {
            if let Some(previous) = working.active_relaunch_process() {
                driver.verify_exited(previous)?;
            }
            if selected == working.prior_generation_id {
                driver.switch_generation(
                    &working.prior_generation_id,
                    &working.target_generation_id,
                )?;
            }
            require_selected(driver, &working.target_generation_id)?;
            let runtime = crate::journal::live_runtime(
                &working.target_runtime,
                &working.target_generation_root,
            )?;
            let process = driver.start_ordinary(
                &working.target_generation_root,
                &working.target_generation_id,
                &runtime,
                &working.target_node,
            )?;
            validate_relaunched_process(&working, &process, false)?;
            (process, true)
        }
        PortState::Prior {
            process,
            service: ServiceState::Ordinary,
        } => {
            if working.active_relaunch_process().is_some()
                || process != *working.expected_prior_process()
            {
                return Err(DeployError::Recovery(
                    "prior process identity changed after target confirmation".to_string(),
                ));
            }
            driver.verify_running(&process)?;
            require_selected(driver, &selected)?;
            driver.stop(&process)?;
            if selected == working.prior_generation_id {
                driver.switch_generation(
                    &working.prior_generation_id,
                    &working.target_generation_id,
                )?;
            }
            require_selected(driver, &working.target_generation_id)?;
            let runtime = crate::journal::live_runtime(
                &working.target_runtime,
                &working.target_generation_root,
            )?;
            let process = driver.start_ordinary(
                &working.target_generation_root,
                &working.target_generation_id,
                &runtime,
                &working.target_node,
            )?;
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
