//! Durable managed-view intent helpers.
//!
//! A managed soul is process ownership. A view intent is the durable request
//! that at least one browser representation remain discoverable. Automatic
//! placement IDs are derived from installation/workspace/soul identity only;
//! server boots and incarnation replacements therefore cannot mint duplicates.

use crate::registry::{load_inventory, Registry, RegistryError};
use freshell_runtime_protocol::{
    InitialScanState, InstallationId, ProjectionEventId, RuntimeInventorySnapshot, RuntimeLimits,
    RuntimeReadiness, SoulId, UpsertViewIntentRequest, ViewIntent, ViewIntentId, ViewIntentKind,
    ViewIntentRequest, ViewProjectionEvent, ViewVisibilityIntent,
};
use rusqlite::{params, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const RECOVERED_AGENTS_GROUP: &str = "Recovered agents";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomaticPlacement {
    pub view_id: ViewIntentId,
    pub tab_id: String,
    pub pane_id: String,
}

pub fn automatic_placement(
    installation_id: &InstallationId,
    workspace_id: &str,
    soul_id: &SoulId,
) -> AutomaticPlacement {
    automatic_placement_for_owner(installation_id.as_str(), workspace_id, soul_id)
}

fn automatic_placement_for_owner(
    owner_id: &str,
    workspace_id: &str,
    soul_id: &SoulId,
) -> AutomaticPlacement {
    let key = format!("{owner_id}\0{workspace_id}\0{}", soul_id.as_str());
    AutomaticPlacement {
        view_id: ViewIntentId::parse(format!("view-auto-{}", stable_hex(&key, b"view")))
            .expect("deterministic managed view id is bounded"),
        tab_id: format!("managed-tab-{}", stable_hex(&key, b"tab")),
        pane_id: format!("managed-pane-{}", stable_hex(&key, b"pane")),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn automatic_primary_intent(
    installation_id: &InstallationId,
    soul_id: SoulId,
    workspace_id: String,
    provider: &str,
    title_hint: Option<&str>,
    soul_intent_revision: u64,
    now: i64,
) -> ViewIntent {
    let request = ViewIntentRequest {
        title: title_hint.map(str::to_string),
        ..ViewIntentRequest::default()
    };
    automatic_primary_intent_from_request(
        installation_id,
        soul_id,
        workspace_id,
        provider,
        Some(&request),
        soul_intent_revision,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn automatic_primary_intent_from_request(
    installation_id: &InstallationId,
    soul_id: SoulId,
    fallback_workspace_id: String,
    provider: &str,
    request: Option<&ViewIntentRequest>,
    soul_intent_revision: u64,
    now: i64,
) -> ViewIntent {
    let owner_id = request
        .map(|value| value.owner_id.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(installation_id.as_str())
        .to_string();
    let workspace_id = request
        .map(|value| value.workspace_id.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_workspace_id.as_str())
        .to_string();
    let placement = automatic_placement_for_owner(&owner_id, &workspace_id, &soul_id);
    let preferred_tab_id = request
        .and_then(|value| nonempty(value.preferred_tab_id.as_deref()))
        .unwrap_or(placement.tab_id.as_str())
        .to_string();
    let preferred_pane_id = request
        .and_then(|value| nonempty(value.preferred_pane_id.as_deref()))
        .unwrap_or(placement.pane_id.as_str())
        .to_string();
    let title = request
        .and_then(|value| nonempty(value.title.as_deref()))
        .map(str::to_string)
        .unwrap_or_else(|| format!("Recovered {} agent", provider_label(provider)));
    let placement_group = request
        .and_then(|value| nonempty(value.placement_group.as_deref()))
        .unwrap_or(RECOVERED_AGENTS_GROUP)
        .to_string();
    ViewIntent {
        view_id: placement.view_id,
        soul_id,
        owner_id,
        workspace_id,
        kind: ViewIntentKind::AutomaticPrimary,
        preferred_tab_id,
        preferred_pane_id,
        title,
        placement_group,
        visibility: ViewVisibilityIntent::Visible,
        revision: 1,
        soul_intent_revision,
        created_at: now,
        updated_at: now,
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub fn projection_event_id(view_id: &ViewIntentId, revision: u64) -> ProjectionEventId {
    ProjectionEventId::parse(format!("projection-{}-{revision}", view_id.as_str()))
        .expect("view projection event id is bounded")
}

fn stable_hex(key: &str, domain: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-managed-view-v1\0");
    hasher.update(domain);
    hasher.update(b"\0");
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "amplifier" => "Amplifier",
        other => other,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn ensure_automatic_primary_in_tx(
    tx: &Transaction<'_>,
    installation_id: &InstallationId,
    soul_id: &SoulId,
    workspace_id: &str,
    provider: &str,
    soul_intent_revision: u64,
    request: Option<&ViewIntentRequest>,
    now: i64,
) -> Result<ViewIntent, RegistryError> {
    if let Some(existing) = load_automatic_primary(tx, soul_id)? {
        return Ok(existing);
    }
    let intent = automatic_primary_intent_from_request(
        installation_id,
        soul_id.clone(),
        workspace_id.to_string(),
        provider,
        request,
        soul_intent_revision,
        now,
    );
    tx.execute(
        "INSERT INTO view_intents (view_id,soul_id,owner_id,workspace_id,kind,preferred_tab_id,preferred_pane_id,title,placement_group,visibility,revision,soul_intent_revision,created_at,updated_at) VALUES (?1,?2,?3,?4,'automatic_primary',?5,?6,?7,?8,'visible',1,?9,?10,?10)",
        params![
            intent.view_id.as_str(),
            intent.soul_id.as_str(),
            intent.owner_id,
            intent.workspace_id,
            intent.preferred_tab_id,
            intent.preferred_pane_id,
            intent.title,
            intent.placement_group,
            intent.soul_intent_revision,
            now,
        ],
    )?;
    enqueue_projection(tx, &intent)?;
    Ok(intent)
}

pub(crate) fn backfill_automatic_view_intents(
    conn: &mut rusqlite::Connection,
    installation_id: &InstallationId,
) -> Result<(), RegistryError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut statement = tx.prepare(
        "SELECT s.soul_id,s.project_key,s.provider,s.intent_revision,s.desired_state FROM souls s WHERE EXISTS (SELECT 1 FROM incarnations i WHERE i.soul_id=s.soul_id AND i.terminal_spec IS NOT NULL) ORDER BY s.created_at,s.soul_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    drop(statement);
    let now = now_millis();
    for (soul, workspace, provider, revision, desired) in values {
        let soul =
            SoulId::parse(soul).map_err(|_| RegistryError::Integrity("invalid soul id".into()))?;
        ensure_automatic_primary_in_tx(
            &tx,
            installation_id,
            &soul,
            &workspace,
            &provider,
            revision,
            None,
            now,
        )?;
        if desired == "stopped" {
            hide_automatic_primary_in_tx(&tx, &soul, revision, now)?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn hide_automatic_primary_in_tx(
    tx: &Transaction<'_>,
    soul_id: &SoulId,
    soul_intent_revision: u64,
    now: i64,
) -> Result<(), RegistryError> {
    let Some(current) = load_automatic_primary(tx, soul_id)? else {
        return Ok(());
    };
    if current.visibility == ViewVisibilityIntent::Hidden
        && current.soul_intent_revision == soul_intent_revision
    {
        return Ok(());
    }
    let next_revision = current
        .revision
        .checked_add(1)
        .ok_or_else(|| RegistryError::Integrity("view intent revision overflow".into()))?;
    tx.execute(
        "UPDATE view_intents SET visibility='hidden',revision=?1,soul_intent_revision=?2,updated_at=?3 WHERE view_id=?4 AND revision=?5",
        params![
            next_revision,
            soul_intent_revision,
            now,
            current.view_id.as_str(),
            current.revision,
        ],
    )?;
    let updated = load_view_intent(tx, &current.view_id)?
        .ok_or_else(|| RegistryError::Integrity("updated view intent disappeared".into()))?;
    enqueue_projection(tx, &updated)
}

pub(crate) fn make_automatic_primary_visible_in_tx(
    tx: &Transaction<'_>,
    soul_id: &SoulId,
    soul_intent_revision: u64,
    now: i64,
) -> Result<(), RegistryError> {
    let Some(current) = load_automatic_primary(tx, soul_id)? else {
        return Ok(());
    };
    if current.visibility == ViewVisibilityIntent::Visible
        && current.soul_intent_revision == soul_intent_revision
    {
        return Ok(());
    }
    let next_revision = current
        .revision
        .checked_add(1)
        .ok_or_else(|| RegistryError::Integrity("view intent revision overflow".into()))?;
    tx.execute(
        "UPDATE view_intents SET visibility='visible',revision=?1,soul_intent_revision=?2,updated_at=?3 WHERE view_id=?4 AND revision=?5",
        params![
            next_revision,
            soul_intent_revision,
            now,
            current.view_id.as_str(),
            current.revision,
        ],
    )?;
    let updated = load_view_intent(tx, &current.view_id)?
        .ok_or_else(|| RegistryError::Integrity("updated view intent disappeared".into()))?;
    enqueue_projection(tx, &updated)
}

pub(crate) fn enqueue_projection(
    tx: &Transaction<'_>,
    intent: &ViewIntent,
) -> Result<(), RegistryError> {
    let inventory_revision = tx.query_row(
        "SELECT inventory_revision FROM installation WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let event = ViewProjectionEvent {
        event_id: projection_event_id(&intent.view_id, intent.revision),
        event_kind: "view_intent.changed".into(),
        view_intent: intent.clone(),
        soul_intent_revision: intent.soul_intent_revision,
        inventory_revision,
        created_at: intent.updated_at,
    };
    tx.execute(
        "INSERT OR IGNORE INTO outbox (event_id,event_kind,payload,created_at,delivered_at) VALUES (?1,?2,?3,?4,NULL)",
        params![
            event.event_id.as_str(),
            event.event_kind,
            serde_json::to_string(&event)?,
            event.created_at,
        ],
    )?;
    Ok(())
}

fn load_automatic_primary(
    tx: &Transaction<'_>,
    soul_id: &SoulId,
) -> Result<Option<ViewIntent>, RegistryError> {
    let id: Option<String> = tx
        .query_row(
            "SELECT view_id FROM view_intents WHERE soul_id=?1 AND kind='automatic_primary' LIMIT 1",
            params![soul_id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    id.map(ViewIntentId::parse)
        .transpose()
        .map_err(|_| RegistryError::Integrity("invalid view intent id".into()))?
        .map(|id| load_view_intent(tx, &id))
        .transpose()
        .map(|value| value.flatten())
}

pub(crate) fn load_view_intent(
    conn: &rusqlite::Connection,
    view_id: &ViewIntentId,
) -> Result<Option<ViewIntent>, RegistryError> {
    conn.query_row(
        "SELECT view_id,soul_id,owner_id,workspace_id,kind,preferred_tab_id,preferred_pane_id,title,placement_group,visibility,revision,soul_intent_revision,created_at,updated_at FROM view_intents WHERE view_id=?1",
        params![view_id.as_str()],
        parse_view_row,
    )
    .optional()
    .map_err(RegistryError::from)
}

pub(crate) fn load_view_intents(
    conn: &rusqlite::Connection,
) -> Result<Vec<ViewIntent>, RegistryError> {
    let mut statement = conn.prepare(
        "SELECT view_id,soul_id,owner_id,workspace_id,kind,preferred_tab_id,preferred_pane_id,title,placement_group,visibility,revision,soul_intent_revision,created_at,updated_at FROM view_intents ORDER BY created_at,view_id",
    )?;
    let rows = statement.query_map([], parse_view_row)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(RegistryError::from)
}

fn parse_view_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ViewIntent> {
    let view_id: String = row.get(0)?;
    let soul_id: String = row.get(1)?;
    let kind: String = row.get(4)?;
    let visibility: String = row.get(9)?;
    Ok(ViewIntent {
        view_id: ViewIntentId::parse(view_id).map_err(|_| conversion_error("view_id"))?,
        soul_id: SoulId::parse(soul_id).map_err(|_| conversion_error("soul_id"))?,
        owner_id: row.get(2)?,
        workspace_id: row.get(3)?,
        kind: match kind.as_str() {
            "automatic_primary" => ViewIntentKind::AutomaticPrimary,
            "explicit" => ViewIntentKind::Explicit,
            _ => return Err(conversion_error("view kind")),
        },
        preferred_tab_id: row.get(5)?,
        preferred_pane_id: row.get(6)?,
        title: row.get(7)?,
        placement_group: row.get(8)?,
        visibility: match visibility.as_str() {
            "visible" => ViewVisibilityIntent::Visible,
            "detached" => ViewVisibilityIntent::Detached,
            "hidden" => ViewVisibilityIntent::Hidden,
            _ => return Err(conversion_error("view visibility")),
        },
        revision: row.get(10)?,
        soul_intent_revision: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn conversion_error(field: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("invalid {field}").into(),
    )
}

impl Registry {
    pub async fn inventory_snapshot(&self) -> Result<RuntimeInventorySnapshot, RegistryError> {
        self.run_blocking(move |conn| {
            let (revision, scan_state, started, finished, error_json): (
                u64,
                String,
                Option<i64>,
                Option<i64>,
                Option<String>,
            ) = conn.query_row(
                "SELECT inventory_revision,initial_scan_state,initial_scan_started_at,initial_scan_finished_at,initial_scan_error FROM installation WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )?;
            let readiness = RuntimeReadiness {
                inventory_revision: revision,
                initial_scan_state: parse_scan_state(&scan_state)?,
                initial_scan_started_at: started,
                initial_scan_finished_at: finished,
                blocked_subsystems: error_json
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default(),
                startup_recovery_concurrency_limit:
                    crate::inventory::startup_concurrency_limit() as u32,
                startup_recovery_peak: conn
                    .query_row(
                        "SELECT initial_scan_peak_concurrency FROM installation WHERE singleton=1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0),
                initial_scan_duration_ms: started.zip(finished).map(|(start, finish)| {
                    finish.saturating_sub(start).max(0) as u64
                }),
            };
            let mut latest = BTreeMap::new();
            for view in load_inventory(&conn)? {
                latest.insert(view.soul_id.clone(), view);
            }
            let pending_projection_count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM outbox WHERE event_kind='view_intent.changed' AND delivered_at IS NULL",
                [],
                |row| row.get(0),
            )?;
            Ok(RuntimeInventorySnapshot {
                revision,
                readiness,
                souls: latest.into_values().collect(),
                view_intents: load_view_intents(&conn)?,
                pending_projection_count,
            })
        })
        .await
    }

    pub async fn pending_view_projections(
        &self,
        limit: u32,
    ) -> Result<Vec<ViewProjectionEvent>, RegistryError> {
        let limit = limit.clamp(1, 500);
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT payload FROM outbox WHERE event_kind='view_intent.changed' AND delivered_at IS NULL ORDER BY created_at,event_id LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit], |row| row.get::<_, String>(0))?;
            let mut events = Vec::new();
            for row in rows {
                events.push(serde_json::from_str::<ViewProjectionEvent>(&row?)?);
            }
            Ok(events)
        })
        .await
    }

    pub async fn acknowledge_view_projection(
        &self,
        event_id: ProjectionEventId,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE event_id=?1 AND event_kind='view_intent.changed')",
                params![event_id.as_str()],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(RegistryError::InvalidState(format!(
                    "unknown view projection event {event_id}"
                )));
            }
            tx.execute(
                "UPDATE outbox SET delivered_at=COALESCE(delivered_at,?1) WHERE event_id=?2",
                params![now_millis(), event_id.as_str()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn update_view_visibility(
        &self,
        view_id: ViewIntentId,
        visibility: ViewVisibilityIntent,
        expected_revision: u64,
        expected_soul_intent_revision: u64,
    ) -> Result<ViewIntent, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let current = load_view_intent(&tx, &view_id)?
                .ok_or_else(|| RegistryError::InvalidState(format!("unknown view intent {view_id}")))?;
            let (desired, soul_revision): (String, u64) = tx.query_row(
                "SELECT desired_state,intent_revision FROM souls WHERE soul_id=?1",
                params![current.soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if current.revision != expected_revision {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_revision,
                    current: current.revision,
                });
            }
            if soul_revision != expected_soul_intent_revision {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_soul_intent_revision,
                    current: soul_revision,
                });
            }
            if desired == "running" && visibility == ViewVisibilityIntent::Hidden {
                return Err(RegistryError::InvalidState(
                    "hide cannot stop a running soul; use the stop operation".into(),
                ));
            }
            let next = current
                .revision
                .checked_add(1)
                .ok_or_else(|| RegistryError::Integrity("view revision overflow".into()))?;
            tx.execute(
                "UPDATE view_intents SET visibility=?1,revision=?2,updated_at=?3 WHERE view_id=?4 AND revision=?5",
                params![visibility_name(visibility), next, now_millis(), view_id.as_str(), expected_revision],
            )?;
            let updated = load_view_intent(&tx, &view_id)?
                .ok_or_else(|| RegistryError::Integrity("view intent disappeared".into()))?;
            enqueue_projection(&tx, &updated)?;
            tx.commit()?;
            Ok(updated)
        })
        .await
    }

    pub async fn upsert_view_intent(
        &self,
        request: UpsertViewIntentRequest,
    ) -> Result<ViewIntent, RegistryError> {
        let installation_id = self.installation_id().clone();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let (provider, workspace, soul_revision): (String, String, u64) = tx
                .query_row(
                    "SELECT provider,project_key,intent_revision FROM souls WHERE soul_id=?1",
                    params![request.soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(request.soul_id.clone()))?;
            if soul_revision != request.expected_soul_intent_revision {
                return Err(RegistryError::StaleIntentRevision {
                    expected: request.expected_soul_intent_revision,
                    current: soul_revision,
                });
            }
            let owner = nonempty(Some(request.intent.owner_id.as_str()))
                .unwrap_or(installation_id.as_str())
                .to_string();
            let workspace = nonempty(Some(request.intent.workspace_id.as_str()))
                .unwrap_or(workspace.as_str())
                .to_string();
            let fallback = automatic_placement_for_owner(&owner, &workspace, &request.soul_id);
            let view_id = request.view_id.clone().unwrap_or_else(|| match request.intent.kind {
                ViewIntentKind::AutomaticPrimary => fallback.view_id.clone(),
                ViewIntentKind::Explicit => {
                    let key = format!(
                        "{}\0{}\0{}\0{}\0{}",
                        owner,
                        workspace,
                        request.soul_id,
                        request.intent.preferred_tab_id.as_deref().unwrap_or_default(),
                        request.intent.preferred_pane_id.as_deref().unwrap_or_default()
                    );
                    ViewIntentId::parse(format!("view-explicit-{}", stable_hex(&key, b"explicit")))
                        .expect("deterministic explicit view id is bounded")
                }
            });
            let current = load_view_intent(&tx, &view_id)?;
            let now = now_millis();
            let revision = match (&current, request.expected_revision) {
                (None, None | Some(0)) => 1,
                (None, Some(expected)) => {
                    return Err(RegistryError::StaleIntentRevision { expected, current: 0 })
                }
                (Some(current), Some(expected)) if current.revision == expected => current
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| RegistryError::Integrity("view revision overflow".into()))?,
                (Some(current), Some(expected)) => {
                    return Err(RegistryError::StaleIntentRevision {
                        expected,
                        current: current.revision,
                    })
                }
                (Some(current), None) => {
                    return Err(RegistryError::StaleIntentRevision {
                        expected: 0,
                        current: current.revision,
                    })
                }
            };
            let intent = ViewIntent {
                view_id: view_id.clone(),
                soul_id: request.soul_id.clone(),
                owner_id: owner,
                workspace_id: workspace,
                kind: request.intent.kind,
                preferred_tab_id: request
                    .intent
                    .preferred_tab_id
                    .as_deref()
                    .and_then(|value| nonempty(Some(value)))
                    .unwrap_or(fallback.tab_id.as_str())
                    .to_string(),
                preferred_pane_id: request
                    .intent
                    .preferred_pane_id
                    .as_deref()
                    .and_then(|value| nonempty(Some(value)))
                    .unwrap_or(fallback.pane_id.as_str())
                    .to_string(),
                title: request
                    .intent
                    .title
                    .as_deref()
                    .and_then(|value| nonempty(Some(value)))
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Recovered {} agent", provider_label(&provider))),
                placement_group: request
                    .intent
                    .placement_group
                    .as_deref()
                    .and_then(|value| nonempty(Some(value)))
                    .unwrap_or(RECOVERED_AGENTS_GROUP)
                    .to_string(),
                visibility: request.intent.visibility,
                revision,
                soul_intent_revision: soul_revision,
                created_at: current.as_ref().map(|value| value.created_at).unwrap_or(now),
                updated_at: now,
            };
            if current.is_some() {
                tx.execute(
                    "UPDATE view_intents SET owner_id=?1,workspace_id=?2,kind=?3,preferred_tab_id=?4,preferred_pane_id=?5,title=?6,placement_group=?7,visibility=?8,revision=?9,soul_intent_revision=?10,updated_at=?11 WHERE view_id=?12",
                    params![intent.owner_id,intent.workspace_id,kind_name(intent.kind),intent.preferred_tab_id,intent.preferred_pane_id,intent.title,intent.placement_group,visibility_name(intent.visibility),intent.revision,intent.soul_intent_revision,intent.updated_at,intent.view_id.as_str()],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO view_intents (view_id,soul_id,owner_id,workspace_id,kind,preferred_tab_id,preferred_pane_id,title,placement_group,visibility,revision,soul_intent_revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    params![intent.view_id.as_str(),intent.soul_id.as_str(),intent.owner_id,intent.workspace_id,kind_name(intent.kind),intent.preferred_tab_id,intent.preferred_pane_id,intent.title,intent.placement_group,visibility_name(intent.visibility),intent.revision,intent.soul_intent_revision,intent.created_at,intent.updated_at],
                )?;
            }
            let intent = load_view_intent(&tx, &view_id)?
                .ok_or_else(|| RegistryError::Integrity("view intent disappeared".into()))?;
            enqueue_projection(&tx, &intent)?;
            tx.commit()?;
            Ok(intent)
        })
        .await
    }

    pub async fn update_configured_limits(
        &self,
        soul_id: SoulId,
        limits: RuntimeLimits,
        expected_intent_revision: u64,
    ) -> Result<freshell_runtime_protocol::RuntimeView, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let (current_revision, current_limits): (u64, Option<String>) = tx
                .query_row(
                    "SELECT intent_revision,configured_limits FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id.clone()))?;
            if current_revision != expected_intent_revision {
                return Err(RegistryError::StaleIntentRevision {
                    expected: expected_intent_revision,
                    current: current_revision,
                });
            }
            let encoded = serde_json::to_string(&limits)?;
            if current_limits.as_deref() != Some(encoded.as_str()) {
                let next_revision = current_revision
                    .checked_add(1)
                    .ok_or_else(|| RegistryError::Integrity("intent revision overflow".into()))?;
                let now = now_millis();
                tx.execute(
                    "UPDATE souls SET configured_limits=?1,resource_profile='custom',intent_revision=?2,updated_at=?3 WHERE soul_id=?4 AND intent_revision=?5",
                    params![encoded, next_revision, now, soul_id.as_str(), current_revision],
                )?;
                let mut statement = tx.prepare(
                    "SELECT view_id FROM view_intents WHERE soul_id=?1 ORDER BY view_id",
                )?;
                let rows = statement.query_map(params![soul_id.as_str()], |row| row.get::<_, String>(0))?;
                let ids = rows.collect::<Result<Vec<_>, _>>()?;
                drop(statement);
                for raw in ids {
                    let view_id = ViewIntentId::parse(raw)
                        .map_err(|_| RegistryError::Integrity("invalid view id".into()))?;
                    let current = load_view_intent(&tx, &view_id)?
                        .ok_or_else(|| RegistryError::Integrity("view disappeared".into()))?;
                    let revision = current
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| RegistryError::Integrity("view revision overflow".into()))?;
                    tx.execute(
                        "UPDATE view_intents SET revision=?1,soul_intent_revision=?2,updated_at=?3 WHERE view_id=?4 AND revision=?5",
                        params![revision, next_revision, now, view_id.as_str(), current.revision],
                    )?;
                    let updated = load_view_intent(&tx, &view_id)?
                        .ok_or_else(|| RegistryError::Integrity("updated view disappeared".into()))?;
                    enqueue_projection(&tx, &updated)?;
                }
            }
            tx.commit()?;
            load_inventory(&conn)?
                .into_iter()
                .rev()
                .find(|view| view.soul_id == soul_id)
                .ok_or(RegistryError::UnknownSoul(soul_id))
        })
        .await
    }

    pub async fn mark_startup_scan_started(&self) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE installation SET initial_scan_state='scanning',initial_scan_started_at=?1,initial_scan_finished_at=NULL,initial_scan_error=NULL,initial_scan_peak_concurrency=0,inventory_revision=inventory_revision+1 WHERE singleton=1",
                params![now_millis()],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn note_startup_scan_concurrency(&self, observed: u32) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE installation SET initial_scan_peak_concurrency=MAX(initial_scan_peak_concurrency,?1) WHERE singleton=1",
                params![observed],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn mark_startup_scan_finished(
        &self,
        blocked_subsystems: Vec<String>,
    ) -> Result<(), RegistryError> {
        self.run_blocking(move |conn| {
            let state = if blocked_subsystems.is_empty() {
                "complete"
            } else {
                "blocked"
            };
            let errors = (!blocked_subsystems.is_empty())
                .then(|| serde_json::to_string(&blocked_subsystems))
                .transpose()?;
            conn.execute(
                "UPDATE installation SET initial_scan_state=?1,initial_scan_finished_at=?2,initial_scan_error=?3,inventory_revision=inventory_revision+1 WHERE singleton=1",
                params![state, now_millis(), errors],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn desired_running_soul_ids(&self) -> Result<Vec<SoulId>, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT DISTINCT s.soul_id FROM souls s JOIN incarnations i ON i.soul_id=s.soul_id WHERE s.desired_state='running' AND i.terminal_spec IS NOT NULL ORDER BY s.created_at,s.soul_id",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            let mut ids = Vec::new();
            for row in rows {
                ids.push(
                    SoulId::parse(row?)
                        .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?,
                );
            }
            Ok(ids)
        })
        .await
    }

    pub async fn make_desired_running_views_visible(&self) -> Result<(), RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut statement = tx.prepare(
                "SELECT soul_id,intent_revision FROM souls WHERE desired_state='running' ORDER BY soul_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?;
            let mut values = Vec::new();
            for row in rows {
                values.push(row?);
            }
            drop(statement);
            let now = now_millis();
            for (soul, revision) in values {
                let soul = SoulId::parse(soul)
                    .map_err(|_| RegistryError::Integrity("invalid soul id".into()))?;
                make_automatic_primary_visible_in_tx(&tx, &soul, revision, now)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn assert_soul_intent_revision(
        &self,
        soul_id: SoulId,
        expected: Option<u64>,
    ) -> Result<(), RegistryError> {
        let Some(expected) = expected else {
            return Ok(());
        };
        self.run_blocking(move |conn| {
            let current: u64 = conn
                .query_row(
                    "SELECT intent_revision FROM souls WHERE soul_id=?1",
                    params![soul_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| RegistryError::UnknownSoul(soul_id))?;
            if current != expected {
                return Err(RegistryError::StaleIntentRevision { expected, current });
            }
            Ok(())
        })
        .await
    }
}

fn parse_scan_state(value: &str) -> Result<InitialScanState, RegistryError> {
    match value {
        "pending" => Ok(InitialScanState::Pending),
        "scanning" => Ok(InitialScanState::Scanning),
        "complete" => Ok(InitialScanState::Complete),
        "blocked" => Ok(InitialScanState::Blocked),
        other => Err(RegistryError::Integrity(format!(
            "unknown startup scan state {other}"
        ))),
    }
}

fn kind_name(value: ViewIntentKind) -> &'static str {
    match value {
        ViewIntentKind::AutomaticPrimary => "automatic_primary",
        ViewIntentKind::Explicit => "explicit",
    }
}

fn visibility_name(value: ViewVisibilityIntent) -> &'static str {
    match value {
        ViewVisibilityIntent::Visible => "visible",
        ViewVisibilityIntent::Detached => "detached",
        ViewVisibilityIntent::Hidden => "hidden",
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_placement_is_boot_and_incarnation_independent() {
        let installation = InstallationId::parse("installation-one").unwrap();
        let soul = SoulId::parse("soul-one").unwrap();
        let first = automatic_placement(&installation, "workspace-one", &soul);
        let second = automatic_placement(&installation, "workspace-one", &soul);
        assert_eq!(first, second);
        assert_ne!(
            first,
            automatic_placement(&installation, "workspace-two", &soul)
        );
        assert!(first.tab_id.starts_with("managed-tab-"));
        assert!(first.pane_id.starts_with("managed-pane-"));
    }

    #[test]
    fn primary_intent_is_visible_and_grouped_without_focus_or_boot_state() {
        let installation = InstallationId::parse("installation-one").unwrap();
        let intent = automatic_primary_intent(
            &installation,
            SoulId::parse("soul-one").unwrap(),
            "workspace-one".into(),
            "opencode",
            None,
            4,
            10,
        );
        assert_eq!(intent.visibility, ViewVisibilityIntent::Visible);
        assert_eq!(intent.kind, ViewIntentKind::AutomaticPrimary);
        assert_eq!(intent.placement_group, RECOVERED_AGENTS_GROUP);
        assert_eq!(intent.title, "Recovered OpenCode agent");
        assert_eq!(
            projection_event_id(&intent.view_id, 1),
            projection_event_id(&intent.view_id, 1)
        );
    }
}
