use std::fmt;
use std::path::Path;

use uuid::Uuid;

use crate::activation::{ActivationController, ActivationRequest};
use crate::controller_command::{ControllerCommand, DeployCommand};
use crate::deployment::{assemble_generation, GenerationDescriptor};
use crate::error::{DeployError, Result};
use crate::journal::{
    ControlPaths, DurableTransactionJournal, TransactionJournal, TransactionPhase,
};
use crate::legacy::LegacyCaptureReceipt;
use crate::process_identity::{FileIdentity, RuntimeProvenance};
use crate::real_driver::{runtime_from_bindings, RealActivationDriver};
use crate::store::{Generation, LockedStore, Store};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapStatus {
    Fresh,
    CaptureRequired,
    CapturedLegacy,
    Managed,
}

impl fmt::Display for BootstrapStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Fresh => "fresh",
            Self::CaptureRequired => "capture-required",
            Self::CapturedLegacy => "captured-legacy",
            Self::Managed => "managed",
        })
    }
}

pub fn inspect_bootstrap_status(store: &Store) -> Result<BootstrapStatus> {
    let selected = store.selected_generation_id()?;
    let live = store.read_live()?;
    let legacy = store.read_legacy_capture()?;
    match (selected, live, legacy) {
        (None, None, None) => Ok(BootstrapStatus::Fresh),
        (Some(selected), None, None) => {
            GenerationDescriptor::read(&store.verify_generation(&selected)?)?;
            Ok(BootstrapStatus::Fresh)
        }
        (Some(selected), Some(live), legacy) if live.selected_generation_id == selected => {
            let generation = store.verify_generation(&selected)?;
            match GenerationDescriptor::read(&generation) {
                Ok(_) if !live.legacy => Ok(BootstrapStatus::Managed),
                Ok(_) => Err(DeployError::InvalidReceipt(
                    "managed selected generation has a legacy live receipt".to_string(),
                )),
                Err(descriptor_error) => {
                    let legacy = legacy.ok_or(descriptor_error)?;
                    require_exact_captured_legacy(&selected, &live, &legacy)?;
                    Ok(BootstrapStatus::CapturedLegacy)
                }
            }
        }
        (_, _, Some(_)) if crate::legacy::legacy_bootstrap_is_incomplete(store)? => {
            Ok(BootstrapStatus::CaptureRequired)
        }
        _ => Err(DeployError::InvalidReceipt(
            "deployment bootstrap state is partial or internally inconsistent".to_string(),
        )),
    }
}

fn inspect_operational_bootstrap_status(store: &Store) -> Result<BootstrapStatus> {
    let status = inspect_bootstrap_status(store)?;
    if status == BootstrapStatus::Fresh
        && crate::process_identity::LinuxProcfs::default()
            .port_has_listener(store.paths().port())?
    {
        return Ok(BootstrapStatus::CaptureRequired);
    }
    Ok(status)
}

pub fn execute_controller(command: ControllerCommand) -> Result<String> {
    match command {
        ControllerCommand::BootstrapStatus { checkout, port } => {
            crate::lifecycle::recover_pending(&checkout, port)?;
            let store = Store::open(&checkout, port)?;
            if has_unfinished_transaction(&store)? {
                let auth_token = load_auth_token(&checkout)?;
                recover_unfinished(&store, &auth_token)?;
            }
            Ok(inspect_operational_bootstrap_status(&store)?.to_string())
        }
        ControllerCommand::Deploy(command) => {
            execute_deploy(*command)?;
            Ok("deployment activated".to_string())
        }
        ControllerCommand::StartCurrent {
            checkout,
            port,
            restart,
        } => {
            crate::lifecycle::execute_start_current(&checkout, port, restart)?;
            Ok(if restart {
                "current generation restarted"
            } else {
                "current generation running"
            }
            .to_string())
        }
        ControllerCommand::StopCurrent { checkout, port } => {
            crate::lifecycle::execute_stop_current(&checkout, port)?;
            Ok("current generation stopped".to_string())
        }
    }
}

fn execute_deploy(command: DeployCommand) -> Result<()> {
    crate::lifecycle::recover_pending(&command.checkout, command.port)?;
    let store = Store::open(&command.checkout, command.port)?;
    let auth_token = load_auth_token(&command.checkout)?;
    recover_unfinished(&store, &auth_token)?;
    store
        .lock()?
        .prune_generations(crate::store::DEFAULT_RETAINED_UNPROTECTED_GENERATIONS)?;
    let prior_id = store.selected_generation_id()?;
    let live = store.read_live()?;
    let legacy = store.read_legacy_capture()?;
    let fresh = live.is_none() && legacy.is_none();
    if fresh
        && crate::process_identity::LinuxProcfs::default()
            .port_has_listener(store.paths().port())?
    {
        return Err(DeployError::Activation(
            "fresh deployment port is occupied; legacy capture is required".to_string(),
        ));
    }
    if fresh && command.mode != crate::journal::UpdateMode::Full {
        return Err(DeployError::Activation(
            "a fresh deployment requires a combined client/server generation".to_string(),
        ));
    }
    let target = assemble_generation(&store, &command)?;
    if fresh {
        let locked = store.lock()?;
        if store.selected_generation_id()? != prior_id
            || store.read_live()?.is_some()
            || store.read_legacy_capture()?.is_some()
        {
            return Err(DeployError::Activation(
                "fresh deployment state changed after private assembly".to_string(),
            ));
        }
        RealActivationDriver::new(&store, &locked, auth_token.clone())?
            .preflight_fresh_target(&target.path, &target.id)?;
        locked.select_generation(&target.id)?;
        locked.write_live(&crate::receipts::LiveReceipt::new(
            target.id.clone(),
            None,
            false,
            None,
        ))?;
        drop(locked);
        crate::lifecycle::execute_start_current(&command.checkout, command.port, false)?;
        return Ok(());
    }
    let prior_id = prior_id.ok_or_else(|| {
        DeployError::Activation("deployment requires a selected prior generation".to_string())
    })?;
    if target.id == prior_id {
        if command.mode.changes_server() {
            crate::lifecycle::execute_start_current(&command.checkout, command.port, true)?;
        }
        return Ok(());
    }

    let locked = store.lock()?;
    if store.selected_generation_id()?.as_deref() != Some(prior_id.as_str()) {
        return Err(DeployError::Activation(
            "selected generation changed after private assembly".to_string(),
        ));
    }
    let prior_live = store.read_live()?.ok_or_else(|| {
        DeployError::Activation("authoritative live receipt is missing".to_string())
    })?;
    if prior_live.selected_generation_id != prior_id {
        return Err(DeployError::Activation(
            "live receipt disagrees with selected prior generation".to_string(),
        ));
    }
    let prior = store.verify_generation(&prior_id)?;
    let (prior_runtime, prior_node) = generation_runtime(&store, &prior, true)?;
    let (target_runtime, target_node) = generation_runtime(&store, &target, false)?;
    let transaction_id = Uuid::new_v4().to_string();
    let request = ActivationRequest {
        transaction_id: transaction_id.clone(),
        nonce: Uuid::new_v4().to_string(),
        port: command.port,
        mode: command.mode,
        prior_generation_id: prior.id.clone(),
        target_generation_id: target.id.clone(),
        prior_generation_root: prior.path.clone(),
        target_generation_root: target.path.clone(),
        prior_server_executable: FileIdentity::from_path(
            &prior.path.join("server/freshell-server"),
        )?,
        target_server_executable: FileIdentity::from_path(
            &target.path.join("server/freshell-server"),
        )?,
        prior_runtime,
        target_runtime,
        prior_node,
        target_node,
        prior_live,
        controls: ControlPaths::create_private(store.paths(), &transaction_id)?,
    };
    let mut journal = DurableTransactionJournal::new(store.paths().transaction_journal())?;
    let mut driver = RealActivationDriver::new(&store, &locked, auth_token)?;
    let mut controller = ActivationController::new(&mut journal, &mut driver);
    controller.begin(request)?;
    controller.run().map(|_| ())
}

fn recover_unfinished(store: &Store, auth_token: &str) -> Result<()> {
    if !has_unfinished_transaction(store)? {
        return Ok(());
    }
    let locked = store.lock()?;
    recover_unfinished_locked(store, &locked, auth_token)
}

pub(crate) fn has_unfinished_transaction(store: &Store) -> Result<bool> {
    let journal = DurableTransactionJournal::new(store.paths().transaction_journal())?;
    Ok(journal.load()?.is_some_and(|record| {
        !record.finalized && record.phase != TransactionPhase::RollbackComplete
    }))
}

pub(crate) fn recover_unfinished_locked(
    store: &Store,
    locked: &LockedStore<'_>,
    auth_token: &str,
) -> Result<()> {
    let mut journal = DurableTransactionJournal::new(store.paths().transaction_journal())?;
    let Some(record) = journal.load()? else {
        return Ok(());
    };
    if record.finalized || record.phase == TransactionPhase::RollbackComplete {
        return Ok(());
    }
    let mut driver = RealActivationDriver::new(store, locked, auth_token.to_string())?;
    ActivationController::new(&mut journal, &mut driver)
        .recover()
        .map(|_| ())
}

fn generation_runtime(
    store: &Store,
    generation: &Generation,
    allow_legacy: bool,
) -> Result<(RuntimeProvenance, crate::legacy::NodePrerequisite)> {
    match GenerationDescriptor::read(generation) {
        Ok(descriptor) => Ok((
            descriptor.runtime_provenance(&generation.path),
            descriptor.node,
        )),
        Err(descriptor_error) if allow_legacy => {
            let legacy = store.read_legacy_capture()?.ok_or(descriptor_error)?;
            if legacy.generation_id != generation.id {
                return Err(DeployError::Activation(
                    "descriptor-less generation is not the captured legacy recovery generation"
                        .to_string(),
                ));
            }
            Ok((
                runtime_from_bindings(&generation.path, &legacy.runtime, &legacy.node),
                legacy.node,
            ))
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn require_exact_captured_legacy(
    selected: &str,
    live: &crate::receipts::LiveReceipt,
    legacy: &LegacyCaptureReceipt,
) -> Result<()> {
    if legacy.generation_id != selected {
        return Err(DeployError::InvalidReceipt(
            "captured legacy receipts disagree".to_string(),
        ));
    }
    match (
        live.running_server_generation_id.as_deref(),
        live.process_identity.as_ref(),
    ) {
        (Some(running), Some(process))
            if running == selected && (!live.legacy || process == &legacy.process) =>
        {
            Ok(())
        }
        (None, None) if !live.legacy => Ok(()),
        _ => Err(DeployError::InvalidReceipt(
            "captured legacy receipts disagree".to_string(),
        )),
    }
}

pub(crate) fn load_auth_token(checkout: &Path) -> Result<String> {
    if let Ok(value) = std::env::var("AUTH_TOKEN") {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let path = checkout.join(".env");
    let entries = dotenvy::from_path_iter(&path).map_err(|error| {
        DeployError::Activation(format!(
            "AUTH_TOKEN is unavailable and {} cannot be read: {error}",
            path.display()
        ))
    })?;
    for entry in entries {
        let (key, value) = entry.map_err(|error| {
            DeployError::Activation(format!("cannot parse {}: {error}", path.display()))
        })?;
        if key == "AUTH_TOKEN" && !value.is_empty() {
            return Ok(value);
        }
    }
    Err(DeployError::Activation(
        "AUTH_TOKEN is required by the deployment controller".to_string(),
    ))
}
