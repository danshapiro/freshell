//! Server-side opencode model-limit snapshot for the session-directory
//! context meter.
//!
//! The sessions indexer resolves per-session model limits through a SYNC
//! resolver (the directory sweep runs on `spawn_blocking`); the catalog
//! probe is async and process-spawning. This module owns the bridge: an
//! async refresh task reads the freshagent `ModelCapabilityRegistry`
//! (TTL/single-flight inside the registry) and stores cwd-keyed catalog
//! buckets — `cwd -> (model id -> limits)` — in a sync-read snapshot; the
//! resolver closure handed to `OpencodeSource` (built by
//! [`build_opencode_limit_resolver`], the exact production wiring) reads
//! it with the SESSION's own cwd and ONLY that bucket: opencode's catalog
//! is cwd-scoped (project config can alter limits), so a session resolves
//! against its own project's catalog or stays UNKNOWN — never another
//! catalog's limits (wrong data is worse than an unknown meter; there is
//! deliberately NO default-catalog fallback). Buckets are replaced
//! WHOLESALE on every successful probe, so a config edit that removes a
//! limit is learned — that model's sessions meter-unknown again instead of
//! carrying a stale threshold forever. A cold snapshot, an unprobed cwd
//! (outside the recent-cwd window or before its first probe completes),
//! or a failed probe keeps the meter unknown — the accepted graceful
//! degradation. A refresh that CHANGES any bucket marks the opencode
//! provider dirty so the index re-lists and broadcasts without needing an
//! opencode DB write (a warm snapshot alone would leave frozen
//! DirectEntry rows meter-muted until unrelated activity). The resolver
//! lookup is exact-match first with a single effort-suffix strip (opencode
//! stores the runtime model as `model/effort`; the catalog keys base
//! models only — live-verified).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use freshell_freshagent::model_capabilities::{
    ModelCapability, ModelCapabilityRegistry, SessionType,
};
use freshell_sessions::directory_index::{
    IndexedSession, OpencodeModelLimitResolver, SessionIndex,
};
use freshell_sessions::parse::OpencodeModelLimits;

/// Refresh cadence. The registry's own 5-min TTL absorbs the ticks: a tick
/// is a cache read except once per TTL window per catalog.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// The per-cwd catalogs probed per cycle: the distinct cwds of the most
/// recent opencode sessions. Bounded so a directory full of distinct
/// worktrees can never spawn an unbounded probe storm. This window IS the
/// meter's coverage: sessions in cwds outside it (or before its first
/// probe completes) stay meter-unknown — honest, never wrong. The first
/// fill probes up to this many transient `opencode serve --pure` children
/// serially (~3s each, once per registry TTL window, single-flighted by
/// the registry).
pub const PER_CWD_SESSION_WINDOW: usize = 16;

/// `cwd -> (model id -> limits)`. Bucket PRESENCE records a successful
/// probe of that cwd's catalog — even an empty bucket is an authoritative
/// "unresolvable" for that cwd.
pub type Snapshot = Arc<RwLock<HashMap<String, HashMap<String, OpencodeModelLimits>>>>;

pub fn snapshot() -> Snapshot {
    Arc::new(RwLock::new(HashMap::new()))
}

/// The snapshot key for a session cwd (trimmed; listed opencode sessions
/// always carry a non-empty cwd).
fn bucket_key(cwd: &str) -> String {
    cwd.trim().to_string()
}

/// One successful catalog's limit-bearing models, keyed by composite model
/// id (models without a limit block are absent — unresolvable, meter
/// unknown).
pub(crate) fn limit_map(models: Vec<ModelCapability>) -> HashMap<String, OpencodeModelLimits> {
    models
        .into_iter()
        .filter_map(|model| {
            model.limit.map(|limit| {
                (
                    model.id,
                    OpencodeModelLimits {
                        context: limit.context,
                        input: limit.input,
                        output: limit.output,
                    },
                )
            })
        })
        .collect()
}

/// Snapshot lookup for a session: ONLY its own cwd's bucket. opencode's
/// catalog is cwd-scoped (project config can alter limits), so resolving
/// against any other catalog could show a WRONG threshold — an unprobed
/// cwd stays the honest unknown (plan-review round-3 finding 2; there is
/// deliberately no default-catalog fallback). Within the bucket: exact
/// composite match first; if that misses and the composite has 3+
/// segments (`provider/model/effort` — opencode stores the runtime model
/// with the effort suffix; live-verified the catalog keys only base
/// models), strip ONE trailing segment and retry the base. Two-segment
/// composites never strip. Residual (accepted): a
/// `provider/org/name/effort` id whose stripped base is configured
/// resolves the base's limits — the same model family, the same
/// base-then-variant resolution order opencode itself uses.
pub(crate) fn resolve_from_snapshot(
    snap: &Snapshot,
    cwd: &str,
    model: &str,
) -> Option<OpencodeModelLimits> {
    let map = snap.read().ok()?;
    let models = map.get(&bucket_key(cwd))?;
    if let Some(limits) = models.get(model) {
        return Some(limits.clone());
    }
    if model.matches('/').count() >= 2 {
        if let Some((base, _)) = model.rsplit_once('/') {
            return models.get(base).cloned();
        }
    }
    None
}

/// The production resolver closure `main.rs` hands to `OpencodeSource` —
/// factored out so the exact production wiring is unit-testable (the
/// plan-review chain test drives the same closure).
pub fn build_opencode_limit_resolver(snap: Snapshot) -> OpencodeModelLimitResolver {
    Arc::new(move |cwd: &str, model: &str| resolve_from_snapshot(&snap, cwd, model))
}

/// Record one catalog's limit map in its bucket, WHOLESALE — a catalog
/// that DROPPED a limit removes the stale entry (that model's sessions
/// meter-unknown again; never a permanently-stale threshold). Bucket
/// PRESENCE is the probe-authority marker: even an EMPTY limit map keeps
/// the bucket present, because a successfully probed catalog carrying no
/// limits is an authoritative "unresolvable" for that cwd (an empty
/// bucket must never be conflated with an unprobed one). Returns `true`
/// when the bucket content changed (the re-list nudge signal — an
/// identical refresh must not nudge). A poisoned lock returns false —
/// the next cycle retries.
pub(crate) fn replace_bucket(
    snap: &Snapshot,
    bucket: &str,
    fresh: HashMap<String, OpencodeModelLimits>,
) -> bool {
    let Ok(mut map) = snap.write() else {
        return false;
    };
    let changed = map.get(bucket) != Some(&fresh);
    map.insert(bucket.to_string(), fresh);
    changed
}

/// The distinct cwds of the `window` most recent opencode sessions,
/// most-recent first (deduped).
pub(crate) fn recent_opencode_cwds(sessions: &[IndexedSession], window: usize) -> Vec<String> {
    let mut opencode: Vec<&IndexedSession> = sessions
        .iter()
        .filter(|s| s.provider == "opencode")
        .collect();
    opencode.sort_by_key(|s| std::cmp::Reverse(s.last_activity_at));
    let mut seen = std::collections::HashSet::new();
    let mut cwds = Vec::new();
    for session in opencode {
        let Some(cwd) = session.cwd.as_deref().filter(|c| !c.is_empty()) else {
            continue;
        };
        if seen.insert(cwd.to_string()) {
            cwds.push(cwd.to_string());
            if cwds.len() == window {
                break;
            }
        }
    }
    cwds
}

async fn refresh_once(
    registry: &ModelCapabilityRegistry,
    session_index: &SessionIndex,
    snap: &Snapshot,
) {
    // `?e` (Debug): CapabilityError implements Debug, not Display.
    // There is deliberately NO cwd-less default probe: resolutions are
    // cwd-strict, so a default catalog could never be (correctly) used —
    // probing it would only invite the wrong-data fallback.
    let mut nudge = false;
    let sessions = session_index.snapshot().await;
    for cwd in recent_opencode_cwds(&sessions, PER_CWD_SESSION_WINDOW) {
        match registry
            .models(SessionType::FreshOpencode, Some(cwd.clone()))
            .await
        {
            Ok(models) => {
                if replace_bucket(snap, &bucket_key(&cwd), limit_map(models)) {
                    nudge = true;
                }
            }
            Err(e) => {
                tracing::debug!(cwd = %cwd, error = ?e, "opencode per-cwd catalog probe failed; keeping previous limits")
            }
        }
    }
    if nudge {
        // F2: a bucket changed (first fill after boot, a new model, a
        // config edit) — nudge a re-list so already-listed opencode rows
        // pick the new limits up without waiting for an unrelated opencode
        // DB write (DirectEntry rows are change-token/dirty-gated only).
        // The direct arm counts a re-list as changed only when its
        // published items differ — this nudge's own re-list still advances
        // the change generation (new limits change token_usage), so
        // `subscribe_changes` consumers broadcast and idle sessions' meters
        // light up.
        session_index.mark_provider_dirty("opencode");
    }
}

/// Runs forever: refresh the snapshot every [`REFRESH_INTERVAL`].
pub async fn refresh_loop(
    registry: Arc<ModelCapabilityRegistry>,
    session_index: Arc<SessionIndex>,
    snap: Snapshot,
) -> ! {
    loop {
        refresh_once(&registry, &session_index, &snap).await;
        tokio::time::sleep(REFRESH_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_freshagent::model_capabilities::{
        CatalogOut, ModelCapabilityRegistry, ModelCatalogProbe, ModelLimits,
    };

    /// A minimal `ModelCapability` for the limit-map/registry tests — only
    /// `id` + `limit` carry meaning here (the catalog's other fields feed
    /// the model dialog, which the snapshot never reads).
    fn model_capability(
        id: &str,
        limit: Option<(i64, Option<i64>, Option<i64>)>,
    ) -> ModelCapability {
        ModelCapability {
            default_effort: None,
            input_modalities: None,
            id: id.to_string(),
            display_name: id.to_string(),
            provider: "opencode",
            source: None,
            supports_effort: false,
            supported_effort_levels: Vec::new(),
            supports_adaptive_thinking: false,
            limit: limit.map(|(context, input, output)| ModelLimits {
                context,
                input,
                output,
            }),
        }
    }

    /// A literal `IndexedSession` (the struct has no `Default`): every
    /// field irrelevant to the cwd-window/limit logic is `None`/defaulted,
    /// so each test only overrides what it asserts on.
    fn minimal_indexed_session(session_id: &str, provider: &str) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            legacy_session_id: None,
            provider: provider.to_string(),
            project_path: "/repo/x".to_string(),
            title: None,
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: 0,
            created_at: None,
            cwd: None,
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
            token_usage: None,
        }
    }

    #[test]
    fn limit_map_keeps_limit_bearing_models() {
        let map = limit_map(vec![
            model_capability("lunaroute/glm-5.3", Some((524_288, None, Some(131_072)))),
            model_capability("lunaroute/unlimited", None),
        ]);
        assert_eq!(
            map.get("lunaroute/glm-5.3"),
            Some(&OpencodeModelLimits {
                context: 524_288,
                input: None,
                output: Some(131_072)
            })
        );
        assert!(!map.contains_key("lunaroute/unlimited"));
    }

    #[test]
    fn recent_opencode_cwds_distinct_recent_first_and_capped() {
        let sessions: Vec<IndexedSession> = (0..20)
            .map(|i| {
                let mut s = minimal_indexed_session(&format!("ses_{i}"), "opencode");
                s.cwd = Some(if i % 2 == 0 { "/repo/a" } else { "/repo/b" }.to_string());
                s.last_activity_at = i;
                s
            })
            .chain(std::iter::once({
                let mut s = minimal_indexed_session("ses_claude", "claude");
                s.cwd = Some("/repo/a".to_string());
                s.last_activity_at = 999;
                s
            }))
            .collect();
        let cwds = recent_opencode_cwds(&sessions, 2);
        assert_eq!(cwds, vec!["/repo/b".to_string(), "/repo/a".to_string()]);
    }

    #[test]
    fn replace_bucket_wholesale_learns_removals_and_reports_change() {
        // Wholesale bucket replacement: a catalog that DROPPED a limit
        // removes the stale entry (that model's sessions meter-unknown
        // again — never a permanently-stale threshold), and only real
        // content changes report `true` (the re-list nudge signal).
        let snap = snapshot();
        let a = OpencodeModelLimits {
            context: 1,
            input: None,
            output: None,
        };
        assert!(replace_bucket(
            &snap,
            "/repo/a",
            [("m/x".into(), a.clone())].into()
        )); // first fill: change
        assert!(!replace_bucket(
            &snap,
            "/repo/a",
            [("m/x".into(), a.clone())].into()
        )); // identical: no change
        let changed = OpencodeModelLimits {
            context: 2,
            input: None,
            output: None,
        };
        assert!(replace_bucket(
            &snap,
            "/repo/a",
            [("m/x".into(), changed)].into()
        )); // value changed: change
            // a probe that now returns NO limit-bearing models keeps the
            // bucket PRESENT but empty (authoritative "unresolvable" for that
            // cwd) and reports change
        assert!(replace_bucket(
            &snap,
            "/repo/a",
            std::collections::HashMap::new()
        ));
        assert!(resolve_from_snapshot(&snap, "/repo/a", "m/x").is_none());
        // another cwd's catalog NEVER answers for /repo/a (cwd-strict —
        // the empty-probed bucket stays authoritative over any other
        // bucket's data)
        assert!(replace_bucket(
            &snap,
            "/repo/b",
            [(
                "m/x".into(),
                OpencodeModelLimits {
                    context: 500_000,
                    input: None,
                    output: None
                }
            )]
            .into()
        ));
        assert!(resolve_from_snapshot(&snap, "/repo/a", "m/x").is_none());
        // and /repo/b's own sessions resolve its bucket
        assert_eq!(
            resolve_from_snapshot(&snap, "/repo/b", "m/x")
                .unwrap()
                .context,
            500_000
        );
    }

    #[test]
    fn resolver_is_cwd_strict_with_effort_strip() {
        // cwd-STRICT resolution (plan-review round-3 finding 2): a session
        // resolves ONLY against its own cwd's probed catalog — an unprobed
        // cwd stays the honest unknown; one project's limits can never
        // answer another's; the effort strip stays within the bucket.
        let snap = snapshot();
        replace_bucket(
            &snap,
            "/repo/a",
            [
                (
                    "lunaroute/glm-5.3".into(),
                    OpencodeModelLimits {
                        context: 200_000,
                        input: None,
                        output: Some(131_072),
                    },
                ),
                (
                    "lunaroute/deepseek-4.1-flash".into(),
                    OpencodeModelLimits {
                        context: 1_048_576,
                        input: None,
                        output: Some(262_144),
                    },
                ),
            ]
            .into(),
        );
        replace_bucket(
            &snap,
            "/repo/b",
            [(
                "lunaroute/glm-5.3".into(),
                OpencodeModelLimits {
                    context: 90_000,
                    input: None,
                    output: Some(131_072),
                },
            )]
            .into(),
        );
        // each cwd resolves its OWN bucket
        assert_eq!(
            resolve_from_snapshot(&snap, "/repo/a", "lunaroute/glm-5.3")
                .unwrap()
                .context,
            200_000
        );
        assert_eq!(
            resolve_from_snapshot(&snap, "/repo/b", "lunaroute/glm-5.3")
                .unwrap()
                .context,
            90_000
        );
        // a probed bucket's miss is authoritative — no cross-cwd fallback
        assert_eq!(
            resolve_from_snapshot(&snap, "/repo/a", "ms-runpod/moonshotai/Kimi-K3"),
            None
        );
        // an UNPROBED cwd stays unknown — never another catalog's limits
        assert_eq!(
            resolve_from_snapshot(&snap, "/repo/never-probed", "lunaroute/glm-5.3"),
            None
        );
        // 2-segment miss stays a miss — never strips
        assert!(resolve_from_snapshot(&snap, "/repo/a", "lunaroute/unknown").is_none());
        // effort-suffixed composite (3+ segments) resolves its base
        assert_eq!(
            resolve_from_snapshot(&snap, "/repo/a", "lunaroute/deepseek-4.1-flash/low")
                .unwrap()
                .context,
            1_048_576
        );
    }

    // ── the production-chain wiring test ─────────────────────────────────

    /// Scripted catalog probe: answers every probe with the same scripted
    /// catalog (mirrors the registry's own scripted-probe tests — never a
    /// real `opencode serve`).
    struct ScriptedProbe {
        models: Vec<ModelCapability>,
    }

    impl ModelCatalogProbe for ScriptedProbe {
        fn probe<'a>(
            &'a self,
            _cwd: Option<&'a str>,
        ) -> futures_util::future::BoxFuture<'a, CatalogOut> {
            Box::pin(async move { Ok(self.models.clone()) })
        }
    }

    /// The usage-bearing fixture opencode db (the exact Task-3 fixture
    /// shape): one session in cwd `/repo/x` whose `model` column derives
    /// the composite `lunaroute/glm-5.3-vision-background`, plus an
    /// assistant message whose step-finish part carries the tokens the
    /// meter reads. Fixture DBs live under temp dirs only — the user's
    /// real opencode db is never touched.
    fn wiring_fixture_data_home(home: &std::path::Path) -> std::path::PathBuf {
        let data_home = home.join("opencode-data");
        std::fs::create_dir_all(&data_home).unwrap();
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT, model TEXT
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
                time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('ses_meter','/repo/x','Named',1000,5000,NULL,NULL,NULL,?1)",
            rusqlite::params![
                r#"{"id":"glm-5.3-vision-background","providerID":"lunaroute","variant":"default"}"#
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('msg_usage','ses_meter',200,'{\"role\":\"assistant\"}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part VALUES ('prt_usage','msg_usage','ses_meter',1000,1000,?1)",
            rusqlite::params![
                r#"{"reason":"stop","type":"step-finish","tokens":{"total":395980,"input":31,"output":556,"reasoning":1,"cache":{"write":0,"read":395392}},"cost":0}"#
            ],
        )
        .unwrap();
        drop(conn);
        data_home
    }

    /// The production wiring chain end-to-end (plan-review finding 5):
    /// registry → `refresh_once` → snapshot → the PRODUCTION resolver
    /// closure → `mark_provider_dirty` → re-list → meter visible — built
    /// from `crate::build_session_sources`, the SAME factory `main` uses
    /// for its source list, so dropping the resolver injection or the
    /// snapshot plumbing from the factory FAILS this test.
    #[tokio::test]
    async fn refresh_once_fills_the_snapshot_relists_and_lights_the_meter() {
        let home = std::env::temp_dir().join(format!(
            "freshell-oclimits-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let data_home = wiring_fixture_data_home(&home);
        let db = data_home.join("opencode.db");

        let snap = snapshot();
        // A REAL SessionIndex over the composition root's source list
        // (hour TTL + no persist path, mirroring the sessions crate's test
        // isolation convention — so the ONLY re-list trigger below is the
        // F2 nudge, never a TTL expiry).
        let index = std::sync::Arc::new(SessionIndex::with_ttl_and_cache_path(
            crate::build_session_sources(&home, data_home.clone(), &snap),
            Duration::from_secs(3600),
            None,
        ));

        // Cold publish: the fixture row is listed with its usage counters
        // but the meter stays muted — the snapshot is empty, and an
        // unprobed cwd's resolution is the honest unknown.
        let sessions = index.snapshot().await;
        let row = sessions
            .iter()
            .find(|s| s.provider == "opencode")
            .expect("fixture session listed");
        let cold_usage = row
            .token_usage
            .as_ref()
            .expect("usage exists from the step-finish (Task 3)");
        assert_eq!(cold_usage.total_tokens, 395_980);
        assert!(
            cold_usage.compact_percent.is_none(),
            "cold snapshot: meter muted"
        );

        let mut rx = index.subscribe_changes();
        let baseline_gen = *rx.borrow_and_update();
        let db_mtime_before = std::fs::metadata(&db).unwrap().modified().unwrap();

        // A REAL registry (test seams: scripted probe + injected clock).
        let registry = ModelCapabilityRegistry::with_clock(
            std::sync::Arc::new(ScriptedProbe {
                models: vec![model_capability(
                    "lunaroute/glm-5.3-vision-background",
                    Some((524_288, None, Some(131_072))),
                )],
            }),
            std::sync::Arc::new(|| 1_000u64),
            Duration::from_secs(300),
        );

        // ONE refresh cycle: probe the fixture cwd's catalog, fill its
        // bucket, and (bucket changed) nudge a re-list.
        refresh_once(&registry, &index, &snap).await;

        // (a) the fixture cwd's bucket contains the probe's limits.
        let limits = resolve_from_snapshot(&snap, "/repo/x", "lunaroute/glm-5.3-vision-background")
            .expect("fixture cwd bucket filled");
        assert_eq!(limits.context, 524_288);
        // (b) the PRODUCTION resolver closure resolves the fixture
        // session's model for its own cwd.
        let resolver = build_opencode_limit_resolver(std::sync::Arc::clone(&snap));
        assert_eq!(
            resolver("/repo/x", "lunaroute/glm-5.3-vision-background")
                .unwrap()
                .context,
            524_288
        );
        assert!(
            resolver("/repo/unprobed", "lunaroute/glm-5.3-vision-background").is_none(),
            "the production closure is cwd-strict too"
        );

        // (c) the re-listed row carries threshold/percent WITHOUT any new
        // opencode DB write — the F2 nudge (`mark_provider_dirty`)
        // re-queried the unchanged-token db. Poll the index the way the
        // existing mark_provider_dirty tests do until the background sweep
        // settles.
        let mut lit = None;
        for _ in 0..400 {
            let sessions = index.snapshot().await;
            if let Some(usage) = sessions
                .iter()
                .find(|s| s.provider == "opencode")
                .and_then(|s| s.token_usage.as_ref())
            {
                if usage.compact_percent.is_some() {
                    lit = Some(usage.clone());
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let usage = lit.expect("the re-listed row must carry the meter after the F2 nudge");
        assert_eq!(usage.model_context_window, Some(524_288));
        assert_eq!(usage.compact_threshold_tokens, Some(492_288));
        assert_eq!(usage.compact_percent, Some(80));
        let db_mtime_after = std::fs::metadata(&db).unwrap().modified().unwrap();
        assert_eq!(
            db_mtime_before, db_mtime_after,
            "the meter must light WITHOUT any new opencode DB write (F2 nudge)"
        );

        // (d) the index's change generation advanced (broadcast armed).
        assert!(
            *rx.borrow() > baseline_gen,
            "the forced re-list counts as changed: the change generation advanced"
        );

        std::fs::remove_dir_all(&home).ok();
    }
}
