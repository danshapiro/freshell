use crate::activation::{require_target, ActivationDriver, PortState, ServiceState};
use crate::error::{DeployError, Result};
use crate::journal::{
    validate_generation_process, TransactionJournal, TransactionPhase, TransactionRecord,
};
use crate::receipts::LiveReceipt;
use crate::recovery::verify_owned_predecessors_exited;

pub(crate) fn rollback<J, D>(
    journal: &mut J,
    driver: &mut D,
    record: &TransactionRecord,
) -> Result<()>
where
    J: TransactionJournal,
    D: ActivationDriver,
{
    let selected = driver.selected_generation()?;
    if selected != record.prior_generation_id && selected != record.target_generation_id {
        return Err(DeployError::Recovery(format!(
            "foreign current pointer {selected}; refusing rollback mutation"
        )));
    }

    let mut working = record.clone();
    let initial = driver.observe_port(&working)?;
    let (retained_prior, gated_target) = match &initial {
        PortState::Target {
            service: ServiceState::Gated,
            ..
        } => {
            let process = require_target(&initial, &working, ServiceState::Gated)?;
            (None, Some(process.clone()))
        }
        PortState::Free => (None, None),
        PortState::Prior {
            process,
            service: ServiceState::Ordinary,
        } => (
            Some((process.clone(), classify_prior(&working, process)?)),
            None,
        ),
        PortState::Target {
            service: ServiceState::Ordinary,
            ..
        }
        | PortState::TargetRelaunch { .. } => {
            return Err(DeployError::Recovery(
                "unconfirmed ordinary target is ambiguous; refusing rollback signal".to_string(),
            ))
        }
        PortState::Prior { .. } | PortState::Foreign => {
            return Err(DeployError::Recovery(
                "live port ownership/service is unsafe for rollback".to_string(),
            ))
        }
    };

    if selected == record.target_generation_id {
        driver.switch_generation(&record.target_generation_id, &record.prior_generation_id)?;
    }
    require_selected(driver, &record.prior_generation_id)?;
    if let Some(process) = gated_target {
        driver.stop(&process)?;
    }

    let (process, relaunched) = if let Some(retained) = retained_prior {
        retained
    } else {
        let after_stop = driver.observe_port(&working)?;
        match after_stop {
            PortState::Free => {
                verify_owned_predecessors_exited(driver, &working)?;
                let created = working.pending_launch_attempt().is_none();
                if created {
                    working = working
                        .with_new_launch_attempt(crate::journal::LaunchLane::PriorRollback)?;
                    journal.save(&working)?;
                }
                require_selected(driver, &working.prior_generation_id)?;
                working = crate::recovery::reconcile_pending_launch(journal, driver, &working)?;
                let process = working.active_relaunch_process().cloned().ok_or_else(|| {
                    DeployError::Recovery(
                        "prior launch executor did not produce a started outcome".to_string(),
                    )
                })?;
                validate_relaunched_process(&working, &process, true)?;
                (process, true)
            }
            PortState::Prior {
                process,
                service: ServiceState::Ordinary,
            } => (process.clone(), classify_prior(&working, &process)?),
            _ => {
                return Err(DeployError::Recovery(
                    "port was not safely free for prior relaunch".to_string(),
                ))
            }
        }
    };
    if relaunched && working.active_relaunch_process() != Some(&process) {
        if let Some(previous) = working.active_relaunch_process() {
            driver.verify_exited(previous)?;
        }
        require_selected(driver, &working.prior_generation_id)?;
        let rebound = working.with_relaunch_process(process.clone())?;
        journal.save(&rebound)?;
        working = rebound;
    }
    driver.verify_running(&process)?;
    driver.verify_ordinary(&process)?;
    let (legacy, running_generation_id) = if relaunched {
        (false, working.prior_generation_id.clone())
    } else {
        (
            working.prior_live.legacy,
            working.prior_running_generation_id().to_string(),
        )
    };
    let live = LiveReceipt::new(
        working.prior_generation_id.clone(),
        Some(running_generation_id),
        legacy,
        Some(process.clone()),
    );
    require_selected(driver, &working.prior_generation_id)?;
    driver.write_live(&live)?;
    require_selected(driver, &working.prior_generation_id)?;
    let complete = working
        .advanced(TransactionPhase::RollbackComplete)?
        .finalized()?;
    journal.save(&complete)
}

pub(crate) fn validate_relaunched_process(
    record: &TransactionRecord,
    process: &crate::process_identity::ProcessIdentity,
    prior: bool,
) -> Result<()> {
    validate_generation_process(record, process, prior)
}

fn classify_prior(
    record: &TransactionRecord,
    process: &crate::process_identity::ProcessIdentity,
) -> Result<bool> {
    if let Some(relaunched) = record.active_relaunch_process() {
        if relaunched != process {
            validate_generation_process(record, process, true)?;
            return Ok(true);
        }
        validate_generation_process(record, process, true)?;
        return Ok(true);
    }
    if process == record.expected_prior_process() {
        return Ok(false);
    }
    // A crash can occur after start_ordinary returns but before its exact
    // identity reaches the journal. The immutable executable/runtime/root
    // proof permits reconstruction without signaling this process.
    validate_generation_process(record, process, true)?;
    Ok(true)
}

fn require_selected<D: ActivationDriver>(driver: &mut D, expected: &str) -> Result<()> {
    let selected = driver.selected_generation()?;
    if selected != expected {
        return Err(DeployError::Recovery(format!(
            "current pointer changed to {selected}; expected {expected} during rollback"
        )));
    }
    Ok(())
}
