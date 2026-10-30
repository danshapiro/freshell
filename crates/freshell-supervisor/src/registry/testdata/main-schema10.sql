-- Creation SQL from Freshell main dc666e73fa7e30b6e2d51fbba3865dcb1f15d58d (schema 10).
-- Source: registry.rs::create_schema and registry/input_reservation.rs::create_table.
-- ACTIVE_STATES is expanded to its value in that same commit.
-- Installation/rollout rows and retained state are seeded by the test.

CREATE TABLE installation (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    installation_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    control_epoch INTEGER NOT NULL,
    inventory_revision INTEGER NOT NULL DEFAULT 0,
    initial_scan_state TEXT NOT NULL DEFAULT 'pending',
    initial_scan_error TEXT,
    initial_scan_started_at INTEGER,
    initial_scan_finished_at INTEGER,
    initial_scan_peak_concurrency INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE souls (
    soul_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_store_id TEXT NOT NULL,
    native_session_id TEXT,
    creation_seed_ref TEXT NOT NULL,
    desired_state TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    recovery_state TEXT NOT NULL,
    recovery_reason TEXT,
    recovery_attempt_id TEXT,
    durability_state TEXT NOT NULL,
    allocation_state TEXT NOT NULL,
    resume_spec TEXT,
    checkpoint_revision INTEGER NOT NULL,
    evidence_revision INTEGER NOT NULL,
    recovery_window_started_at INTEGER,
    successful_recoveries_in_window INTEGER NOT NULL,
    project_key TEXT NOT NULL,
    resource_profile TEXT NOT NULL,
    provider_volume_name TEXT NOT NULL,
    configured_limits TEXT,
    loss_incident_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE incarnations (
    incarnation_id TEXT PRIMARY KEY,
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    launch_nonce TEXT NOT NULL UNIQUE,
    docker_daemon_id TEXT,
    container_id TEXT,
    image_ref TEXT,
    runtime_dir TEXT,
    host_binary_path TEXT,
    immutable_config_digest TEXT,
    launch_state TEXT NOT NULL,
    host_boot_id TEXT,
    execution_generation INTEGER NOT NULL,
    grant_id TEXT,
    requested_limits TEXT NOT NULL,
    effective_limits TEXT,
    cleanup_state TEXT NOT NULL,
    fixture_kind TEXT,
    terminal_id TEXT,
    terminal_spec TEXT,
    fresh_agent_spec TEXT,
    prior_incarnation_id TEXT,
    recovery_attempt_id TEXT,
    provider_preparation_pending INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    oom_killed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX incarnation_container_identity ON incarnations(docker_daemon_id, container_id) WHERE container_id IS NOT NULL;
CREATE UNIQUE INDEX one_active_incarnation_per_soul ON incarnations(soul_id) WHERE launch_state IN ('prepared','created','starting','running','stopping');
CREATE TABLE writer_claims (
    claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_store_id TEXT NOT NULL,
    native_session_id TEXT,
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
    intent_revision INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_native_writer ON writer_claims(provider,provider_store_id,native_session_id) WHERE native_session_id IS NOT NULL;
CREATE TABLE commands (
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    protected_payload_ref TEXT,
    state TEXT NOT NULL,
    provider_ack_id TEXT,
    incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
    event_cursor INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(soul_id, request_id)
);
CREATE TABLE input_commands (
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    protected_payload BLOB NOT NULL,
    incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(soul_id, request_id)
);
CREATE TABLE recovery_attempts (
    attempt_id TEXT PRIMARY KEY,
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    prior_incarnation_id TEXT,
    intent_revision INTEGER NOT NULL,
    path TEXT NOT NULL,
    verdict TEXT NOT NULL,
    evidence_ref TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE TABLE view_intents (
    view_id TEXT PRIMARY KEY,
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    preferred_tab_id TEXT NOT NULL,
    preferred_pane_id TEXT NOT NULL,
    title TEXT NOT NULL,
    placement_group TEXT NOT NULL,
    visibility TEXT NOT NULL,
    revision INTEGER NOT NULL,
    soul_intent_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_automatic_primary_view_per_soul ON view_intents(owner_id,workspace_id,soul_id) WHERE kind='automatic_primary';
CREATE TABLE outbox (
    event_id TEXT PRIMARY KEY,
    event_kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);
CREATE TABLE loss_incidents (
    incident_id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    incarnation_id TEXT NOT NULL REFERENCES incarnations(incarnation_id),
    provider TEXT NOT NULL,
    provider_store_id TEXT NOT NULL,
    native_session_ref_hash TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    decision_state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    certificate_json TEXT NOT NULL,
    cleanup_state TEXT NOT NULL,
    cleanup_json TEXT NOT NULL,
    observed_cause TEXT NOT NULL,
    missing_invariant TEXT NOT NULL,
    hypotheses_json TEXT NOT NULL,
    preventive_action TEXT NOT NULL,
    regression_case TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
);
CREATE UNIQUE INDEX one_loss_incident_per_soul_revision ON loss_incidents(soul_id,intent_revision);
CREATE TABLE runtime_notices (
    notice_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    reference TEXT NOT NULL,
    incident_ids_json TEXT NOT NULL,
    superseded_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE notice_receipts (
    notice_id TEXT NOT NULL REFERENCES runtime_notices(notice_id),
    profile_id TEXT NOT NULL,
    state TEXT NOT NULL,
    rendered_at INTEGER,
    acknowledged_at INTEGER,
    dismissed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(notice_id,profile_id)
);
CREATE TABLE runtime_counters (
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    value INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(name,label)
);
CREATE TABLE rollout_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE migration_runs (
    migration_id TEXT PRIMARY KEY,
    current_mode TEXT NOT NULL,
    requested_mode TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    backup_path TEXT,
    applied_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE repair_audits (
    audit_id TEXT PRIMARY KEY,
    audit_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE stop_tombstones (
    soul_id TEXT NOT NULL REFERENCES souls(soul_id),
    intent_revision INTEGER NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(soul_id, intent_revision)
);
CREATE TABLE admission_reservations (
    incarnation_id TEXT PRIMARY KEY REFERENCES incarnations(incarnation_id),
    project_key TEXT NOT NULL,
    cpu_milli INTEGER NOT NULL,
    memory_bytes INTEGER NOT NULL,
    pids_max INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TRIGGER souls_inventory_insert AFTER INSERT ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER souls_inventory_update AFTER UPDATE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER souls_inventory_delete AFTER DELETE ON souls BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER incarnations_inventory_insert AFTER INSERT ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER incarnations_inventory_update AFTER UPDATE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER incarnations_inventory_delete AFTER DELETE ON incarnations BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER view_intents_inventory_insert AFTER INSERT ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER view_intents_inventory_update AFTER UPDATE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;
CREATE TRIGGER view_intents_inventory_delete AFTER DELETE ON view_intents BEGIN UPDATE installation SET inventory_revision=inventory_revision+1 WHERE singleton=1; END;

CREATE TABLE IF NOT EXISTS provider_input_preparations (
        soul_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE,
        creation_seed_ref TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'opencode', image_ref TEXT NOT NULL,
        host_binary_path TEXT NOT NULL, host_binary_sha256 TEXT NOT NULL,
        intent_revision INTEGER NOT NULL CHECK(intent_revision=1),
        observation TEXT, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
        bound_incarnation_id TEXT UNIQUE
    );
