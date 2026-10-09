//! Provider-bound creation authority for ordinary inputs and OpenCode auth lookup.
use super::*;
use freshell_runtime_protocol::{
    InitialAuthVolumeObservation, ProviderInputReservation, ReserveProviderInputsRequest,
};
use rusqlite::Transaction;

#[derive(Debug, Clone)]
pub struct OwnedInputReservation {
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) installation_id: InstallationId,
    pub(crate) soul_id: SoulId,
    pub(crate) creation_seed_ref: String,
    pub(crate) provider_volume_name: String,
    pub(crate) image_ref: String,
    pub(crate) binary: PathBuf,
    pub(crate) binary_sha256: String,
    pub(crate) prior_observation: Option<InitialAuthVolumeObservation>,
}
#[derive(Debug, Clone)]
pub struct BoundInputReservation {
    pub(crate) reservation: OwnedInputReservation,
    pub(crate) incarnation_id: IncarnationId,
    pub(crate) observation: InitialAuthVolumeObservation,
}
impl BoundInputReservation {
    pub(crate) fn verify_artifact(&self) -> Result<(), RegistryError> {
        if binary_digest(&self.reservation.binary)? != self.reservation.binary_sha256 {
            return Err(RegistryError::InvalidState(
                "initial auth reserved runtime artifact changed".into(),
            ));
        }
        Ok(())
    }
}
pub(super) fn create_table(conn: &Connection) -> Result<(), RegistryError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS provider_input_preparations (
        soul_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE,
        creation_seed_ref TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'opencode', image_ref TEXT NOT NULL,
        host_binary_path TEXT NOT NULL, host_binary_sha256 TEXT NOT NULL,
        intent_revision INTEGER NOT NULL CHECK(intent_revision=1),
        observation TEXT, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
        bound_incarnation_id TEXT UNIQUE
    );",
    )?;
    Ok(())
}
pub(crate) fn binary_digest(binary: &Path) -> Result<String, RegistryError> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let metadata = std::fs::symlink_metadata(binary)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || std::fs::canonicalize(binary)? != binary
    {
        return Err(RegistryError::InvalidState(
            "input reservation binary must be canonical and regular".into(),
        ));
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(binary)?;
    let opened = file.metadata()?;
    if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
        return Err(RegistryError::InvalidState(
            "input binary changed during reservation".into(),
        ));
    }
    let mut reader = file.take(
        metadata
            .len()
            .checked_add(1)
            .ok_or_else(|| RegistryError::InvalidState("input binary size overflow".into()))?,
    );
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut observed = 0u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        observed += count as u64;
        if observed > metadata.len() {
            return Err(RegistryError::InvalidState(
                "input binary changed during reservation".into(),
            ));
        }
        hash.update(&buffer[..count]);
    }
    let after = reader.get_ref().metadata()?;
    let path_after = std::fs::symlink_metadata(binary)?;
    if observed != metadata.len()
        || path_after.dev() != metadata.dev()
        || path_after.ino() != metadata.ino()
        || after.len() != metadata.len()
        || after.mtime() != metadata.mtime()
        || after.mtime_nsec() != metadata.mtime_nsec()
        || after.ctime() != metadata.ctime()
        || after.ctime_nsec() != metadata.ctime_nsec()
    {
        return Err(RegistryError::InvalidState(
            "input binary changed during reservation".into(),
        ));
    }
    Ok(format!("{:x}", hash.finalize()))
}
// The sole reuse authority is a settled, explicitly rejected initial grant.
// A missing native ID, ordinary stopped host, or uncertain delivery is insufficient.
fn initial_or_rejected_creation(conn: &Connection, soul: &SoulId) -> Result<bool, RegistryError> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM souls WHERE soul_id=?1)",
        [soul.as_str()],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(true);
    };
    let eligible:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM souls s JOIN provider_input_preparations p ON p.soul_id=s.soul_id WHERE s.soul_id=?1 AND s.provider='opencode' AND s.native_session_id IS NULL AND s.desired_state='running' AND s.intent_revision=1 AND s.creation_seed_ref=p.creation_seed_ref AND p.provider=s.provider AND p.consumed=0 AND p.bound_incarnation_id IS NULL AND NOT EXISTS(SELECT 1 FROM incarnations i WHERE i.soul_id=s.soul_id AND i.launch_state!='stopped') AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.soul_id=s.soul_id AND c.state!='provider_inputs_changed') AND (SELECT COUNT(*) FROM commands c WHERE c.soul_id=s.soul_id AND c.state='provider_inputs_changed') BETWEEN 1 AND 2 AND NOT EXISTS(SELECT 1 FROM input_commands c WHERE c.soul_id=s.soul_id))",[soul.as_str()],|row|row.get(0))?;
    Ok(eligible)
}

impl Registry {
    pub(crate) async fn validate_rejected_initial_inputs(
        &self,
        incarnation: IncarnationId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            rejected_initial_observation(&conn, &incarnation)?;
            Ok(())
        })
        .await
    }
    pub(crate) async fn settle_rejected_initial_inputs(
        &self,
        incarnation: IncarnationId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move|mut conn| {
            let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (soul,observation)=rejected_initial_observation(&tx,&incarnation)?;
            let retained=match observation {
                InitialAuthVolumeObservation::Absent {daemon_id} => InitialAuthVolumeObservation::OwnedUndispatched {daemon_id,incarnation_id:incarnation.clone()},
                owned @ InitialAuthVolumeObservation::OwnedUndispatched {..} => owned,
            };
            tx.execute("UPDATE provider_input_preparations SET consumed=0,bound_incarnation_id=NULL,observation=?1 WHERE soul_id=?2 AND bound_incarnation_id=?3 AND consumed=1",params![serde_json::to_string(&retained)?,soul,incarnation.as_str()])?;
            tx.execute("UPDATE incarnations SET launch_state='stopped',cleanup_state='verified_empty',updated_at=?1 WHERE incarnation_id=?2",params![now_millis(),incarnation.as_str()])?;
            tx.execute("UPDATE commands SET state='provider_inputs_changed',updated_at=?1 WHERE incarnation_id=?2",params![now_millis(),incarnation.as_str()])?;
            tx.execute("DELETE FROM admission_reservations WHERE incarnation_id=?1",[incarnation.as_str()])?;
            tx.execute("DELETE FROM writer_claims WHERE incarnation_id=?1",[incarnation.as_str()])?;
            tx.commit()?;Ok(())
        }).await
    }
    pub(crate) async fn bound_input_reservation(
        &self,
        incarnation_id: IncarnationId,
    ) -> Result<Option<BoundInputReservation>, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move |conn| {
            let row: Option<(String,String,String,String,String,String,String,String)> = conn.query_row(
                "SELECT p.soul_id,p.reservation_id,p.creation_seed_ref,p.image_ref,p.host_binary_path,p.host_binary_sha256,p.observation,p.provider FROM provider_input_preparations p JOIN incarnations i ON i.incarnation_id=p.bound_incarnation_id JOIN souls s ON s.soul_id=p.soul_id WHERE p.bound_incarnation_id=?1 AND p.consumed=1 AND i.launch_state='prepared' AND i.soul_id=p.soul_id AND s.desired_state='running' AND s.intent_revision=p.intent_revision AND s.provider=p.provider AND s.creation_seed_ref=p.creation_seed_ref",
                params![incarnation_id.as_str()], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))
            ).optional()?;
            let Some((soul,id,seed,image,path,sha,observation,provider))=row else {return Ok(None)};
            let binary=PathBuf::from(path);
            if binary_digest(&binary)?!=sha {return Err(RegistryError::InvalidState("initial auth source artifact changed before launch".into()));}
            let soul=SoulId::parse(soul).map_err(|_|RegistryError::Integrity("invalid reserved soul".into()))?;
            Ok(Some(BoundInputReservation {
                reservation:OwnedInputReservation{id,provider,provider_volume_name:stable_provider_volume_name(&installation,&soul),installation_id:installation,soul_id:soul,creation_seed_ref:seed,image_ref:image,binary,binary_sha256:sha,prior_observation:Some(serde_json::from_str(&observation)?)},
                incarnation_id,observation:serde_json::from_str(&observation)?
            }))
        }).await
    }
    pub(crate) async fn initial_input_reservation(
        &self,
        soul: SoulId,
        id: String,
    ) -> Result<Option<(OwnedInputReservation, InitialAuthVolumeObservation)>, RegistryError> {
        let installation = self.installation_id().clone();
        self.run_blocking(move|conn|{
            let row:Option<(String,String,String,String,String,String)>=conn.query_row("SELECT creation_seed_ref,image_ref,host_binary_path,host_binary_sha256,observation,provider FROM provider_input_preparations WHERE soul_id=?1 AND reservation_id=?2 AND consumed=0 AND observation IS NOT NULL",params![soul.as_str(),id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional()?;
            let Some((seed,image,path,digest,observation,provider))=row else{return Ok(None)};
            if !initial_or_rejected_creation(&conn,&soul)? {return Ok(None)};
            let binary=PathBuf::from(path);
            if binary_digest(&binary)?!=digest{return Err(RegistryError::InvalidState("initial auth source artifact changed; reprepare before dispatch".into()));}
            let volume=stable_provider_volume_name(&installation,&soul);
            Ok(Some((OwnedInputReservation{id,provider,installation_id:installation,soul_id:soul,creation_seed_ref:seed,provider_volume_name:volume,image_ref:image,binary,binary_sha256:digest,prior_observation:Some(serde_json::from_str(&observation)?)},serde_json::from_str(&observation)?)))
        }).await
    }
    pub(crate) async fn reserve_initial_inputs(
        &self,
        request: ReserveProviderInputsRequest,
        image_ref: String,
        binary: PathBuf,
    ) -> Result<OwnedInputReservation, RegistryError> {
        if !matches!(
            request.provider.as_str(),
            "opencode" | "codex" | "claude" | "kilroy" | "amplifier"
        ) || request.creation_seed_ref.is_empty()
            || request.creation_seed_ref.len() > 4096
            || request.creation_seed_ref.chars().any(char::is_control)
        {
            return Err(RegistryError::InvalidState(
                "initial input reservation requires a bounded supported-provider creation identity"
                    .into(),
            ));
        }
        let installation = self.installation_id().clone();
        self.run_blocking(move|mut conn|{
            let sha = binary_digest(&binary)?;
            let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM souls WHERE soul_id=?1)",params![request.soul_id.as_str()],|row|row.get(0))?;
            if exists && !initial_or_rejected_creation(&tx,&request.soul_id)? {return Err(RegistryError::InvalidState("initial source requires a creation reservation; existing souls use their owned recovery source".into()));}
            let stored:Option<(String,String,String,String,String,i64,String)>=tx.query_row("SELECT reservation_id,creation_seed_ref,image_ref,host_binary_path,host_binary_sha256,consumed,provider FROM provider_input_preparations WHERE soul_id=?1",params![request.soul_id.as_str()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional()?;
            let id=if let Some((id,seed,image,path,digest,consumed,provider))=stored {
                if provider!=request.provider || seed!=request.creation_seed_ref || image!=image_ref || Path::new(&path)!=binary || digest!=sha || consumed!=0 {return Err(RegistryError::RequestConflict);}
                id
            } else {
                let id=uuid::Uuid::new_v4().to_string();
                tx.execute("INSERT INTO provider_input_preparations (soul_id,reservation_id,creation_seed_ref,image_ref,host_binary_path,host_binary_sha256,intent_revision,provider) VALUES (?1,?2,?3,?4,?5,?6,1,?7)",params![request.soul_id.as_str(),id,request.creation_seed_ref,image_ref,binary.to_string_lossy(),sha,request.provider])?;
                id
            };
            let prior_observation:Option<String>=tx.query_row("SELECT observation FROM provider_input_preparations WHERE soul_id=?1",[request.soul_id.as_str()],|row|row.get(0))?;
            let prior_observation=prior_observation.map(|raw|serde_json::from_str(&raw)).transpose()?;
            let volume=stable_provider_volume_name(&installation,&request.soul_id);
            tx.commit()?;
            Ok(OwnedInputReservation{id,provider:request.provider,installation_id:installation,soul_id:request.soul_id,creation_seed_ref:request.creation_seed_ref,provider_volume_name:volume,image_ref,binary,binary_sha256:sha,prior_observation})
        }).await
    }
    pub(crate) async fn record_initial_observation(
        &self,
        reservation: OwnedInputReservation,
        observation: InitialAuthVolumeObservation,
    ) -> Result<ProviderInputReservation, RegistryError> {
        let stored = serde_json::to_string(&observation)?;
        self.run_blocking(move|mut conn|{
            let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !initial_or_rejected_creation(&tx,&reservation.soul_id)? {return Err(RegistryError::RequestConflict)};
            let updated=tx.execute("UPDATE provider_input_preparations SET observation=?1 WHERE soul_id=?2 AND reservation_id=?3 AND consumed=0 AND host_binary_sha256=?4 AND provider=?5 AND (observation IS NULL OR observation=?1)",params![stored,reservation.soul_id.as_str(),reservation.id,reservation.binary_sha256,reservation.provider])?;
            if updated!=1 {return Err(RegistryError::RequestConflict);}
            tx.commit()?;
            Ok(ProviderInputReservation{reservation_id:reservation.id,installation_id:reservation.installation_id,soul_id:reservation.soul_id,provider:reservation.provider,creation_seed_ref:reservation.creation_seed_ref,intent_revision:1,provider_volume_name:reservation.provider_volume_name,image_ref:reservation.image_ref,host_binary_path:reservation.binary.to_string_lossy().into_owned(),host_binary_sha256:reservation.binary_sha256,observation})
        }).await
    }
}

pub(super) fn reservation_reference(input: &LaunchPreparation) -> Option<&str> {
    input
        .terminal
        .as_ref()
        .and_then(|workload| workload.provider_launch_context.as_ref())
        .or_else(|| {
            input
                .fresh_agent
                .as_ref()
                .and_then(|workload| workload.provider_launch_context.as_ref())
        })
        .and_then(|context| context.prepared_inputs.as_ref())
        .and_then(|inputs| inputs.initial_auth_reservation.as_deref())
}

pub(super) fn bind_in_transaction(
    tx: &Transaction<'_>,
    input: &LaunchPreparation,
    incarnation: &IncarnationId,
) -> Result<(), RegistryError> {
    let Some(id) = reservation_reference(input) else {
        return Ok(());
    };
    // Ordinary resources bind to the same provider/soul/creation seed even
    // when the launcher has already assigned an exact native identity.
    // This does not grant native-auth lookup; OpenCode's initial auth authority
    // still requires an identity-free creation, and host resume checks remain.
    if input.native_session_id.is_some()
        && !matches!(
            input.provider.as_str(),
            "codex" | "claude" | "kilroy" | "amplifier"
        )
    {
        return Err(RegistryError::RequestConflict);
    }
    let changed=tx.execute(
        "UPDATE provider_input_preparations SET consumed=1,bound_incarnation_id=?1 WHERE soul_id=?2 AND reservation_id=?3 AND creation_seed_ref=?4 AND observation IS NOT NULL AND consumed=0 AND bound_incarnation_id IS NULL AND EXISTS(SELECT 1 FROM souls WHERE soul_id=?2 AND desired_state='running' AND intent_revision=1 AND provider=?5 AND creation_seed_ref=?4) AND provider=?5",
        params![incarnation.as_str(),input.soul_id.as_str(),id,input.creation_seed_ref,input.provider])?;
    if changed != 1 {
        return Err(RegistryError::RequestConflict);
    }
    Ok(())
}

pub(super) fn check_bound_reference(
    conn: &Connection,
    input: &LaunchPreparation,
    incarnation: &IncarnationId,
) -> Result<(), RegistryError> {
    let stored:Option<(String,String,String)>=conn.query_row("SELECT reservation_id,provider,creation_seed_ref FROM provider_input_preparations WHERE bound_incarnation_id=?1 AND soul_id=?2 AND consumed=1",params![incarnation.as_str(),input.soul_id.as_str()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
    if stored.as_ref().map(|(id, _, _)| id.as_str()) != reservation_reference(input)
        || stored.as_ref().is_some_and(|(_, provider, seed)| {
            provider != &input.provider || seed != &input.creation_seed_ref
        })
    {
        return Err(RegistryError::RequestConflict);
    }
    Ok(())
}

fn rejected_initial_observation(
    conn: &Connection,
    incarnation: &IncarnationId,
) -> Result<(String, InitialAuthVolumeObservation), RegistryError> {
    let row:Option<(String,String)>=conn.query_row("SELECT s.soul_id,p.observation FROM provider_input_preparations p JOIN incarnations i ON i.incarnation_id=p.bound_incarnation_id JOIN souls s ON s.soul_id=p.soul_id WHERE i.incarnation_id=?1 AND i.soul_id=s.soul_id AND p.consumed=1 AND p.provider='opencode' AND s.provider=p.provider AND s.creation_seed_ref=p.creation_seed_ref AND s.native_session_id IS NULL AND s.desired_state='running' AND s.intent_revision=1 AND i.launch_state='starting' AND i.provider_preparation_pending=0 AND NOT EXISTS(SELECT 1 FROM input_commands c WHERE c.soul_id=s.soul_id) AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.soul_id=s.soul_id AND c.incarnation_id!=i.incarnation_id AND c.state!='provider_inputs_changed') AND (SELECT COUNT(*) FROM commands c WHERE c.soul_id=s.soul_id AND c.state='provider_inputs_changed')<3",[incarnation.as_str()],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    let (soul, raw) = row.ok_or_else(|| {
        RegistryError::InvalidState(
            "initial provider inputs rejection has no undispatched creation ownership".into(),
        )
    })?;
    Ok((soul, serde_json::from_str(&raw)?))
}
