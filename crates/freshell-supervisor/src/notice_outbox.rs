//! Durable runtime notices, per-profile delivery receipts, and bounded metrics.
//!
//! Notice rows are committed in the same SQLite transaction as the incident
//! cleanup result. Delivery is at-least-once: a browser may see the same stable
//! notice id after reconnect, while a profile receipt prevents duplicate UI
//! rendering once acknowledged or dismissed.

use crate::registry::{Registry, RegistryError};
use freshell_runtime_protocol::{
    IncidentId, LossIncidentState, LossIncidentSummary, NoticeDeliveryState, NoticeId, NoticeKind,
    RuntimeCounter, RuntimeMetricsSnapshot, RuntimeNotice,
};
use rusqlite::{params, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

pub(crate) fn increment_counter_in_tx(
    tx: &Transaction<'_>,
    name: &str,
    label: &str,
    amount: u64,
    now: i64,
) -> Result<(), RegistryError> {
    tx.execute(
        "INSERT INTO runtime_counters (name,label,value,updated_at) VALUES (?1,?2,?3,?4) \
         ON CONFLICT(name,label) DO UPDATE SET value=value+excluded.value,updated_at=excluded.updated_at",
        params![name, label, amount, now],
    )?;
    Ok(())
}

pub(crate) fn stable_notice_id(kind: NoticeKind, incidents: &[IncidentId]) -> NoticeId {
    let mut ids = incidents.iter().map(IncidentId::as_str).collect::<Vec<_>>();
    ids.sort_unstable();
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-runtime-notice-v1\0");
    hasher.update(notice_kind_name(kind).as_bytes());
    for id in ids {
        hasher.update(b"\0");
        hasher.update(id.as_bytes());
    }
    NoticeId::parse(format!("notice-{:x}", hasher.finalize()))
        .expect("stable notice id is ASCII and bounded")
}

pub(crate) fn notice_reference(kind: NoticeKind, incidents: &[IncidentId]) -> String {
    let notice = stable_notice_id(kind, incidents);
    notice
        .as_str()
        .trim_start_matches("notice-")
        .chars()
        .take(8)
        .collect::<String>()
        .to_ascii_uppercase()
}

pub(crate) fn enqueue_notice_in_tx(
    tx: &Transaction<'_>,
    kind: NoticeKind,
    incidents: &[IncidentId],
    foreign_objects_touched: u64,
    now: i64,
) -> Result<RuntimeNotice, RegistryError> {
    let notice_id = stable_notice_id(kind, incidents);
    let (message, reference) = notice_copy(kind, incidents);
    let incident_json = serde_json::to_string(incidents)?;
    tx.execute(
        "INSERT OR IGNORE INTO runtime_notices \
         (notice_id,kind,message,reference,incident_ids_json,superseded_by,created_at,updated_at) \
         VALUES (?1,?2,?3,?4,?5,NULL,?6,?6)",
        params![
            notice_id.as_str(),
            notice_kind_name(kind),
            message,
            reference,
            incident_json,
            now
        ],
    )?;
    let payload = serde_json::to_string(&serde_json::json!({
        "noticeId": notice_id,
        "kind": kind,
        "incidentIds": incidents,
        "foreignObjectsTouched": foreign_objects_touched,
    }))?;
    tx.execute(
        "INSERT OR IGNORE INTO outbox (event_id,event_kind,payload,created_at,delivered_at) \
         VALUES (?1,'runtime.notice',?2,?3,NULL)",
        params![format!("projection-{}", notice_id.as_str()), payload, now],
    )?;
    Ok(RuntimeNotice {
        notice_id,
        kind,
        message,
        reference,
        incident_ids: incidents.to_vec(),
        delivery_state: NoticeDeliveryState::Pending,
        created_at: millis_to_timestamp(now),
    })
}

fn notice_copy(kind: NoticeKind, incidents: &[IncidentId]) -> (String, String) {
    let reference = notice_reference(kind, incidents);
    let count = incidents.len().max(1);
    let message = match kind {
        NoticeKind::CleanupSucceeded => format!(
            "Found and cleaned up {count} lost agent {}. Details are in the server logs. Reference: {reference}.",
            if count == 1 { "process" } else { "processes" }
        ),
        NoticeKind::CleanupFailed => format!(
            "Found {count} lost agent {}, but cleanup could not be verified. No unrelated process was touched. Reference: {reference}.",
            if count == 1 { "process" } else { "processes" }
        ),
        NoticeKind::EndedWithoutProcess => format!(
            "{count} managed agent {} ended after every recovery path was exhausted. No process cleanup signal was required. Reference: {reference}.",
            if count == 1 { "session" } else { "sessions" }
        ),
    };
    (message, reference)
}

#[derive(Debug)]
struct NoticeReceiptRow {
    profile_id: String,
    state: NoticeDeliveryState,
    rendered_at: Option<i64>,
    acknowledged_at: Option<i64>,
    dismissed_at: Option<i64>,
    updated_at: i64,
}

#[derive(Debug)]
struct NoticeRow {
    id: NoticeId,
    kind: NoticeKind,
    incidents: Vec<IncidentId>,
    superseded_by: Option<String>,
    created_at: i64,
}

/// Remove false IDs from every affected notice and rebuild deterministic
/// identities. Receipt merging preserves the strongest prior suppression.
pub(crate) fn sanitize_false_incident_notices_in_tx(
    tx: &Transaction<'_>,
    false_incidents: &std::collections::BTreeSet<String>,
    now: i64,
) -> Result<(), RegistryError> {
    let notices = {
        let mut statement = tx.prepare(
            "SELECT notice_id,kind,incident_ids_json,superseded_by,created_at FROM runtime_notices ORDER BY notice_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, kind, incidents, superseded_by, created_at)| {
                Ok(NoticeRow {
                    id: NoticeId::parse(id)
                        .map_err(|_| RegistryError::Integrity("invalid notice id".into()))?,
                    kind: parse_notice_kind(&kind)?,
                    incidents: serde_json::from_str(&incidents)?,
                    superseded_by,
                    created_at,
                })
            })
            .collect::<Result<Vec<_>, RegistryError>>()?
    };
    let affected = notices
        .iter()
        .filter(|notice| {
            notice
                .incidents
                .iter()
                .any(|id| false_incidents.contains(id.as_str()))
        })
        .collect::<Vec<_>>();
    if affected.is_empty() {
        return Ok(());
    }

    let affected_ids = affected
        .iter()
        .map(|notice| notice.id.to_string())
        .collect::<std::collections::BTreeSet<_>>();
    let mut replacements = std::collections::BTreeMap::<String, Option<String>>::new();
    let mut groups =
        std::collections::BTreeMap::<String, (NoticeKind, Vec<IncidentId>, Vec<String>, i64)>::new(
        );
    for notice in &affected {
        let remaining = notice
            .incidents
            .iter()
            .filter(|id| !false_incidents.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if remaining.is_empty() {
            replacements.insert(notice.id.to_string(), None);
        } else {
            let new_id = stable_notice_id(notice.kind, &remaining).to_string();
            replacements.insert(notice.id.to_string(), Some(new_id.clone()));
            groups
                .entry(new_id)
                .and_modify(|(_, _, ids, created)| {
                    ids.push(notice.id.to_string());
                    *created = (*created).min(notice.created_at);
                })
                .or_insert_with(|| {
                    (
                        notice.kind,
                        remaining,
                        vec![notice.id.to_string()],
                        notice.created_at,
                    )
                });
        }
    }

    // Follow complete supersession chains through notices that are removed.
    for notice in &notices {
        let Some(superseded_by) = notice.superseded_by.as_ref() else {
            continue;
        };
        if !affected_ids.contains(superseded_by) {
            continue;
        }
        let destination = resolve_rebuilt_supersession(superseded_by, &replacements, &notices)?;
        tx.execute(
            "UPDATE runtime_notices SET superseded_by=?1,updated_at=?2 WHERE notice_id=?3",
            params![destination, now, notice.id.as_str()],
        )?;
    }

    for (new_id, (kind, incidents, old_ids, created_at)) in &groups {
        let mut source_ids = old_ids.clone();
        if !affected_ids.contains(new_id) {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM runtime_notices WHERE notice_id=?1)",
                params![new_id],
                |row| row.get(0),
            )?;
            if exists {
                source_ids.push(new_id.clone());
            }
        }
        let receipts = {
            let mut statement = tx.prepare(
                "SELECT profile_id,state,rendered_at,acknowledged_at,dismissed_at,updated_at FROM notice_receipts WHERE notice_id=?1",
            )?;
            let mut values = Vec::new();
            for id in &source_ids {
                values.extend(
                    statement
                        .query_map(params![id], |row| {
                            let state: String = row.get(1)?;
                            Ok(NoticeReceiptRow {
                                profile_id: row.get(0)?,
                                state: parse_delivery_state(&state).map_err(|error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        1,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                })?,
                                rendered_at: row.get(2)?,
                                acknowledged_at: row.get(3)?,
                                dismissed_at: row.get(4)?,
                                updated_at: row.get(5)?,
                            })
                        })?
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            values
        };
        let mut merged = std::collections::BTreeMap::<String, NoticeReceiptRow>::new();
        for receipt in receipts {
            let rank = repair_receipt_rank(receipt.state);
            match merged.get_mut(&receipt.profile_id) {
                Some(current) => {
                    current.rendered_at = current.rendered_at.max(receipt.rendered_at);
                    current.acknowledged_at = current.acknowledged_at.max(receipt.acknowledged_at);
                    current.dismissed_at = current.dismissed_at.max(receipt.dismissed_at);
                    if rank > repair_receipt_rank(current.state)
                        || (rank == repair_receipt_rank(current.state)
                            && receipt.updated_at > current.updated_at)
                    {
                        current.state = receipt.state;
                    }
                    current.updated_at = current.updated_at.max(receipt.updated_at);
                }
                None => {
                    merged.insert(receipt.profile_id.clone(), receipt);
                }
            }
        }
        let mut delivered_at: Option<i64> = None;
        for source_id in &source_ids {
            let rows = {
                let mut statement = tx.prepare(
                    "SELECT delivered_at,payload FROM outbox WHERE event_kind='runtime.notice' AND json_extract(payload,'$.noticeId')=?1",
                )?;
                let values = statement
                    .query_map(params![source_id], |row| {
                        Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                values
            };
            for (delivered, payload) in rows {
                let payload: serde_json::Value = serde_json::from_str(&payload)?;
                if payload.get("noticeId").and_then(serde_json::Value::as_str)
                    != Some(source_id.as_str())
                {
                    return Err(RegistryError::Integrity(
                        "runtime.notice projection identity does not match its row".into(),
                    ));
                }
                if let Some(delivered) = delivered {
                    delivered_at = Some(delivered_at.map_or(delivered, |old| old.max(delivered)));
                }
            }
        }
        for old_id in old_ids {
            tx.execute(
                "DELETE FROM notice_receipts WHERE notice_id=?1",
                params![old_id],
            )?;
            tx.execute(
                "DELETE FROM runtime_notices WHERE notice_id=?1",
                params![old_id],
            )?;
            tx.execute(
                "DELETE FROM outbox WHERE event_kind='runtime.notice' AND json_extract(payload,'$.noticeId')=?1",
                params![old_id],
            )?;
        }
        if source_ids.iter().any(|id| id == new_id) {
            // Destination collision already exists; receipts are moved and
            // deterministic notice fields replace any stale message text.
            tx.execute(
                "DELETE FROM notice_receipts WHERE notice_id=?1",
                params![new_id],
            )?;
        }
        let (message, reference) = notice_copy(*kind, incidents);
        let mut superseded_destinations = old_ids
            .iter()
            .filter_map(|id| notices.iter().find(|row| row.id.as_str() == id))
            .filter_map(|row| row.superseded_by.as_deref())
            .map(|id| resolve_rebuilt_supersession(id, &replacements, &notices))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<std::collections::BTreeSet<_>>();
        if !affected_ids.contains(new_id) {
            if let Some(existing) = notices.iter().find(|row| row.id.as_str() == new_id) {
                if let Some(target) = existing.superseded_by.as_deref() {
                    if let Some(target) =
                        resolve_rebuilt_supersession(target, &replacements, &notices)?
                    {
                        superseded_destinations.insert(target);
                    }
                }
            }
        }
        // A collapsed source can resolve its supersession edge back to the
        // rebuilt notice itself. That edge is internal to the collapsed
        // group and must not suppress the surviving notice or conflict with
        // a separate valid successor.
        superseded_destinations.remove(new_id);
        if superseded_destinations.len() > 1 {
            return Err(RegistryError::Integrity(
                "collapsed runtime notices have conflicting supersession targets".into(),
            ));
        }
        let superseded_by = superseded_destinations.into_iter().next();
        tx.execute(
            "INSERT OR REPLACE INTO runtime_notices(notice_id,kind,message,reference,incident_ids_json,superseded_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![new_id, notice_kind_name(*kind), message, reference, serde_json::to_string(incidents)?, superseded_by, created_at, now],
        )?;
        for receipt in merged.values() {
            tx.execute(
                "INSERT INTO notice_receipts(notice_id,profile_id,state,rendered_at,acknowledged_at,dismissed_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![new_id, receipt.profile_id, delivery_state_name(receipt.state), receipt.rendered_at, receipt.acknowledged_at, receipt.dismissed_at, receipt.updated_at],
            )?;
        }
        let payload = serde_json::to_string(&serde_json::json!({
            "noticeId": new_id,
            "kind": kind,
            "incidentIds": incidents,
            "foreignObjectsTouched": 0,
        }))?;
        tx.execute(
            "INSERT OR REPLACE INTO outbox(event_id,event_kind,payload,created_at,delivered_at) VALUES (?1,'runtime.notice',?2,?3,?4)",
            params![format!("projection-{new_id}"), payload, now, delivered_at],
        )?;
    }

    for notice in &affected {
        if replacements
            .get(notice.id.as_str())
            .is_some_and(Option::is_none)
        {
            tx.execute(
                "DELETE FROM notice_receipts WHERE notice_id=?1",
                params![notice.id.as_str()],
            )?;
            tx.execute(
                "DELETE FROM runtime_notices WHERE notice_id=?1",
                params![notice.id.as_str()],
            )?;
            tx.execute(
                "DELETE FROM outbox WHERE event_kind='runtime.notice' AND json_extract(payload,'$.noticeId')=?1",
                params![notice.id.as_str()],
            )?;
        }
    }
    for notice in notices {
        let superseded_by: Option<String> = tx
            .query_row(
                "SELECT superseded_by FROM runtime_notices WHERE notice_id=?1",
                params![notice.id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(old_target) = superseded_by else {
            continue;
        };
        if let Some(Some(new_target)) = replacements.get(&old_target) {
            tx.execute(
                "UPDATE runtime_notices SET superseded_by=?1,updated_at=?2 WHERE notice_id=?3",
                params![new_target, now, notice.id.as_str()],
            )?;
        } else if replacements.contains_key(&old_target) {
            tx.execute(
                "UPDATE runtime_notices SET superseded_by=NULL,updated_at=?1 WHERE notice_id=?2",
                params![now, notice.id.as_str()],
            )?;
        }
    }
    Ok(())
}

fn resolve_rebuilt_supersession(
    initial_id: &str,
    replacements: &std::collections::BTreeMap<String, Option<String>>,
    notices: &[NoticeRow],
) -> Result<Option<String>, RegistryError> {
    let mut current = initial_id.to_string();
    let mut visited = std::collections::BTreeSet::new();
    loop {
        if !visited.insert(current.clone()) {
            return Err(RegistryError::Integrity(
                "runtime notice supersession graph contains a cycle".into(),
            ));
        }
        let Some(replacement) = replacements.get(&current) else {
            return Ok(Some(current));
        };
        if let Some(replacement) = replacement {
            return Ok(Some(replacement.clone()));
        }
        let next = notices
            .iter()
            .find(|notice| notice.id.as_str() == current)
            .and_then(|notice| notice.superseded_by.clone());
        let Some(next) = next else {
            return Ok(None);
        };
        current = next;
    }
}

fn repair_receipt_rank(state: NoticeDeliveryState) -> u8 {
    match state {
        NoticeDeliveryState::Pending => 0,
        NoticeDeliveryState::Rendered => 1,
        NoticeDeliveryState::Acknowledged => 2,
        NoticeDeliveryState::Dismissed => 3,
    }
}

impl Registry {
    pub async fn increment_runtime_counter(
        &self,
        name: &'static str,
        label: String,
        amount: u64,
    ) -> Result<(), RegistryError> {
        validate_counter(name, &label)?;
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            increment_counter_in_tx(&tx, name, &label, amount, crate::registry::now_millis())?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn pending_notices(
        &self,
        profile_id: String,
        limit: u32,
    ) -> Result<Vec<RuntimeNotice>, RegistryError> {
        validate_profile_id(&profile_id)?;
        let limit = i64::from(limit.clamp(1, 100));
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT n.notice_id,n.kind,n.message,n.reference,n.incident_ids_json,n.created_at,COALESCE(r.state,'pending') \
                 FROM runtime_notices n \
                 LEFT JOIN notice_receipts r ON r.notice_id=n.notice_id AND r.profile_id=?1 \
                 WHERE n.superseded_by IS NULL AND (r.state IS NULL OR r.state IN ('pending','rendered')) \
                 ORDER BY n.created_at,n.notice_id LIMIT ?2",
            )?;
            let rows = statement.query_map(params![profile_id, limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?;
            let mut notices = Vec::new();
            for row in rows {
                let (notice_id, kind, message, reference, incidents, created_at, state) = row?;
                notices.push(RuntimeNotice {
                    notice_id: NoticeId::parse(notice_id)
                        .map_err(|_| RegistryError::Integrity("invalid notice id".into()))?,
                    kind: parse_notice_kind(&kind)?,
                    message,
                    reference,
                    incident_ids: serde_json::from_str(&incidents)?,
                    delivery_state: parse_delivery_state(&state)?,
                    created_at: millis_to_timestamp(created_at),
                });
            }
            Ok(notices)
        })
        .await
    }

    pub async fn record_notice_receipt(
        &self,
        notice_id: NoticeId,
        profile_id: String,
        requested: NoticeDeliveryState,
    ) -> Result<(), RegistryError> {
        validate_profile_id(&profile_id)?;
        if requested == NoticeDeliveryState::Pending {
            return Err(RegistryError::InvalidState(
                "a browser receipt cannot move a notice back to pending".into(),
            ));
        }
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM runtime_notices WHERE notice_id=?1)",
                params![notice_id.as_str()],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(RegistryError::NoticeNotFound(notice_id));
            }
            let current = tx
                .query_row(
                    "SELECT state FROM notice_receipts WHERE notice_id=?1 AND profile_id=?2",
                    params![notice_id.as_str(), profile_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(current) = current.as_deref() {
                let current = parse_delivery_state(current)?;
                if current == requested {
                    tx.commit()?;
                    return Ok(());
                }
                if is_terminal_receipt(current) && current != requested {
                    return Err(RegistryError::InvalidState(
                        "acknowledged and dismissed notice receipts are terminal".into(),
                    ));
                }
                if receipt_rank(requested) < receipt_rank(current) {
                    return Err(RegistryError::InvalidState(
                        "notice receipt cannot move backwards".into(),
                    ));
                }
            }
            let now = crate::registry::now_millis();
            let (rendered_at, acknowledged_at, dismissed_at) = match requested {
                NoticeDeliveryState::Pending => (None, None, None),
                NoticeDeliveryState::Rendered => (Some(now), None, None),
                NoticeDeliveryState::Acknowledged => (Some(now), Some(now), None),
                NoticeDeliveryState::Dismissed => (Some(now), None, Some(now)),
            };
            tx.execute(
                "INSERT INTO notice_receipts \
                 (notice_id,profile_id,state,rendered_at,acknowledged_at,dismissed_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7) \
                 ON CONFLICT(notice_id,profile_id) DO UPDATE SET \
                 state=excluded.state,rendered_at=COALESCE(notice_receipts.rendered_at,excluded.rendered_at), \
                 acknowledged_at=COALESCE(notice_receipts.acknowledged_at,excluded.acknowledged_at), \
                 dismissed_at=COALESCE(notice_receipts.dismissed_at,excluded.dismissed_at),updated_at=excluded.updated_at",
                params![
                    notice_id.as_str(),
                    profile_id,
                    delivery_state_name(requested),
                    rendered_at,
                    acknowledged_at,
                    dismissed_at,
                    now
                ],
            )?;
            increment_counter_in_tx(
                &tx,
                "notice_delivery",
                delivery_state_name(requested),
                1,
                now,
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn loss_incident_summary(
        &self,
        incident_id: IncidentId,
    ) -> Result<LossIncidentSummary, RegistryError> {
        self.run_blocking(move |conn| {
            let row = conn
                .query_row(
                    "SELECT correlation_id,soul_id,provider,cleanup_state,reason_code,observed_cause,cleanup_json,created_at,updated_at \
                     FROM loss_incidents WHERE incident_id=?1",
                    params![incident_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| {
                    RegistryError::IncidentNotFound(incident_id.clone())
                })?;
            Ok(LossIncidentSummary {
                incident_id,
                correlation_id: freshell_runtime_protocol::CorrelationId::parse(row.0)
                    .map_err(|_| RegistryError::Integrity("invalid correlation id".into()))?,
                soul_id: freshell_runtime_protocol::SoulId::parse(row.1)
                    .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
                provider: row.2,
                state: parse_incident_state(&row.3)?,
                reason_code: row.4,
                observed_cause: row.5,
                cleanup: serde_json::from_str(&row.6)?,
                created_at: millis_to_timestamp(row.7),
                updated_at: millis_to_timestamp(row.8),
            })
        })
        .await
    }

    pub async fn runtime_metrics_snapshot(&self) -> Result<RuntimeMetricsSnapshot, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement =
                conn.prepare("SELECT name,label,value FROM runtime_counters ORDER BY name,label")?;
            let rows = statement.query_map([], |row| {
                Ok(RuntimeCounter {
                    name: row.get(0)?,
                    label: row.get(1)?,
                    value: row.get(2)?,
                })
            })?;
            Ok(RuntimeMetricsSnapshot {
                counters: rows.collect::<Result<Vec<_>, _>>()?,
            })
        })
        .await
    }

    /// Coalesce cleanup notices created during one controller startup scan.
    /// The original stable rows remain for audit but are superseded from
    /// delivery; the deterministic batch row survives repeated reconciliation.
    pub async fn coalesce_startup_notices(
        &self,
        started_at: i64,
        finished_at: i64,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for kind in [
                NoticeKind::CleanupSucceeded,
                NoticeKind::CleanupFailed,
                NoticeKind::EndedWithoutProcess,
            ] {
                let mut statement = tx.prepare(
                    "SELECT notice_id,incident_ids_json FROM runtime_notices \
                     WHERE kind=?1 AND superseded_by IS NULL AND created_at BETWEEN ?2 AND ?3 \
                     ORDER BY notice_id",
                )?;
                let rows = statement.query_map(
                    params![notice_kind_name(kind), started_at, finished_at],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                let collected = rows.collect::<Result<Vec<_>, _>>()?;
                drop(statement);
                if collected.len() <= 1 {
                    continue;
                }
                let mut incidents = Vec::new();
                for (_, json) in &collected {
                    incidents.extend(serde_json::from_str::<Vec<IncidentId>>(json)?);
                }
                incidents.sort_by(|left, right| left.as_str().cmp(right.as_str()));
                incidents.dedup();
                let batch = enqueue_notice_in_tx(&tx, kind, &incidents, 0, finished_at)?;
                for (notice_id, _) in collected {
                    if notice_id != batch.notice_id.as_str() {
                        tx.execute(
                            "UPDATE runtime_notices SET superseded_by=?1,updated_at=?2 WHERE notice_id=?3",
                            params![batch.notice_id.as_str(), finished_at, notice_id],
                        )?;
                    }
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
}

fn validate_counter(name: &str, label: &str) -> Result<(), RegistryError> {
    const NAMES: &[&str] = &[
        "recovery_outcome",
        "recovery_downtime_bucket",
        "checkpoint_age_bucket",
        "runtime_memory_peak_bucket",
        "runtime_cpu_usage_bucket",
        "cleanup_outcome",
        "notice_delivery",
        "isolation_guard_breach",
        "legacy_fallback_usage",
        "migration_outcome",
        "repair_outcome",
    ];
    if !NAMES.contains(&name)
        || label.trim().is_empty()
        || label.len() > 80
        || label.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(RegistryError::InvalidState(
            "runtime metric name/label is not in the bounded allowlist".into(),
        ));
    }
    Ok(())
}

fn validate_profile_id(profile_id: &str) -> Result<(), RegistryError> {
    if profile_id.trim().is_empty()
        || profile_id.len() > 160
        || profile_id.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(RegistryError::InvalidState(
            "invalid notice profile id".into(),
        ));
    }
    Ok(())
}

fn notice_kind_name(kind: NoticeKind) -> &'static str {
    match kind {
        NoticeKind::CleanupSucceeded => "cleanup_succeeded",
        NoticeKind::CleanupFailed => "cleanup_failed",
        NoticeKind::EndedWithoutProcess => "ended_without_process",
    }
}

fn parse_notice_kind(value: &str) -> Result<NoticeKind, RegistryError> {
    match value {
        "cleanup_succeeded" => Ok(NoticeKind::CleanupSucceeded),
        "cleanup_failed" => Ok(NoticeKind::CleanupFailed),
        "ended_without_process" => Ok(NoticeKind::EndedWithoutProcess),
        other => Err(RegistryError::Integrity(format!(
            "unknown notice kind {other}"
        ))),
    }
}

fn delivery_state_name(state: NoticeDeliveryState) -> &'static str {
    match state {
        NoticeDeliveryState::Pending => "pending",
        NoticeDeliveryState::Rendered => "rendered",
        NoticeDeliveryState::Acknowledged => "acknowledged",
        NoticeDeliveryState::Dismissed => "dismissed",
    }
}

fn parse_delivery_state(value: &str) -> Result<NoticeDeliveryState, RegistryError> {
    match value {
        "pending" => Ok(NoticeDeliveryState::Pending),
        "rendered" => Ok(NoticeDeliveryState::Rendered),
        "acknowledged" => Ok(NoticeDeliveryState::Acknowledged),
        "dismissed" => Ok(NoticeDeliveryState::Dismissed),
        other => Err(RegistryError::Integrity(format!(
            "unknown notice receipt state {other}"
        ))),
    }
}

fn parse_incident_state(value: &str) -> Result<LossIncidentState, RegistryError> {
    match value {
        "cleanup_pending" => Ok(LossIncidentState::CleanupPending),
        "cleanup_failed" => Ok(LossIncidentState::CleanupFailed),
        "closed" => Ok(LossIncidentState::Closed),
        other => Err(RegistryError::Integrity(format!(
            "unknown loss incident state {other}"
        ))),
    }
}

fn is_terminal_receipt(state: NoticeDeliveryState) -> bool {
    matches!(
        state,
        NoticeDeliveryState::Acknowledged | NoticeDeliveryState::Dismissed
    )
}

fn receipt_rank(state: NoticeDeliveryState) -> u8 {
    match state {
        NoticeDeliveryState::Pending => 0,
        NoticeDeliveryState::Rendered => 1,
        NoticeDeliveryState::Acknowledged | NoticeDeliveryState::Dismissed => 2,
    }
}

pub(crate) fn millis_to_timestamp(value: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_notice_identity_is_order_independent() {
        let one = IncidentId::parse("incident-one").unwrap();
        let two = IncidentId::parse("incident-two").unwrap();
        assert_eq!(
            stable_notice_id(NoticeKind::CleanupSucceeded, &[one.clone(), two.clone()]),
            stable_notice_id(NoticeKind::CleanupSucceeded, &[two, one])
        );
    }

    #[test]
    fn bounded_notice_copy_never_contains_native_identity() {
        let incident = IncidentId::parse("incident-copy").unwrap();
        let id = stable_notice_id(
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&incident),
        );
        let reference = notice_reference(NoticeKind::CleanupSucceeded, &[incident]);
        assert!(id.as_str().starts_with("notice-"));
        assert_eq!(reference.len(), 8);
    }

    #[test]
    fn false_incident_notice_rebuild_merges_receipts_and_removes_false_only_rows() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let mut conn =
            crate::registry::open_connection(&registry.registry_root().join("runtime.sqlite3"))
                .unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let false_one = IncidentId::parse("incident-false-one").unwrap();
        let false_two = IncidentId::parse("incident-false-two").unwrap();
        let keep = IncidentId::parse("incident-keep").unwrap();
        let old_one = enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            &[false_one.clone(), keep.clone()],
            0,
            1,
        )
        .unwrap();
        let old_two = enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            &[false_two.clone(), keep.clone()],
            0,
            2,
        )
        .unwrap();
        let target = enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&keep),
            0,
            3,
        )
        .unwrap();
        let false_only = enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupFailed,
            std::slice::from_ref(&false_one),
            0,
            4,
        )
        .unwrap();
        for (notice, profile, state, time) in [
            (&old_one, "one", "rendered", 10),
            (&old_two, "one", "dismissed", 20),
            (&target, "one", "acknowledged", 15),
            (&false_only, "two", "dismissed", 30),
        ] {
            tx.execute(
                "INSERT INTO notice_receipts(notice_id,profile_id,state,rendered_at,acknowledged_at,dismissed_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    notice.notice_id.as_str(),
                    profile,
                    state,
                    Some(time),
                    (state == "acknowledged").then_some(time),
                    (state == "dismissed").then_some(time),
                    time
                ],
            )
            .unwrap();
        }
        tx.execute(
            "UPDATE runtime_notices SET superseded_by=?1 WHERE notice_id=?2",
            params![false_only.notice_id.as_str(), old_one.notice_id.as_str()],
        )
        .unwrap();
        for (notice, delivered_at) in [(&old_one, 11), (&old_two, 40), (&target, 15)] {
            tx.execute(
                "UPDATE outbox SET delivered_at=?1 WHERE event_kind='runtime.notice' AND json_extract(payload,'$.noticeId')=?2",
                params![delivered_at, notice.notice_id.as_str()],
            )
            .unwrap();
        }

        sanitize_false_incident_notices_in_tx(
            &tx,
            &std::collections::BTreeSet::from([false_one.to_string(), false_two.to_string()]),
            100,
        )
        .unwrap();
        tx.commit().unwrap();

        let conn =
            crate::registry::open_connection(&registry.registry_root().join("runtime.sqlite3"))
                .unwrap();
        let notice: (String, String, Option<String>) = conn
            .query_row(
                "SELECT notice_id,incident_ids_json,superseded_by FROM runtime_notices",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(notice.0, target.notice_id.as_str());
        assert_eq!(
            notice.1,
            serde_json::to_string(std::slice::from_ref(&keep)).unwrap()
        );
        assert_eq!(notice.2, None);
        let receipt: (String, Option<i64>) = conn
            .query_row(
                "SELECT state,dismissed_at FROM notice_receipts WHERE notice_id=?1 AND profile_id='one'",
                params![target.notice_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(receipt, ("dismissed".into(), Some(20)));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM notice_receipts WHERE profile_id='two'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
            0
        );
        let projections = {
            let mut statement = conn
                .prepare("SELECT payload FROM outbox WHERE event_kind='runtime.notice'")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect::<Vec<_>>()
        };
        assert_eq!(projections.len(), 1);
        assert!(projections[0].contains(keep.as_str()));
        assert!(!projections[0].contains(false_one.as_str()));
        assert!(!projections[0].contains(false_two.as_str()));
        assert_eq!(
            conn.query_row(
                "SELECT delivered_at FROM outbox WHERE event_kind='runtime.notice' AND json_extract(payload,'$.noticeId')=?1",
                params![target.notice_id.as_str()],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap(),
            Some(40),
            "notice delivery remains terminal after deterministic identity rebuild"
        );
    }

    #[tokio::test]
    async fn withdrawing_false_member_from_coalesced_startup_notice_preserves_real_notice() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let real_incident = IncidentId::parse("incident-real").unwrap();
        let false_incident = IncidentId::parse("incident-false").unwrap();
        let real_notice = stable_notice_id(
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&real_incident),
        );

        let mut conn = crate::registry::open_connection(registry.database_path()).unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&real_incident),
            0,
            100,
        )
        .unwrap();
        enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&false_incident),
            0,
            101,
        )
        .unwrap();
        tx.commit().unwrap();
        drop(conn);

        registry.coalesce_startup_notices(100, 101).await.unwrap();

        let mut conn = crate::registry::open_connection(registry.database_path()).unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        sanitize_false_incident_notices_in_tx(
            &tx,
            &std::collections::BTreeSet::from([false_incident.to_string()]),
            200,
        )
        .unwrap();
        tx.commit().unwrap();

        let superseded_by: Option<String> = conn
            .query_row(
                "SELECT superseded_by FROM runtime_notices WHERE notice_id=?1",
                params![real_notice.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            superseded_by, None,
            "the real notice must not supersede itself"
        );

        let pending = registry
            .pending_notices("fresh-profile".into(), 10)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].notice_id, real_notice);
        assert_eq!(pending[0].incident_ids, vec![real_incident]);
    }

    #[tokio::test]
    async fn collapsed_notice_ignores_self_edge_and_preserves_external_successor() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let real_incident = IncidentId::parse("incident-real-with-successor").unwrap();
        let false_incident = IncidentId::parse("incident-false-with-successor").unwrap();
        let successor_incident = IncidentId::parse("incident-successor").unwrap();
        let real_notice = stable_notice_id(
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&real_incident),
        );
        let batch_notice = stable_notice_id(
            NoticeKind::CleanupSucceeded,
            &[real_incident.clone(), false_incident.clone()],
        );

        let mut conn = crate::registry::open_connection(registry.database_path()).unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&real_incident),
            0,
            100,
        )
        .unwrap();
        enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&false_incident),
            0,
            101,
        )
        .unwrap();
        let external_successor = enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupFailed,
            std::slice::from_ref(&successor_incident),
            0,
            102,
        )
        .unwrap();
        tx.commit().unwrap();
        drop(conn);

        registry.coalesce_startup_notices(100, 101).await.unwrap();

        let mut conn = crate::registry::open_connection(registry.database_path()).unwrap();
        conn.execute(
            "UPDATE runtime_notices SET superseded_by=?1 WHERE notice_id=?2",
            params![external_successor.notice_id.as_str(), batch_notice.as_str()],
        )
        .unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        sanitize_false_incident_notices_in_tx(
            &tx,
            &std::collections::BTreeSet::from([false_incident.to_string()]),
            200,
        )
        .unwrap();
        tx.commit().unwrap();

        let superseded_by: Option<String> = conn
            .query_row(
                "SELECT superseded_by FROM runtime_notices WHERE notice_id=?1",
                params![real_notice.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            superseded_by.as_deref(),
            Some(external_successor.notice_id.as_str())
        );

        let pending = registry
            .pending_notices("fresh-profile".into(), 10)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].notice_id, external_successor.notice_id);
    }

    #[tokio::test]
    async fn duplicate_notice_receipt_is_a_noop_across_restart_including_metrics() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path(), None).unwrap();
        let installation_id = registry.installation_id().clone();
        let incident = IncidentId::parse("incident-idempotent").unwrap();
        let notice_id = stable_notice_id(
            NoticeKind::CleanupSucceeded,
            std::slice::from_ref(&incident),
        );
        let mut conn = crate::registry::open_connection(registry.database_path()).unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        enqueue_notice_in_tx(
            &tx,
            NoticeKind::CleanupSucceeded,
            &[incident],
            0,
            crate::registry::now_millis(),
        )
        .unwrap();
        tx.commit().unwrap();
        drop(conn);

        registry
            .record_notice_receipt(
                notice_id.clone(),
                "profile-idempotent".into(),
                NoticeDeliveryState::Acknowledged,
            )
            .await
            .unwrap();
        drop(registry);
        let registry = Registry::open(dir.path(), Some(installation_id)).unwrap();
        registry
            .record_notice_receipt(
                notice_id.clone(),
                "profile-idempotent".into(),
                NoticeDeliveryState::Acknowledged,
            )
            .await
            .unwrap();
        let metrics = registry.runtime_metrics_snapshot().await.unwrap();
        let count = metrics
            .counters
            .iter()
            .find(|row| row.name == "notice_delivery" && row.label == "acknowledged")
            .map(|row| row.value);
        assert_eq!(count, Some(1));
        assert!(registry
            .pending_notices("profile-idempotent".into(), 20)
            .await
            .unwrap()
            .is_empty());
    }
}
