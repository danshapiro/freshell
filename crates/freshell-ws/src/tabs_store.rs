//! Durable tabs-registry ON-DISK store (PART B, Task 9) — the IO/orchestration
//! slice of `server/tabs-registry/store.ts`: open (load defense-in-depth +
//! corruption recovery), content-addressed object writes, and atomic manifest
//! commits. All pure model logic (caps, hashing, validation, maintenance)
//! lives in [`crate::tabs_store_model`] (Task 8); this file holds only IO.
//!
//! Layout under the store root (`store.ts:668-710`):
//! ```text
//! <root>/v1/manifest.json          # canonical-JSON ManifestV1 (atomic publish)
//! <root>/v1/objects/<sha256>.json  # content-addressed component objects
//! <root>/v1/tmp/                   # in-flight object writes (cleared post-commit)
//! <root>/tabs-registry.jsonl       # legacy log (migration = Task 10)
//! ```

use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::tabs_persist::atomic_write_durable;
use crate::tabs_store_migrate::migrate_legacy_jsonl;
use crate::tabs_store_model::{
    archive_timestamp, build_snapshot_payload_hash, canonical_stringify, client_snapshot_key,
    empty_state, normalize_registry_pane_kinds, sha256_hex_full, validate_registry_record,
    validate_state_caps, ClientOpenSnapshot, ClientRevisionWatermark, CompactState,
    RegistryDeviceEntry, TabsStoreCaps, DEFAULT_CLOSED_RETENTION_DAYS,
    DEFAULT_DEVICE_DISPLAY_TTL_DAYS, DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES,
};

/// Boot-failure taxonomy for [`DurableTabsStore::open`] (store.ts:676-690).
///
/// `Corrupt` = the on-disk compact state is invalid (bad JSON, schema
/// violation, size/hash mismatch, cap violation): the server REFUSES to boot
/// rather than silently discarding user data (Node parity: `open()` throws).
/// `Io` = an operational filesystem error (EACCES etc.): also fails boot, but
/// is NEVER treated as — or archived like — corruption.
#[derive(Debug)]
pub enum TabsStoreOpenError {
    Corrupt(String),
    Io(std::io::Error),
}

impl std::fmt::Display for TabsStoreOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TabsStoreOpenError::Corrupt(message) => {
                write!(f, "tabs registry store is corrupt: {message}")
            }
            TabsStoreOpenError::Io(err) => write!(f, "tabs registry store io error: {err}"),
        }
    }
}

impl std::error::Error for TabsStoreOpenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            TabsStoreOpenError::Io(err) => Some(err),
            TabsStoreOpenError::Corrupt(_) => None,
        }
    }
}

/// `ObjectRef` (store.ts:63-67, schema store.ts:196-209): a content-addressed
/// component object reference. `path` is RELATIVE to `<root>/v1` and always
/// `objects/<sha256>.json` with the embedded digest equal to `sha256`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// `TabsRegistryManifestV1.settings` (store.ts:113-118), ENFORCED on load by
/// the `z.literal`s of store.ts:219-223: `open_snapshot_ttl_minutes` must
/// equal 30 and `device_display_ttl_days` must equal 7;
/// `max_closed_retention_days` must be 1..=30.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSettings {
    pub open_snapshot_ttl_minutes: i64,
    pub device_display_ttl_days: i64,
    pub max_closed_retention_days: i64,
}

/// `TabsRegistryManifestV1` (store.ts:105-118). `version` is the literal 1
/// (store.ts:212), enforced on load. `open_snapshots` is a `BTreeMap` so
/// iteration (object read order) is deterministic — Node reads in manifest
/// insertion order; a sorted order is the crate's established deterministic
/// stand-in for JS map order (Task 8 precedent, ledger A2-R1).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestV1 {
    pub version: i64,
    pub manifest_revision: i64,
    pub committed_at: i64,
    pub open_snapshots: BTreeMap<String, ObjectRef>,
    pub client_revisions: ObjectRef,
    pub closed_tombstones: ObjectRef,
    pub devices: ObjectRef,
    pub settings: ManifestSettings,
}

/// One committed component: the canonical serialization it was written with +
/// its object ref — the reuse cache of `buildManifest` (store.ts:1003-1038).
/// Node's component reuse is object identity + content-addressed dedupe; this
/// canonical-string comparison is observably equivalent (validator-A8-A9).
#[derive(Debug)]
struct CommittedComponent {
    canonical: String,
    object: ObjectRef,
}

/// The last-published manifest's component cache (`manifestObjectRefs`,
/// store.ts:641,646), extended with canonical strings for the reuse compare.
#[derive(Debug)]
struct PrevComponents {
    open_snapshots: HashMap<String, CommittedComponent>,
    client_revisions: CommittedComponent,
    closed_tombstones: CommittedComponent,
    devices: CommittedComponent,
}

/// Internal load-failure taxonomy. `missing_object: true` marks the ONE
/// invalid state that self-heals (a referenced object file is gone — ENOENT),
/// the Rust mirror of Node's `hasErrorCode(error, 'ENOENT')` cause-chain walk
/// (store.ts:681). Everything else invalid fails boot as `Corrupt`.
enum LoadFailure {
    Io(std::io::Error),
    Invalid {
        message: String,
        missing_object: bool,
    },
}

impl LoadFailure {
    fn invalid(message: impl Into<String>) -> Self {
        LoadFailure::Invalid {
            message: message.into(),
            missing_object: false,
        }
    }

    fn missing_object(message: impl Into<String>) -> Self {
        LoadFailure::Invalid {
            message: message.into(),
            missing_object: true,
        }
    }
}

struct LoadedStore {
    state: CompactState,
    manifest_revision: i64,
    prev: PrevComponents,
}

/// The durable tabs-registry store: in-memory [`CompactState`] + the on-disk
/// manifest/objects tree, mutated ONLY through [`DurableTabsStore::commit`].
#[derive(Debug)]
pub struct DurableTabsStore {
    root: PathBuf,
    state: CompactState,
    manifest_revision: i64,
    pub(crate) caps: TabsStoreCaps, // shared with `crate::tabs` push pre-checks (Task 11)
    prev: Option<PrevComponents>,
}

impl DurableTabsStore {
    /// `TabsRegistryStore.open` (store.ts:668-710): ensure `v1/objects` and
    /// `v1/tmp` exist; if `v1/manifest.json` exists, load it (with the ONLY
    /// self-heal: a missing referenced object archives the manifest and falls
    /// through); else if the legacy `tabs-registry.jsonl` exists, migrate it
    /// (commit, THEN archive); else start empty — writing NOTHING until the
    /// first commit.
    pub fn open(root: &Path, caps: TabsStoreCaps, now_ms: i64) -> Result<Self, TabsStoreOpenError> {
        std::fs::create_dir_all(root.join("v1").join("objects")).map_err(TabsStoreOpenError::Io)?;
        std::fs::create_dir_all(root.join("v1").join("tmp")).map_err(TabsStoreOpenError::Io)?;

        let manifest_path = root.join("v1").join("manifest.json");
        if manifest_path.exists() {
            match load_compact_state(root, &caps) {
                Ok(loaded) => {
                    return Ok(Self {
                        root: root.to_path_buf(),
                        state: loaded.state,
                        manifest_revision: loaded.manifest_revision,
                        caps,
                        prev: Some(loaded.prev),
                    });
                }
                Err(LoadFailure::Io(err)) => return Err(TabsStoreOpenError::Io(err)),
                Err(LoadFailure::Invalid {
                    message,
                    missing_object: false,
                }) => return Err(TabsStoreOpenError::Corrupt(message)),
                Err(LoadFailure::Invalid {
                    message,
                    missing_object: true,
                }) => {
                    // The ONLY self-heal (store.ts:676-690): archive the
                    // manifest aside and fall through to legacy/empty.
                    archive_compact_manifest(root, now_ms).map_err(TabsStoreOpenError::Io)?;
                    tracing::warn!(
                        event = "compact_manifest_archived_missing_object",
                        manifest_path = %manifest_path.display(),
                        reason = %message,
                        "tabs registry compact manifest archived: referenced object missing"
                    );
                }
            }
        }

        let legacy_path = root.join("tabs-registry.jsonl");
        if legacy_path.exists() {
            // store.ts:694-700: migrate -> commit (publishes manifestRevision 1)
            // -> archive STRICTLY after publish (crash between = manifest wins).
            let migrated =
                migrate_legacy_jsonl(&legacy_path, now_ms, &caps, DEFAULT_CLOSED_RETENTION_DAYS)
                    .map_err(TabsStoreOpenError::Corrupt)?;
            let mut store = Self {
                root: root.to_path_buf(),
                state: empty_state(now_ms, DEFAULT_CLOSED_RETENTION_DAYS),
                manifest_revision: 0,
                caps,
                prev: None,
            };
            store
                .commit(migrated, now_ms)
                .map_err(|err| match err.kind() {
                    std::io::ErrorKind::InvalidData => TabsStoreOpenError::Corrupt(err.to_string()),
                    _ => TabsStoreOpenError::Io(err),
                })?;
            let archive_path = root.join(format!(
                "tabs-registry.jsonl.migrated-{}",
                archive_timestamp(now_ms)
            ));
            std::fs::rename(&legacy_path, &archive_path).map_err(TabsStoreOpenError::Io)?;
            fsync_dir_best_effort(root);
            return Ok(store);
        }

        Ok(Self {
            root: root.to_path_buf(),
            state: empty_state(now_ms, DEFAULT_CLOSED_RETENTION_DAYS),
            manifest_revision: 0,
            caps,
            prev: None,
        })
    }

    /// The current in-memory compact state (last committed, or the state
    /// loaded/started at open).
    pub fn state(&self) -> &CompactState {
        &self.state
    }

    /// The revision of the last durably-published manifest (0 = nothing
    /// committed yet).
    pub fn manifest_revision(&self) -> i64 {
        self.manifest_revision
    }

    /// `commitState` (store.ts:1062-1083): validate caps → write the four
    /// component objects (reusing the previous ref when the canonical
    /// serialization is unchanged) → publish the manifest atomically →
    /// swap in-memory state ONLY after publish → clear `v1/tmp/` best-effort
    /// (GC never deletes `objects/*` — overlapping-restart safety,
    /// store.test.ts:177).
    pub fn commit(&mut self, next: CompactState, now_ms: i64) -> std::io::Result<()> {
        std::fs::create_dir_all(self.root.join("v1").join("objects"))?;
        std::fs::create_dir_all(self.root.join("v1").join("tmp"))?;
        validate_state_caps(&next, &self.caps).map_err(invalid_data)?;

        let mut open_refs: BTreeMap<String, ObjectRef> = BTreeMap::new();
        let mut prev_open: HashMap<String, CommittedComponent> = HashMap::new();
        for (key, snapshot) in &next.open_snapshots_by_client {
            let value = component_value(snapshot)?;
            let canonical = canonical_stringify(&value);
            let reused = self
                .prev
                .as_ref()
                .and_then(|prev| prev.open_snapshots.get(key))
                .filter(|component| component.canonical == canonical)
                .map(|component| component.object.clone());
            let object = match reused {
                Some(object) => object,
                None => write_object(
                    &self.root,
                    &value,
                    self.caps.max_serialized_client_snapshot_object_bytes,
                )?,
            };
            open_refs.insert(key.clone(), object.clone());
            prev_open.insert(key.clone(), CommittedComponent { canonical, object });
        }
        let client_revisions = self.component_object(
            &next.client_revisions_by_client,
            |prev| &prev.client_revisions,
            self.caps.max_serialized_device_metadata_object_bytes,
        )?;
        let closed_tombstones = self.component_object(
            &next.closed_by_tab_key,
            |prev| &prev.closed_tombstones,
            self.caps.max_serialized_closed_tombstone_object_bytes,
        )?;
        let devices = self.component_object(
            &next.devices_by_id,
            |prev| &prev.devices,
            self.caps.max_serialized_device_metadata_object_bytes,
        )?;

        let manifest = ManifestV1 {
            version: 1,
            manifest_revision: self.manifest_revision + 1,
            committed_at: now_ms,
            open_snapshots: open_refs,
            client_revisions: client_revisions.object.clone(),
            closed_tombstones: closed_tombstones.object.clone(),
            devices: devices.object.clone(),
            settings: ManifestSettings {
                open_snapshot_ttl_minutes: DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES,
                device_display_ttl_days: DEFAULT_DEVICE_DISPLAY_TTL_DAYS,
                max_closed_retention_days: next.max_closed_retention_days,
            },
        };
        let manifest_raw = canonical_stringify(&component_value(&manifest)?);
        atomic_write_durable(
            &self.root.join("v1").join("manifest.json"),
            &self.root.join("v1").join("manifest.json.tmp"),
            manifest_raw.as_bytes(),
        )?;

        // Swap in-memory state ONLY after the manifest is durably published
        // (store.ts:1068-1075) — a failed publish leaves the store serving
        // the previous committed state.
        self.state = next;
        self.manifest_revision = manifest.manifest_revision;
        self.prev = Some(PrevComponents {
            open_snapshots: prev_open,
            client_revisions,
            closed_tombstones,
            devices,
        });
        clear_tmp_best_effort(&self.root);
        Ok(())
    }

    /// Write-or-reuse one fixed component map (`buildManifest`'s
    /// `recordMapHasSameEntries` reuse arms, store.ts:1012-1023).
    fn component_object<T: serde::Serialize>(
        &self,
        component: &T,
        prev_of: impl Fn(&PrevComponents) -> &CommittedComponent,
        max_bytes: usize,
    ) -> std::io::Result<CommittedComponent> {
        let value = component_value(component)?;
        let canonical = canonical_stringify(&value);
        if let Some(prev) = self.prev.as_ref() {
            let prev_component = prev_of(prev);
            if prev_component.canonical == canonical {
                return Ok(CommittedComponent {
                    canonical,
                    object: prev_component.object.clone(),
                });
            }
        }
        let object = write_object(&self.root, &value, max_bytes)?;
        Ok(CommittedComponent { canonical, object })
    }
}

/// `writeObject` (store.ts:970-1001): canonical serialization → byte cap →
/// content digest → dedupe-or-write. A pre-existing `objects/<digest>.json`
/// is re-read and re-verified (byte length + digest; mismatch = corruption
/// error) and reused WITHOUT writing. Otherwise the object is written to
/// `v1/tmp/<digest>.<pid>.<now>.tmp`, fsynced best-effort, renamed into
/// `objects/`, and the objects dir fsynced best-effort. An `EEXIST`-style
/// rename race reuses the existing object and removes the tmp file.
pub(crate) fn write_object(
    root: &Path,
    value: &Value,
    max_bytes: usize,
) -> std::io::Result<ObjectRef> {
    let raw = canonical_stringify(value);
    let bytes = raw.len();
    if bytes > max_bytes {
        return Err(invalid_data(format!(
            "Tabs registry object exceeds {max_bytes} bytes"
        )));
    }
    let digest = sha256_hex_full(&raw);
    let relative = format!("objects/{digest}.json");
    let objects_dir = root.join("v1").join("objects");
    let object_path = objects_dir.join(format!("{digest}.json"));
    if object_path.exists() {
        let existing = std::fs::read_to_string(&object_path)?;
        if existing.len() != bytes || sha256_hex_full(&existing) != digest {
            return Err(invalid_data(format!(
                "Tabs registry existing compact object failed hash validation: {relative}"
            )));
        }
        return Ok(ObjectRef {
            path: relative,
            sha256: digest,
            bytes: bytes as u64,
        });
    }

    let tmp_path = root.join("v1").join("tmp").join(format!(
        "{digest}.{}.{}.tmp",
        std::process::id(),
        epoch_millis()
    ));
    {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(raw.as_bytes())?;
        // Best-effort fsync (Node: bestEffortFsyncFile, store.ts:990).
        let _ = file.sync_all();
    }
    if let Err(err) = std::fs::rename(&tmp_path, &object_path) {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            // Rename race: another writer landed the SAME content-addressed
            // object first — reuse it (store.ts:992-998).
            let _ = std::fs::remove_file(&tmp_path);
        } else {
            return Err(err);
        }
    }
    fsync_dir_best_effort(&objects_dir);
    Ok(ObjectRef {
        path: relative,
        sha256: digest,
        bytes: bytes as u64,
    })
}

/// `loadCompactState` (store.ts:724-851), defense-in-depth in the exact
/// original order: manifest stat-size cap → read → byte-cap re-check → JSON
/// parse → schema validate → per-ref pre-checks (ALL before opening any
/// object file) → per-object stat/read/hash/schema checks → snapshot-key
/// identity + payload-hash re-verification → state-cap validation.
fn load_compact_state(root: &Path, caps: &TabsStoreCaps) -> Result<LoadedStore, LoadFailure> {
    let manifest_path = root.join("v1").join("manifest.json");
    // Stat-size cap BEFORE reading (store.ts:732-735). A manifest that
    // vanished between exists() and here is an Io failure, exactly like
    // Node's rethrown ENOENT (store.ts:742).
    let manifest_meta = std::fs::metadata(&manifest_path).map_err(LoadFailure::Io)?;
    if manifest_meta.len() > caps.max_serialized_manifest_bytes as u64 {
        return Err(LoadFailure::invalid(format!(
            "Tabs registry compact state manifest exceeds {} bytes",
            caps.max_serialized_manifest_bytes
        )));
    }
    let raw_manifest = std::fs::read_to_string(&manifest_path).map_err(|err| match err.kind() {
        // Non-UTF-8 bytes are corruption, not an operational failure.
        std::io::ErrorKind::InvalidData => LoadFailure::invalid(format!(
            "Tabs registry compact state manifest is invalid: {err}"
        )),
        _ => LoadFailure::Io(err),
    })?;
    if raw_manifest.len() > caps.max_serialized_manifest_bytes {
        return Err(LoadFailure::invalid(format!(
            "Tabs registry compact state manifest exceeds {} bytes",
            caps.max_serialized_manifest_bytes
        )));
    }
    let manifest: ManifestV1 = serde_json::from_str(&raw_manifest).map_err(|err| {
        LoadFailure::invalid(format!(
            "Tabs registry compact state manifest is invalid: {err}"
        ))
    })?;
    validate_manifest(&manifest).map_err(|message| {
        LoadFailure::invalid(format!(
            "Tabs registry compact state manifest is invalid: {message}"
        ))
    })?;
    validate_refs_pre_read(&manifest, caps).map_err(LoadFailure::invalid)?;

    let mut open_snapshots_by_client = HashMap::new();
    let mut prev_open = HashMap::new();
    for (key, object_ref) in &manifest.open_snapshots {
        let raw = read_object_raw(
            root,
            object_ref,
            caps.max_serialized_client_snapshot_object_bytes,
        )?;
        let snapshot =
            parse_open_snapshot(key, &raw, &object_ref.path).map_err(LoadFailure::invalid)?;
        prev_open.insert(
            key.clone(),
            CommittedComponent {
                canonical: canonical_of(&snapshot),
                object: object_ref.clone(),
            },
        );
        open_snapshots_by_client.insert(key.clone(), snapshot);
    }
    let raw_revisions = read_object_raw(
        root,
        &manifest.client_revisions,
        caps.max_serialized_device_metadata_object_bytes,
    )?;
    let client_revisions_by_client =
        parse_watermarks(&raw_revisions, &manifest.client_revisions.path)
            .map_err(LoadFailure::invalid)?;
    let raw_closed = read_object_raw(
        root,
        &manifest.closed_tombstones,
        caps.max_serialized_closed_tombstone_object_bytes,
    )?;
    let closed_by_tab_key = parse_tombstones(&raw_closed, &manifest.closed_tombstones.path)
        .map_err(LoadFailure::invalid)?;
    let raw_devices = read_object_raw(
        root,
        &manifest.devices,
        caps.max_serialized_device_metadata_object_bytes,
    )?;
    let devices_by_id =
        parse_devices(&raw_devices, &manifest.devices.path).map_err(LoadFailure::invalid)?;

    let state = CompactState {
        saved_at: manifest.committed_at,
        max_closed_retention_days: manifest.settings.max_closed_retention_days,
        open_snapshots_by_client,
        client_revisions_by_client,
        closed_by_tab_key,
        devices_by_id,
    };
    validate_state_caps(&state, caps).map_err(LoadFailure::invalid)?;

    let prev = PrevComponents {
        open_snapshots: prev_open,
        client_revisions: CommittedComponent {
            canonical: canonical_of(&state.client_revisions_by_client),
            object: manifest.client_revisions.clone(),
        },
        closed_tombstones: CommittedComponent {
            canonical: canonical_of(&state.closed_by_tab_key),
            object: manifest.closed_tombstones.clone(),
        },
        devices: CommittedComponent {
            canonical: canonical_of(&state.devices_by_id),
            object: manifest.devices.clone(),
        },
    };
    Ok(LoadedStore {
        state,
        manifest_revision: manifest.manifest_revision,
        prev,
    })
}

/// `ManifestSchema` (store.ts:211-224): literal version, non-negative
/// counters, well-formed object refs, and the pinned settings literals.
fn validate_manifest(manifest: &ManifestV1) -> Result<(), String> {
    if manifest.version != 1 {
        return Err("manifest version must be 1".to_string());
    }
    if manifest.manifest_revision < 0 || manifest.committed_at < 0 {
        return Err("manifest counters must be non-negative".to_string());
    }
    for (key, object_ref) in &manifest.open_snapshots {
        if key.is_empty() {
            return Err("manifest openSnapshots keys must be non-empty".to_string());
        }
        validate_object_ref(object_ref)?;
    }
    validate_object_ref(&manifest.client_revisions)?;
    validate_object_ref(&manifest.closed_tombstones)?;
    validate_object_ref(&manifest.devices)?;
    if manifest.settings.open_snapshot_ttl_minutes != DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES {
        return Err(format!(
            "manifest settings.openSnapshotTtlMinutes must be {DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES}"
        ));
    }
    if manifest.settings.device_display_ttl_days != DEFAULT_DEVICE_DISPLAY_TTL_DAYS {
        return Err(format!(
            "manifest settings.deviceDisplayTtlDays must be {DEFAULT_DEVICE_DISPLAY_TTL_DAYS}"
        ));
    }
    // `z.number().int().min(1).max(30)` (store.ts:222); 30 IS the default
    // retention constant.
    if !(1..=DEFAULT_CLOSED_RETENTION_DAYS).contains(&manifest.settings.max_closed_retention_days) {
        return Err("manifest settings.maxClosedRetentionDays must be 1..=30".to_string());
    }
    Ok(())
}

/// `ObjectRefSchema` (store.ts:196-209): `objects/[a-f0-9]{64}.json` path
/// whose embedded digest equals the `sha256` field.
fn validate_object_ref(object_ref: &ObjectRef) -> Result<(), String> {
    let digest = object_ref
        .path
        .strip_prefix("objects/")
        .and_then(|rest| rest.strip_suffix(".json"))
        .filter(|digest| is_hex64(digest));
    let Some(digest) = digest else {
        return Err(format!(
            "Object reference path is invalid: {}",
            object_ref.path
        ));
    };
    if !is_hex64(&object_ref.sha256) {
        return Err(format!(
            "Object reference sha256 is invalid: {}",
            object_ref.sha256
        ));
    }
    if digest != object_ref.sha256 {
        return Err("Object reference path must be derived from the content hash".to_string());
    }
    Ok(())
}

/// `validateManifestRefsBeforeRead` (store.ts:786-811): ref-count cap,
/// per-ref byte caps, and the aggregate referenced-bytes cap — ALL before
/// opening any object file.
fn validate_refs_pre_read(manifest: &ManifestV1, caps: &TabsStoreCaps) -> Result<(), String> {
    if manifest.open_snapshots.len() > caps.max_client_snapshot_refs {
        return Err(format!(
            "Tabs registry can retain at most {} client snapshots",
            caps.max_client_snapshot_refs
        ));
    }
    for object_ref in manifest.open_snapshots.values() {
        if object_ref.bytes > caps.max_serialized_client_snapshot_object_bytes as u64 {
            return Err(format!(
                "Tabs registry compact state object {} exceeds {} bytes",
                object_ref.path, caps.max_serialized_client_snapshot_object_bytes
            ));
        }
    }
    let fixed_refs: [(&ObjectRef, usize); 3] = [
        (
            &manifest.client_revisions,
            caps.max_serialized_device_metadata_object_bytes,
        ),
        (
            &manifest.closed_tombstones,
            caps.max_serialized_closed_tombstone_object_bytes,
        ),
        (
            &manifest.devices,
            caps.max_serialized_device_metadata_object_bytes,
        ),
    ];
    for (object_ref, max_bytes) in fixed_refs {
        if object_ref.bytes > max_bytes as u64 {
            return Err(format!(
                "Tabs registry compact state object {} exceeds {max_bytes} bytes",
                object_ref.path
            ));
        }
    }
    let referenced_bytes = manifest
        .open_snapshots
        .values()
        .chain([
            &manifest.client_revisions,
            &manifest.closed_tombstones,
            &manifest.devices,
        ])
        .fold(0u64, |sum, object_ref| sum.saturating_add(object_ref.bytes));
    if referenced_bytes > caps.max_compact_state_bytes as u64 {
        return Err(format!(
            "Tabs registry compact state exceeds {} bytes",
            caps.max_compact_state_bytes
        ));
    }
    Ok(())
}

/// `readObject`'s IO half (store.ts:748-778): per-ref byte cap → stat size ==
/// `bytes` → read → byte length + full-digest re-verification. A missing
/// object file (ENOENT) is the ONE self-healing invalid state; operational fs
/// errors propagate as Io.
fn read_object_raw(
    root: &Path,
    object_ref: &ObjectRef,
    max_bytes: usize,
) -> Result<String, LoadFailure> {
    if object_ref.bytes > max_bytes as u64 {
        return Err(LoadFailure::invalid(format!(
            "Tabs registry compact state object {} exceeds {max_bytes} bytes",
            object_ref.path
        )));
    }
    let absolute = root.join("v1").join(&object_ref.path);
    let meta = std::fs::metadata(&absolute).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => LoadFailure::missing_object(format!(
            "Tabs registry compact state object {} is unavailable: {err}",
            object_ref.path
        )),
        _ => LoadFailure::Io(err),
    })?;
    if meta.len() != object_ref.bytes {
        return Err(LoadFailure::invalid(format!(
            "Tabs registry compact state object size mismatch: {}",
            object_ref.path
        )));
    }
    let raw = std::fs::read_to_string(&absolute).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => LoadFailure::missing_object(format!(
            "Tabs registry compact state object {} is unavailable: {err}",
            object_ref.path
        )),
        std::io::ErrorKind::InvalidData => LoadFailure::invalid(format!(
            "Tabs registry compact state object {} could not be read: {err}",
            object_ref.path
        )),
        _ => LoadFailure::Io(err),
    })?;
    if raw.len() as u64 != object_ref.bytes || sha256_hex_full(&raw) != object_ref.sha256 {
        return Err(LoadFailure::invalid(format!(
            "Tabs registry compact state object failed hash validation: {}",
            object_ref.path
        )));
    }
    Ok(raw)
}

/// The 8 legal `ClientOpenSnapshot` keys — the zod schema is `.strict()`
/// (store.ts:226-235), so any other key is corruption.
const SNAPSHOT_KEYS: [&str; 8] = [
    "deviceId",
    "deviceLabel",
    "clientInstanceId",
    "snapshotRevision",
    "lastPushPayloadHash",
    "openSnapshotPayloadHash",
    "snapshotReceivedAt",
    "records",
];

/// `ClientOpenSnapshotSchema` (store.ts:226-256) + the snapshot-key identity
/// check (store.ts:379-384,817) + `openSnapshotPayloadHash` re-verification
/// (store.ts:818-820). Records are pane-kind-normalized BEFORE validation
/// (Node's `TabRegistryRecordSchema` parse, Task 8 acceptance decision).
fn parse_open_snapshot(key: &str, raw: &str, ref_path: &str) -> Result<ClientOpenSnapshot, String> {
    let value: Value = serde_json::from_str(raw).map_err(|err| {
        format!("Tabs registry compact state object {ref_path} is invalid: {err}")
    })?;
    let object = value.as_object().ok_or_else(|| {
        format!("Tabs registry compact state object {ref_path} is invalid: not an object")
    })?;
    for object_key in object.keys() {
        if !SNAPSHOT_KEYS.contains(&object_key.as_str()) {
            return Err(format!(
                "Tabs registry compact state object {ref_path} is invalid: unknown snapshot key '{object_key}'"
            ));
        }
    }
    let mut snapshot: ClientOpenSnapshot = serde_json::from_value(value).map_err(|err| {
        format!("Tabs registry compact state object {ref_path} is invalid: {err}")
    })?;
    if snapshot.device_id.is_empty()
        || snapshot.device_label.is_empty()
        || snapshot.client_instance_id.is_empty()
    {
        return Err(format!(
            "Tabs registry compact state object {ref_path} is invalid: snapshot identity fields must be non-empty"
        ));
    }
    if snapshot.snapshot_revision < 0 || snapshot.snapshot_received_at < 0 {
        return Err(format!(
            "Tabs registry compact state object {ref_path} is invalid: snapshot counters must be non-negative"
        ));
    }
    if !is_hex64(&snapshot.last_push_payload_hash)
        || !is_hex64(&snapshot.open_snapshot_payload_hash)
    {
        return Err(format!(
            "Tabs registry compact state object {ref_path} is invalid: snapshot payload hashes must be 64-hex"
        ));
    }
    for record in &mut snapshot.records {
        normalize_registry_pane_kinds(record);
        validate_registry_record(record).map_err(|err| {
            format!("Tabs registry compact state object {ref_path} is invalid: {err}")
        })?;
        if record.get("status").and_then(Value::as_str) != Some("open") {
            return Err("Client open snapshot records must contain open records only".to_string());
        }
        let identity_matches = record.get("deviceId").and_then(Value::as_str)
            == Some(snapshot.device_id.as_str())
            && record.get("deviceLabel").and_then(Value::as_str)
                == Some(snapshot.device_label.as_str())
            && record.get("clientInstanceId").and_then(Value::as_str)
                == Some(snapshot.client_instance_id.as_str());
        if !identity_matches {
            return Err(
                "Client open snapshot record identity must match the snapshot identity".to_string(),
            );
        }
    }
    let expected_key = client_snapshot_key(&snapshot.device_id, &snapshot.client_instance_id)?;
    if key != expected_key {
        return Err(
            "Tabs registry compact state snapshot key does not match snapshot identity".to_string(),
        );
    }
    let rebuilt = build_snapshot_payload_hash(
        &snapshot.device_id,
        &snapshot.device_label,
        &snapshot.client_instance_id,
        snapshot.snapshot_revision,
        &snapshot.records,
    );
    if snapshot.open_snapshot_payload_hash != rebuilt {
        return Err(
            "Tabs registry compact state client snapshot payload hash does not match snapshot content"
                .to_string(),
        );
    }
    Ok(snapshot)
}

/// `ClientRevisionsSchema` (store.ts:294-309): typed watermarks whose map key
/// equals `clientSnapshotKey(deviceId, clientInstanceId)`.
fn parse_watermarks(
    raw: &str,
    ref_path: &str,
) -> Result<HashMap<String, ClientRevisionWatermark>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|err| {
        format!("Tabs registry compact state object {ref_path} is invalid: {err}")
    })?;
    let object = value.as_object().ok_or_else(|| {
        format!("Tabs registry compact state object {ref_path} is invalid: not an object")
    })?;
    let mut out = HashMap::with_capacity(object.len());
    for (key, entry) in object {
        let watermark: ClientRevisionWatermark =
            serde_json::from_value(entry.clone()).map_err(|err| {
                format!("Tabs registry compact state object {ref_path} is invalid: {err}")
            })?;
        if watermark.device_id.is_empty()
            || watermark.client_instance_id.is_empty()
            || watermark.snapshot_revision < 0
            || watermark.last_seen_at < 0
        {
            return Err(format!(
                "Tabs registry compact state object {ref_path} is invalid: watermark fields out of range"
            ));
        }
        let expected = client_snapshot_key(&watermark.device_id, &watermark.client_instance_id)?;
        if *key != expected {
            return Err("Tabs registry client revision key must match client identity".to_string());
        }
        out.insert(key.clone(), watermark);
    }
    Ok(out)
}

/// `ClosedTombstonesSchema` (store.ts:274-292): pane-kind-normalized,
/// schema-valid CLOSED records keyed by their own `tabKey`.
fn parse_tombstones(raw: &str, ref_path: &str) -> Result<HashMap<String, Value>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|err| {
        format!("Tabs registry compact state object {ref_path} is invalid: {err}")
    })?;
    let object = value.as_object().ok_or_else(|| {
        format!("Tabs registry compact state object {ref_path} is invalid: not an object")
    })?;
    let mut out = HashMap::with_capacity(object.len());
    for (key, entry) in object {
        let mut record = entry.clone();
        normalize_registry_pane_kinds(&mut record);
        validate_registry_record(&record).map_err(|err| {
            format!("Tabs registry compact state object {ref_path} is invalid: {err}")
        })?;
        if record.get("status").and_then(Value::as_str) != Some("closed") {
            return Err(
                "Tabs registry closed tombstones must contain closed records only".to_string(),
            );
        }
        if record.get("tabKey").and_then(Value::as_str) != Some(key.as_str()) {
            return Err("Tabs registry closed tombstone key must match record tabKey".to_string());
        }
        out.insert(key.clone(), record);
    }
    Ok(out)
}

/// `DevicesSchema` (store.ts:258-272): typed device entries keyed by their
/// own `deviceId`.
fn parse_devices(
    raw: &str,
    ref_path: &str,
) -> Result<HashMap<String, RegistryDeviceEntry>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|err| {
        format!("Tabs registry compact state object {ref_path} is invalid: {err}")
    })?;
    let object = value.as_object().ok_or_else(|| {
        format!("Tabs registry compact state object {ref_path} is invalid: not an object")
    })?;
    let mut out = HashMap::with_capacity(object.len());
    for (key, entry) in object {
        let device: RegistryDeviceEntry = serde_json::from_value(entry.clone()).map_err(|err| {
            format!("Tabs registry compact state object {ref_path} is invalid: {err}")
        })?;
        if device.device_id.is_empty() || device.device_label.is_empty() || device.last_seen_at < 0
        {
            return Err(format!(
                "Tabs registry compact state object {ref_path} is invalid: device fields out of range"
            ));
        }
        if *key != device.device_id {
            return Err("Tabs registry devices metadata key must match deviceId".to_string());
        }
        out.insert(key.clone(), device);
    }
    Ok(out)
}

/// `archiveCompactManifest` (store.ts:712-722): rename the manifest to
/// `manifest.json.invalid-<archive_timestamp>` (already-gone is fine), then
/// fsync the dir best-effort.
fn archive_compact_manifest(root: &Path, now_ms: i64) -> std::io::Result<()> {
    let v1_dir = root.join("v1");
    let manifest_path = v1_dir.join("manifest.json");
    let archive_path = v1_dir.join(format!(
        "manifest.json.invalid-{}",
        archive_timestamp(now_ms)
    ));
    match std::fs::rename(&manifest_path, &archive_path) {
        Ok(()) => {
            fsync_dir_best_effort(&v1_dir);
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// `garbageCollectObjects` (store.ts:1054-1060): clear `v1/tmp/*` after a
/// successful publish. NEVER touches `objects/*` — an overlapping restart may
/// still reference objects this process considers unreachable
/// (store.test.ts:177). Failures are logged, never surfaced: the mutation is
/// already durably committed.
fn clear_tmp_best_effort(root: &Path) {
    let tmp_dir = root.join("v1").join("tmp");
    let Ok(entries) = std::fs::read_dir(&tmp_dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(err) = result {
            tracing::warn!(path = %path.display(), error = %err, "tabs_registry_tmp_clear_failed");
        }
    }
}

fn component_value<T: serde::Serialize>(component: &T) -> std::io::Result<Value> {
    serde_json::to_value(component).map_err(|err| {
        invalid_data(format!(
            "Tabs registry component serialization failed: {err}"
        ))
    })
}

/// The canonical serialization used for the commit-time reuse compare. A
/// serialization failure degrades to "no reuse" (empty string never matches).
fn canonical_of<T: serde::Serialize>(component: &T) -> String {
    serde_json::to_value(component)
        .map(|value| canonical_stringify(&value))
        .unwrap_or_default()
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn fsync_dir_best_effort(dir: &Path) {
    #[cfg(unix)]
    if let Ok(file) = std::fs::File::open(dir) {
        let _ = file.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests;
