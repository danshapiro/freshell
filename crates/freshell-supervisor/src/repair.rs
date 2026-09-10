//! Conservative registry/ownership repair audit.
//!
//! Repair is evidence-driven and deliberately cannot discover kill authority
//! from process names, labels, or partial container ids. The only automatic
//! mutation retires an ungranted PREPARED row whose registry proves no backend
//! object was ever committed. Every uncertain ownership shape remains blocked
//! for operator review.

use crate::{
    notice_outbox::increment_counter_in_tx,
    registry::{Registry, RegistryError},
};
use freshell_runtime_protocol::{RepairAudit, RepairRequest};
use rusqlite::params;
use sha2::{Digest, Sha256};

impl Registry {
    pub async fn repair_audit(&self, request: RepairRequest) -> Result<RepairAudit, RegistryError> {
        self.assert_epoch(request.expected_control_epoch)?;
        self.run_blocking(move |mut conn| {
            let integrity: String =
                conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
            let protected_receipt_count: u64 = conn.query_row(
                "SELECT \
                   (SELECT COUNT(*) FROM outbox WHERE delivered_at IS NULL) + \
                   (SELECT COUNT(*) FROM loss_incidents WHERE cleanup_state!='closed') + \
                   (SELECT COUNT(*) FROM runtime_notices WHERE superseded_by IS NULL)",
                [],
                |row| row.get(0),
            )?;
            let unresolved_object_count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM incarnations \
                 WHERE launch_state IN ('prepared','created','starting','running','stopping') \
                    OR cleanup_state IN ('requested','termination_unconfirmed','blocked_ownership')",
                [],
                |row| row.get(0),
            )?;
            let unknown_ownership_count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM incarnations \
                 WHERE (launch_state IN ('created','starting','running','stopping') \
                        AND (docker_daemon_id IS NULL OR container_id IS NULL OR immutable_config_digest IS NULL)) \
                    OR (container_id IS NOT NULL AND length(container_id) != 64)",
                [],
                |row| row.get(0),
            )?;
            let mut statement = conn.prepare(
                "SELECT incarnation_id,soul_id,launch_state,cleanup_state,container_id \
                 FROM incarnations \
                 WHERE launch_state IN ('prepared','created','starting','running','stopping') \
                    OR cleanup_state IN ('requested','termination_unconfirmed','blocked_ownership') \
                 ORDER BY created_at,incarnation_id LIMIT 500",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?;
            let mut blocked_objects = Vec::new();
            for row in rows {
                let (incarnation, soul, launch, cleanup, container) = row?;
                blocked_objects.push(format!(
                    "registry://soul/{soul}/incarnation/{incarnation}?launch={launch}&cleanup={cleanup}&container={}",
                    container.as_deref().unwrap_or("uncommitted")
                ));
            }
            drop(statement);

            let mut mutation_performed = false;
            let now = crate::registry::now_millis();
            if request.apply && integrity == "ok" && unknown_ownership_count == 0 {
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let candidates = {
                    let mut statement = tx.prepare(
                        "SELECT incarnation_id FROM incarnations \
                         WHERE launch_state='prepared' AND container_id IS NULL \
                           AND docker_daemon_id IS NULL AND grant_id IS NULL",
                    )?;
                    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                    rows.collect::<Result<Vec<_>, _>>()?
                };
                for incarnation in &candidates {
                    tx.execute(
                        "UPDATE incarnations SET launch_state='failed',cleanup_state='verified_empty',updated_at=?1 \
                         WHERE incarnation_id=?2 AND launch_state='prepared' AND container_id IS NULL AND grant_id IS NULL",
                        params![now, incarnation],
                    )?;
                    tx.execute(
                        "DELETE FROM writer_claims WHERE incarnation_id=?1",
                        params![incarnation],
                    )?;
                    tx.execute(
                        "DELETE FROM admission_reservations WHERE incarnation_id=?1",
                        params![incarnation],
                    )?;
                }
                mutation_performed = !candidates.is_empty();
                increment_counter_in_tx(
                    &tx,
                    "repair_outcome",
                    if mutation_performed {
                        "retired_ungranted_prepared"
                    } else {
                        "no_safe_mutation"
                    },
                    1,
                    now,
                )?;
                tx.commit()?;
            }

            let audit = RepairAudit {
                registry_integrity: integrity,
                protected_receipt_count,
                unresolved_object_count,
                unknown_ownership_count,
                blocked_objects,
                mutation_performed,
            };
            let encoded = serde_json::to_string(&audit)?;
            let mut hasher = Sha256::new();
            hasher.update(b"freshell-repair-audit-v1\0");
            hasher.update(encoded.as_bytes());
            let audit_id = format!("repair-{:x}", hasher.finalize());
            if request.apply {
                conn.execute(
                    "INSERT OR IGNORE INTO repair_audits (audit_id,audit_json,created_at) VALUES (?1,?2,?3)",
                    params![audit_id, encoded, now],
                )?;
            }
            Ok(audit)
        })
        .await
    }

    pub async fn unresolved_loss_incident_ids(
        &self,
    ) -> Result<Vec<freshell_runtime_protocol::IncidentId>, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT incident_id FROM loss_incidents WHERE cleanup_state!='closed' ORDER BY created_at,incident_id",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            let mut incidents = Vec::new();
            for row in rows {
                incidents.push(
                    freshell_runtime_protocol::IncidentId::parse(row?)
                        .map_err(|_| RegistryError::Integrity("invalid incident id".into()))?,
                );
            }
            Ok(incidents)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{admission::AdmissionPolicy, registry::LaunchPreparation};
    use freshell_runtime_protocol::{RequestId, RuntimeLimits, RuntimeProfile, SoulId};
    use rusqlite::Connection;

    fn limits() -> RuntimeLimits {
        RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        }
    }

    #[test]
    fn audit_type_defaults_to_no_mutation() {
        let audit = RepairAudit::default();
        assert!(!audit.mutation_performed);
        assert_eq!(audit.unknown_ownership_count, 0);
    }

    #[tokio::test]
    async fn read_only_repair_does_not_persist_an_audit_or_change_db_version() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let observer = Connection::open(dir.path().join("runtime.sqlite3")).unwrap();
        let before_version: u64 = observer
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .unwrap();
        let before_audits: u64 = observer
            .query_row("SELECT COUNT(*) FROM repair_audits", [], |row| row.get(0))
            .unwrap();
        let audit = registry
            .repair_audit(RepairRequest {
                apply: false,
                expected_control_epoch: Some(registry.control_epoch()),
            })
            .await
            .unwrap();
        let after_version: u64 = observer
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .unwrap();
        let after_audits: u64 = observer
            .query_row("SELECT COUNT(*) FROM repair_audits", [], |row| row.get(0))
            .unwrap();
        assert!(!audit.mutation_performed);
        assert_eq!(before_audits, after_audits);
        assert_eq!(before_version, after_version);
    }

    #[tokio::test]
    async fn apply_quarantines_unknown_partial_ownership_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: SoulId::new(),
                provider: "opencode".into(),
                provider_store_id: "repair-unknown-store".into(),
                native_session_id: Some("ses_repair_unknown".into()),
                creation_seed_ref: "repair-unknown-seed".into(),
                request_id: RequestId::new(),
                payload_digest: "repair-unknown-payload".into(),
                requested_limits: limits(),
                profile: RuntimeProfile::Custom,
                project_key: "repair-unknown-project".into(),
                fixture: None,
                terminal: None,
                fresh_agent: None,
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        let db = dir.path().join("runtime.sqlite3");
        let observer = Connection::open(&db).unwrap();
        observer
            .execute(
                "UPDATE incarnations SET container_id='partial-ambiguous-id' WHERE incarnation_id=?1",
                params![prepared.incarnation_id.as_str()],
            )
            .unwrap();
        let before: (String, Option<String>) = observer
            .query_row(
                "SELECT launch_state,container_id FROM incarnations WHERE incarnation_id=?1",
                params![prepared.incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let audit = registry
            .repair_audit(RepairRequest {
                apply: true,
                expected_control_epoch: Some(registry.control_epoch()),
            })
            .await
            .unwrap();

        let after: (String, Option<String>) = observer
            .query_row(
                "SELECT launch_state,container_id FROM incarnations WHERE incarnation_id=?1",
                params![prepared.incarnation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(audit.unknown_ownership_count, 1);
        assert!(!audit.mutation_performed);
        assert_eq!(before, after);
        assert_eq!(audit.blocked_objects.len(), 1);
        assert!(audit.blocked_objects[0].starts_with(&format!(
            "registry://soul/{}/incarnation/{}?",
            prepared.soul_id, prepared.incarnation_id
        )));
    }
}
