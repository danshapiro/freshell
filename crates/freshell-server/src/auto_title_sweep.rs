//! Background auto-title sweep — the port of Node's per-session auto-name
//! pass (`server/index.ts:868-950`). Per session with >=1 live matching
//! terminal (`find_all_by_session`, cwd-scoped for claude): compute the sync
//! plan (`compute_session_title_sync` — dir -> first-message -> Gemini AI),
//! persist the `overridePatch` through the title-source ladder
//! (`patch_session_override`), push the canonical title to out-of-sync
//! terminals (`registry.update_title` + `terminal.title.updated` broadcast),
//! and fire ONE Gemini call per session key guarded by the in-process
//! `pending_ai_titles` set. `terminal.title.updated` is emitted ONLY from
//! this sweep and its AI-completion path (Node's two emit sites). One
//! `sessions.changed` per pass when anything changed; the AI completion
//! broadcasts its own (Node: `codingCliIndexer.refresh()` -> sessionsSync
//! publish). Only THIS background sweep honors
//! `settings.sidebar.autoGenerateTitles` — the REST generate-title route
//! (Task 6) does not.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Mutex};

use freshell_protocol::common::TerminalMetaRecord;
use freshell_ws::identity::TerminalIdentity;

/// Everything one pass needs, shaped so tests can construct it without a
/// real server (fake Gemini transport, tempdir-backed settings, throwaway
/// registry). All fields are cheap clones (Arc-backed).
pub struct AutoTitleSweepState {
    pub settings: crate::settings_store::SettingsStore,
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
    pub registry: freshell_terminal::TerminalRegistry,
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    pub sessions_revision: Arc<AtomicI64>,
    pub ai_key: crate::ai_title::AiKeyCell,
    pub gemini: Arc<dyn crate::ai_title::GeminiTransport>,
    /// Node's module-level `pendingAiTitles` set (`server/index.ts:866`):
    /// at most ONE in-flight Gemini call per `provider:sessionId` key.
    pub pending_ai_titles: Arc<Mutex<HashSet<String>>>,
    /// Task 18 (DEV-0008 closure): the shared terminal-metadata registry --
    /// the SAME instance `WsState.terminal_meta` holds -- so this sweep's
    /// per-session meta refresh (Node's `applySessionMetadata` analog,
    /// `server/index.ts:854-866`) commits into the store the handshake's
    /// `terminal.inventory.terminalMeta` reads.
    pub terminal_meta: freshell_ws::terminal_meta::TerminalMetaRegistry,
    /// Task 18: the per-unique-cwd git-enrichment cache backing the
    /// change-gated/throttled refresh -- see [`GitMetaCache`] for the
    /// validator-A7 trigger-divergence rationale.
    pub git_meta_cache: GitMetaCache,
}

/// Minimum age before a cwd's git enrichment is re-run when its terminal-set
/// signature is unchanged (throttled refresh so dirty-status drift still
/// surfaces without a git storm).
pub const GIT_ENRICH_MIN_INTERVAL_MS: i64 = 30_000;

/// Per-unique-normalized-cwd git-enrichment cache (Task 18, KEPT trigger
/// divergence -- validator-A7, ledgered in `port/oracle/DEVIATIONS.md`).
///
/// Node runs its terminal-metadata pass ONLY on indexer update events
/// (`server/index.ts:813` onUpdate, debounce 2 s `session-indexer.ts:436`),
/// per terminal and uncached (`utils.ts:93-116`; only repo roots cached,
/// `:24-26`) -- an idle Node spawns ZERO git processes. This port has no
/// indexer event bus (the session index is poll-based), so the refresh rides
/// the auto-title sweep's tick instead, gated per unique resolved cwd: git
/// runs for a cwd only when (a) the cwd's terminal-set signature changed
/// since its last run, or (b) the last run is >=
/// [`GIT_ENRICH_MIN_INTERVAL_MS`] old. Every spawned git suppresses optional
/// locks (`GIT_OPTIONAL_LOCKS=0`, `freshell_platform::git_meta`) so the poll
/// can never keep rewriting `.git/index`. Measured local cost: 0.01 s per
/// `git --no-optional-locks status --porcelain` (validator-A7); /mnt/c DrvFs
/// cwds are 10-100x slower -- the throttle bounds that to delayed badges.
#[derive(Clone, Default)]
pub struct GitMetaCache {
    inner: Arc<Mutex<HashMap<String, CwdGitEntry>>>,
}

struct CwdGitEntry {
    terminal_signature: String,
    last_run_ms: i64,
    enrichment: CwdEnrichment,
}

/// The five derived fields one cwd's enrichment yields (`enrichFromCwd`'s
/// output slice, `terminal-metadata-service.ts:277-285`).
#[derive(Clone, Default)]
struct CwdEnrichment {
    checkout_root: Option<String>,
    repo_root: Option<String>,
    display_subdir: Option<String>,
    branch: Option<String>,
    is_dirty: Option<bool>,
}

impl GitMetaCache {
    /// The cached enrichment for `cwd`, re-running git only per the gate in
    /// the struct doc. `terminal_signature` is the sorted, newline-joined set
    /// of terminal ids currently resolving to this cwd.
    async fn enrichment_for(&self, cwd: &str, terminal_signature: &str, now: i64) -> CwdEnrichment {
        let cached = {
            let map = self.inner.lock().expect("git meta cache lock");
            map.get(cwd).and_then(|entry| {
                (entry.terminal_signature == terminal_signature
                    && now - entry.last_run_ms < GIT_ENRICH_MIN_INTERVAL_MS)
                    .then(|| entry.enrichment.clone())
            })
        };
        if let Some(hit) = cached {
            return hit;
        }
        // Probe record: reuse the ONE enrichment implementation
        // (`freshell_ws::terminal_meta::enrich_from_cwd`, spawn_blocking git
        // inside) rather than duplicating the git plumbing here.
        let mut probe = TerminalMetaRecord {
            terminal_id: String::new(),
            updated_at: 0,
            branch: None,
            checkout_root: None,
            cwd: Some(cwd.to_string()),
            display_subdir: None,
            is_dirty: None,
            provider: None,
            repo_root: None,
            session_id: None,
            token_usage: None,
        };
        freshell_ws::terminal_meta::enrich_from_cwd(&mut probe).await;
        let enrichment = CwdEnrichment {
            checkout_root: probe.checkout_root,
            repo_root: probe.repo_root,
            display_subdir: probe.display_subdir,
            branch: probe.branch,
            is_dirty: probe.is_dirty,
        };
        self.inner.lock().expect("git meta cache lock").insert(
            cwd.to_string(),
            CwdGitEntry {
                terminal_signature: terminal_signature.to_string(),
                last_run_ms: now,
                enrichment: enrichment.clone(),
            },
        );
        enrichment
    }
}

/// One session as the pass consumes it — decoupled from `IndexedSession` so
/// tests can inject sessions without a real index. `title` must be the
/// OVERRIDE-APPLIED session title (what `/api/session-directory` serves);
/// [`spawn_auto_title_sweep`] applies that overlay when mapping.
pub struct SweepSession {
    pub provider: String,
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_user_message: Option<String>,
    /// The PARSED (pre-override) title source — only compared against
    /// `"provider-generated"` (`server/auto-title.ts:88`).
    pub title_source: Option<String>,
    /// Task 18: the transcript-parsed git branch
    /// (`IndexedSession::git_branch` <- `ParsedSessionMeta::git_branch`,
    /// `freshell-sessions/src/meta.rs`) — the meta refresh folds it as the
    /// FALLBACK under the live-git branch (Node's `applySessionMetadata`:
    /// `session.gitBranch ?? current.branch`, `terminal-metadata-service.ts:195`,
    /// then live git wins in `enrichFromCwd`, `:283`).
    pub git_branch: Option<String>,
}

/// One of Node's two `terminal.title.updated` emit sites (the sweep push and
/// the AI-completion push both route through here) — no new WS message
/// types; the frame is the immutable `shared/ws-protocol.ts` shape.
pub fn emit_terminal_title_updated(
    tx: &tokio::sync::broadcast::Sender<String>,
    terminal_id: &str,
    title: &str,
) {
    use freshell_protocol::{ServerMessage, TerminalTitleUpdated};
    let msg = ServerMessage::TerminalTitleUpdated(TerminalTitleUpdated {
        terminal_id: terminal_id.to_string(),
        title: title.to_string(),
    });
    if let Ok(frame) = serde_json::to_string(&msg) {
        let _ = tx.send(frame);
    }
}

fn broadcast_sessions_changed(state: &AutoTitleSweepState) {
    // same shape sessions.rs:204-211 sends
    let rev = state
        .sessions_revision
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let _ = state
        .broadcast_tx
        .send(serde_json::json!({"type": "sessions.changed", "revision": rev}).to_string());
}

/// Milliseconds since the Unix epoch (the sweep's `Date.now()` analog).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Task 18: the sweep-time terminal-metadata refresh — Node's
/// `applySessionMetadata` pass (`server/index.ts:854-866` ->
/// `terminal-metadata-service.ts:183-201`), redesigned per validator-A7 (see
/// [`GitMetaCache`]): git enrichment runs once per UNIQUE resolved cwd across
/// the whole pass (change-gated + throttled), then each matched terminal's
/// record is rebuilt and committed change-gated.
///
/// Per (session, matched identity):
/// * `cwd` = [`freshell_ws::terminal_meta::select_more_specific_cwd`]
///   (identity.cwd, session.cwd) — the "deeper path wins" chooser
///   (`terminal-metadata-service.ts:63-76`);
/// * `branch` = live git > parsed-session `git_branch` > the record's current
///   value (`applySessionMetadata` `:195` + `enrichFromCwd` `:283`);
/// * a terminal the create path never seeded is skipped (Node: `if (!current)
///   return undefined`, `:184-185`).
///
/// Returns the changed records; the caller broadcasts ONE
/// `terminal.meta.updated` upsert batch per pass (`server/index.ts:861-863`).
async fn refresh_terminal_meta(
    state: &AutoTitleSweepState,
    work: &[(&SweepSession, Vec<TerminalIdentity>)],
) -> Vec<TerminalMetaRecord> {
    let now = now_ms();
    // Resolve each matched terminal's cwd, and collect the pass-wide
    // terminal-set per unique cwd (the git-run change gate's signature).
    let mut resolved: Vec<(&SweepSession, &TerminalIdentity, Option<String>)> = Vec::new();
    let mut cwd_terminals: HashMap<String, Vec<String>> = HashMap::new();
    for (session, matching) in work {
        for identity in matching {
            let cwd = freshell_ws::terminal_meta::select_more_specific_cwd(
                identity.cwd.as_deref(),
                session.cwd.as_deref(),
            );
            if let Some(cwd) = &cwd {
                cwd_terminals
                    .entry(cwd.clone())
                    .or_default()
                    .push(identity.terminal_id.clone());
            }
            resolved.push((session, identity, cwd));
        }
    }
    // One (gated) git enrichment per unique cwd.
    let mut enrichments: HashMap<String, CwdEnrichment> = HashMap::new();
    for (cwd, mut terminal_ids) in cwd_terminals {
        terminal_ids.sort();
        terminal_ids.dedup();
        let signature = terminal_ids.join("\n");
        let enrichment = state
            .git_meta_cache
            .enrichment_for(&cwd, &signature, now)
            .await;
        enrichments.insert(cwd, enrichment);
    }
    // Rebuild + commit each matched terminal's record, change-gated.
    let mut upserts = Vec::new();
    for (session, identity, cwd) in resolved {
        // Node applySessionMetadata:184-185 — no seeded record, no refresh.
        let Some(current) = state.terminal_meta.get(&identity.terminal_id) else {
            continue;
        };
        // A cwd-less terminal gets the falsy-cwd clear (enrichFromCwd :262-269).
        let enrichment = cwd
            .as_deref()
            .and_then(|c| enrichments.get(c))
            .cloned()
            .unwrap_or_default();
        let next = TerminalMetaRecord {
            terminal_id: current.terminal_id.clone(),
            updated_at: current.updated_at,
            provider: Some(session.provider.clone()),
            session_id: Some(session.session_id.clone()),
            cwd,
            branch: enrichment
                .branch
                .clone()
                .or_else(|| session.git_branch.clone())
                .or(current.branch),
            is_dirty: enrichment.is_dirty.or(current.is_dirty),
            checkout_root: enrichment.checkout_root.clone(),
            repo_root: enrichment.repo_root.clone(),
            display_subdir: enrichment.display_subdir.clone(),
            token_usage: current.token_usage,
        };
        if let Some(record) = state.terminal_meta.commit_if_changed(next, now_ms()) {
            upserts.push(record);
        }
    }
    upserts
}

/// One auto-name pass over `sessions` (`server/index.ts:877-950`). Returns
/// "anything changed" (an override write or a terminal push happened).
/// Every per-session failure is non-fatal: persistence errors are
/// best-effort (matching `patch_session_override`'s own contract) and AI
/// failures log a warning inside the one-shot task.
pub async fn run_auto_title_pass(state: &AutoTitleSweepState, sessions: &[SweepSession]) -> bool {
    use crate::auto_title::{compute_session_title_sync, SessionTerminal};
    let settings = state.settings.get().await; // hoisted, like server/index.ts:878
    let ai_will_auto_name = state.ai_key.enabled() && settings.sidebar.auto_generate_titles;
    let overrides = state.settings.session_overrides(); // freshness-reloading read
    let mut changed = false;

    // Match sessions to live terminals ONCE — both the meta refresh and the
    // title pass consume the same fan-out. BOUNDED to live terminals only
    // (server/index.ts:885); Node passes session.cwd for the cwd-scoped
    // claude match (index.ts:884, Task 3).
    let meta_work: Vec<(&SweepSession, Vec<TerminalIdentity>)> = sessions
        .iter()
        .filter_map(|s| {
            let matching =
                state
                    .identity
                    .find_all_by_session(&s.provider, &s.session_id, s.cwd.as_deref());
            (!matching.is_empty()).then_some((s, matching))
        })
        .collect();

    // Task 18: the pass-level meta refresh — BEFORE the title pass, matching
    // Node's source order (`server/index.ts:854` metadata sync kicks off
    // before the auto-name pass at `:877`), with ONE `terminal.meta.updated`
    // upsert batch per pass when anything changed (`:861-863`). Deliberately
    // does NOT count toward `changed`: Node's metadata sync never publishes
    // `sessions.changed` (only title/override changes do). Ordering also
    // keeps the tail of this function await-free after the AI one-shot
    // spawns, so a pass's persisted title state is deterministic when it
    // returns.
    let meta_upserts = refresh_terminal_meta(state, &meta_work).await;
    freshell_ws::terminal_meta::broadcast_terminal_meta_updated(
        &state.broadcast_tx,
        meta_upserts,
        Vec::new(),
    );

    for (s, matching) in &meta_work {
        let key = format!("{}:{}", s.provider, s.session_id);
        let row = overrides.get(&key).and_then(|v| v.as_object());
        let override_title = row
            .and_then(|r| r.get("titleOverride"))
            .and_then(|v| v.as_str());
        let override_source = row
            .and_then(|r| r.get("titleSource"))
            .and_then(|v| v.as_str());
        // current live titles come from the registry (DirectoryEntry.title)
        let terminals: Vec<SessionTerminal> = matching
            .iter()
            .map(|t| SessionTerminal {
                terminal_id: t.terminal_id.clone(),
                title: state.registry.title_of(&t.terminal_id),
            })
            .collect();
        let plan = compute_session_title_sync(
            s.title.as_deref(),
            override_title,
            override_source,
            s.cwd.as_deref(),
            s.first_user_message.as_deref(),
            ai_will_auto_name,
            s.title_source.as_deref(),
            &terminals,
        );
        if let Some(patch) = &plan.override_patch {
            let _ = state
                .settings
                .patch_session_override(
                    &key,
                    &[
                        (
                            "titleOverride",
                            Some(serde_json::json!(patch.title_override)),
                        ),
                        ("titleSource", Some(serde_json::json!(patch.title_source))),
                    ],
                )
                .await;
            changed = true;
        }
        if let Some(canon) = &plan.canonical_title {
            for tid in &plan.terminal_ids_to_update {
                state.registry.update_title(tid, canon);
                emit_terminal_title_updated(&state.broadcast_tx, tid, canon);
                changed = true;
            }
        }
        if plan.should_generate_ai {
            if let Some(first) = s.first_user_message.clone() {
                let should_spawn = {
                    let mut pending = state.pending_ai_titles.lock().expect("pending lock");
                    pending.insert(key.clone()) // false when already in flight
                };
                if should_spawn {
                    spawn_ai_title_task(
                        state,
                        key.clone(),
                        s.provider.clone(),
                        s.session_id.clone(),
                        s.cwd.clone(),
                        first,
                        settings.ai.title_prompt.clone(),
                    );
                }
            }
        }
    }
    if changed {
        broadcast_sessions_changed(state);
    }
    changed
}

/// The Gemini one-shot (port of `server/index.ts:914-938`): generate, persist
/// `titleSource:'ai'` through the ladder, re-push + re-broadcast to the live
/// terminals, refresh the sidebar (`sessions.changed`). ALWAYS clears the
/// pending-set entry — success, empty result, or failure alike.
fn spawn_ai_title_task(
    state: &AutoTitleSweepState,
    key: String,
    provider: String,
    session_id: String,
    cwd: Option<String>,
    first_message: String,
    title_prompt: Option<String>,
) {
    let settings = state.settings.clone();
    let identity = state.identity.clone();
    let registry = state.registry.clone();
    let broadcast_tx = state.broadcast_tx.clone();
    let sessions_revision = state.sessions_revision.clone();
    let gemini = state.gemini.clone();
    let pending = state.pending_ai_titles.clone();
    tokio::spawn(async move {
        let result = crate::ai_title::generate_ai_session_title(
            &*gemini,
            &first_message,
            title_prompt.as_deref(),
        )
        .await;
        match result {
            Ok(Some(title)) => {
                let _ = settings
                    .patch_session_override(
                        &key,
                        &[
                            ("titleOverride", Some(serde_json::json!(title))),
                            ("titleSource", Some(serde_json::json!("ai"))),
                        ],
                    )
                    .await;
                // Node's AI completion re-fans-out with session.cwd too
                // (server/index.ts:914-938 uses the same cwd-scoped lookup).
                for term in identity.find_all_by_session(&provider, &session_id, cwd.as_deref()) {
                    registry.update_title(&term.terminal_id, &title);
                    emit_terminal_title_updated(&broadcast_tx, &term.terminal_id, &title);
                }
                // Node: codingCliIndexer.refresh() -> sessionsSync publish.
                let rev = sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let _ = broadcast_tx.send(
                    serde_json::json!({"type": "sessions.changed", "revision": rev}).to_string(),
                );
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, key = %key, "Gemini auto-title failed"),
        }
        pending.lock().expect("pending lock").remove(&key);
    });
}

/// The sweep's per-session title overlay -- the override-applied display
/// title fed to [`SweepSession::title`] (and from there to
/// `compute_session_title_sync`'s `session_title` input / the canonical-title
/// push). Node parity: the sweep's `sessionTitle` input is the already-
/// `applyOverride`'d session title (`auto-title.ts:52-54`), so this mirrors
/// `applyOverride`'s title clause (`session-indexer.ts:210-214`).
///
/// NOTE the scope: this guards ONLY the display/push title.
/// [`run_auto_title_pass`] still reads the RAW override row for
/// `compute_session_title_sync`'s `override_title`/`override_source` inputs
/// (write-side rung gating) -- if the sweep saw a suppressed row as absent
/// it would re-patch every tick (a config write storm Node does not have).
fn overlay_session_title(
    overrides: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    parsed_title: Option<&str>,
    parsed_title_source: Option<&str>,
) -> Option<String> {
    let row = overrides.get(key);
    // Node's applyOverride guard (`session-indexer.ts:210-214`): the override
    // title applies iff it is NON-EMPTY (JS `!!`) AND NOT (the PARSED source
    // is 'provider-generated' AND the row's `titleSource` is exactly
    // 'dir'/'first-message', strict `===` -- 'ai'/'user'/absent/any-other row
    // source still applies).
    let row_source = row
        .and_then(|r| r.get("titleSource"))
        .and_then(|v| v.as_str());
    let provider_generated_shadow = parsed_title_source == Some("provider-generated")
        && matches!(row_source, Some("dir") | Some("first-message"));
    row.and_then(|r| r.get("titleOverride"))
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty() && !provider_generated_shadow)
        .map(str::to_string)
        .or_else(|| parsed_title.map(str::to_string))
}

/// The background loop — same shape as `spawn_sessions_sweep` (main.rs):
/// `tokio::time::interval` with `MissedTickBehavior::Skip`; per tick,
/// snapshot the index with the SAME accessor (`SessionIndex::snapshot`),
/// map `IndexedSession` -> [`SweepSession`] (the `title` is the
/// OVERRIDE-APPLIED title via [`overlay_session_title`], which mirrors
/// `applyOverride`'s provider-generated suppression), then
/// [`run_auto_title_pass`].
pub fn spawn_auto_title_sweep(
    state: AutoTitleSweepState,
    index: Arc<freshell_sessions::directory_index::SessionIndex>,
    interval: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let items = index.snapshot().await;
            let overrides = state.settings.session_overrides();
            let sessions: Vec<SweepSession> = items
                .iter()
                .map(|s| {
                    let key = s.key();
                    let title = overlay_session_title(
                        &overrides,
                        &key,
                        s.title.as_deref(),
                        s.title_source.as_deref(),
                    );
                    SweepSession {
                        provider: s.provider.clone(),
                        session_id: s.session_id.clone(),
                        cwd: s.cwd.clone(),
                        title,
                        first_user_message: s.first_user_message.clone(),
                        title_source: s.title_source.clone(),
                        git_branch: s.git_branch.clone(),
                    }
                })
                .collect();
            run_auto_title_pass(&state, &sessions).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Registers a REAL (but throwaway) terminal in the shared
    /// `TerminalRegistry` so the canonical-title push
    /// (`registry.update_title`) has an actual entry to mutate. Copied from
    /// `sessions.rs`'s module-private helper of the same name (its doc
    /// explains why a minimal `sleep` child substitutes for the
    /// crate-private `insert_headless`).
    fn spawn_headless_terminal_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
    ) {
        use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 5".into()],
            env_overrides: Default::default(),
            cwd: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        };
        registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                terminal_id.to_string(),
                "stream-test".to_string(),
                "shell",
                None,
                None,
                None,
                None,
            )
            .expect("spawn headless test terminal");
    }

    fn sweep_state(
        dir: &std::path::Path,
        ai_key: Option<&str>,
    ) -> (
        AutoTitleSweepState,
        tokio::sync::broadcast::Receiver<String>,
    ) {
        let settings = crate::settings_store::SettingsStore::load(Some(dir), vec![]);
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = AutoTitleSweepState {
            settings,
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            ai_key: crate::ai_title::AiKeyCell::init(ai_key.map(str::to_string), None),
            gemini: std::sync::Arc::new(FakeGemini(Ok("AI Title".into()))),
            pending_ai_titles: Default::default(),
            terminal_meta: Default::default(),
            git_meta_cache: Default::default(),
        };
        (state, rx)
    }
    struct FakeGemini(Result<String, String>);
    impl crate::ai_title::GeminiTransport for FakeGemini {
        fn generate_content(
            &self,
            _p: String,
            _m: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }
    fn session(provider: &str, id: &str, cwd: &str, first: Option<&str>) -> SweepSession {
        SweepSession {
            provider: provider.into(),
            session_id: id.into(),
            cwd: Some(cwd.into()),
            title: None,
            first_user_message: first.map(str::to_string),
            title_source: None,
            git_branch: None,
        }
    }

    // -- Task 5b: the provider-generated read-guard on the SweepSession
    // title overlay (`applyOverride`, `session-indexer.ts:204-220`) --------

    #[test]
    fn provider_generated_session_keeps_parsed_title_over_dir_override_row_in_overlay() {
        // The mapping that feeds run_auto_title_pass must NOT drive the
        // canonical-push input to the dir basename for a provider-generated
        // session: the parsed provider title stands.
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "amplifier:s1".into(),
            json!({ "titleOverride": "proj", "titleSource": "dir" }),
        );
        let title = overlay_session_title(
            &overrides,
            "amplifier:s1",
            Some("Provider Title"),
            Some("provider-generated"),
        );
        assert_eq!(title.as_deref(), Some("Provider Title"));
    }

    #[test]
    fn overlay_applies_dir_override_row_for_non_provider_generated_session() {
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:s1".into(),
            json!({ "titleOverride": "proj", "titleSource": "dir" }),
        );
        let title = overlay_session_title(&overrides, "claude:s1", Some("parsed"), None);
        assert_eq!(title.as_deref(), Some("proj"));
    }

    #[test]
    fn overlay_never_applies_empty_string_override() {
        // Node `!!ov?.titleOverride`: '' is falsy, for ANY session.
        let mut overrides = serde_json::Map::new();
        overrides.insert("claude:s1".into(), json!({ "titleOverride": "" }));
        let title = overlay_session_title(&overrides, "claude:s1", Some("parsed"), None);
        assert_eq!(title.as_deref(), Some("parsed"));
    }

    #[tokio::test]
    async fn session_without_live_terminal_is_skipped_entirely() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), None);
        let changed =
            run_auto_title_pass(&state, &[session("claude", "s1", "/x/proj", Some("hi"))]).await;
        assert!(!changed);
        assert!(state
            .settings
            .session_overrides()
            .get("claude:s1")
            .is_none());
    }

    #[tokio::test]
    async fn no_key_first_message_finalizes_and_pushes_terminal_title_with_broadcast() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        let changed = run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s1",
                "/x/proj",
                Some("Fix the flux\nrest"),
            )],
        )
        .await;
        assert!(changed);
        let ov = state.settings.session_overrides();
        let row = ov.get("claude:s1").unwrap();
        assert_eq!(row["titleOverride"], "Fix the flux");
        assert_eq!(row["titleSource"], "first-message");
        // terminal push + broadcast frame
        let mut saw_title_updated = false;
        let mut saw_sessions_changed = false;
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if v["type"] == "terminal.title.updated" {
                assert_eq!(v["terminalId"], json!(tid));
                assert_eq!(v["title"], "Fix the flux");
                saw_title_updated = true;
            }
            if v["type"] == "sessions.changed" {
                saw_sessions_changed = true;
            }
        }
        assert!(saw_title_updated && saw_sessions_changed);
    }

    #[tokio::test]
    async fn ai_enabled_holds_dir_then_finalizes_ai_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        let s = [session("claude", "s1", "/x/proj", Some("Fix the flux"))];
        run_auto_title_pass(&state, &s).await;
        // pass 1: dir placeholder persisted (never first-message when AI on)
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "dir");
        // AI one-shot lands asynchronously; wait for it
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state
                .settings
                .session_overrides()
                .get("claude:s1")
                .cloned()
                .unwrap();
            if row["titleSource"] == "ai" {
                break;
            }
        }
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "AI Title");
        assert_eq!(row["titleSource"], "ai");
        // a second pass with the AI title already finalized changes nothing
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn user_rename_is_never_clobbered_and_sweep_pushes_it_to_stale_terminals() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        state
            .settings
            .patch_session_override(
                "claude:s1",
                &[
                    ("titleOverride", Some(json!("My Name"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let mut s = session("claude", "s1", "/x/proj", Some("hi"));
        s.title = Some("My Name".into()); // override-applied session title
        run_auto_title_pass(&state, &[s]).await;
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "My Name"); // untouched
                                                     // canonical push to the stale terminal still happens
        let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(frames
            .iter()
            .any(|f| f.contains("terminal.title.updated") && f.contains("My Name")));
    }

    /// Task 18: the sweep-time meta refresh (Node's `applySessionMetadata`
    /// analog) commits a git-enriched, session-folded record and broadcasts
    /// ONE `terminal.meta.updated` upsert — and a second, unchanged pass is
    /// fully suppressed (change-gated commit + cached cwd enrichment).
    #[tokio::test]
    async fn sweep_refreshes_terminal_meta_change_gated_and_broadcasts_once() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let cwd_dir = tempfile::tempdir().unwrap(); // non-repo cwd
        let cwd = cwd_dir.path().to_string_lossy().into_owned();
        let tid = "term-meta-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("codex"), Some("s1"), Some(&cwd), 1);
        // The create path's seeded record (the refresh skips unseeded
        // terminals — applySessionMetadata :184-185).
        state
            .terminal_meta
            .commit_if_changed(
                freshell_protocol::common::TerminalMetaRecord {
                    terminal_id: tid.to_string(),
                    updated_at: 0,
                    branch: None,
                    checkout_root: None,
                    cwd: Some(cwd.clone()),
                    display_subdir: None,
                    is_dirty: None,
                    provider: Some("codex".to_string()),
                    repo_root: None,
                    session_id: None,
                    token_usage: None,
                },
                1,
            )
            .expect("seed commit");

        let mut s = session("codex", "s1", &cwd, Some("hi"));
        s.git_branch = Some("parsed-branch".to_string());
        run_auto_title_pass(&state, std::slice::from_ref(&s)).await;

        // Pass 1: exactly one terminal.meta.updated upsert, enriched +
        // session-folded. Live git yields nothing for a non-repo dir, so the
        // parsed-session branch fallback lands; the roots resolve to the cwd
        // itself and displaySubdir to its basename.
        let mut meta_frames: Vec<serde_json::Value> = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if v["type"] == "terminal.meta.updated" {
                meta_frames.push(v);
            }
        }
        assert_eq!(
            meta_frames.len(),
            1,
            "one upsert batch per pass: {meta_frames:?}"
        );
        let upsert = &meta_frames[0]["upsert"][0];
        assert_eq!(upsert["terminalId"], serde_json::json!(tid));
        assert_eq!(upsert["sessionId"], serde_json::json!("s1"));
        assert_eq!(upsert["provider"], serde_json::json!("codex"));
        assert_eq!(upsert["branch"], serde_json::json!("parsed-branch"));
        assert_eq!(upsert["checkoutRoot"], serde_json::json!(cwd));
        assert_eq!(upsert["repoRoot"], serde_json::json!(cwd));
        assert_eq!(
            upsert["displaySubdir"],
            serde_json::json!(cwd_dir.path().file_name().unwrap().to_string_lossy())
        );
        assert_eq!(meta_frames[0]["remove"], serde_json::json!([]));

        // Pass 2 with identical inputs: the commit gate suppresses the record
        // and NO terminal.meta.updated frame goes out.
        run_auto_title_pass(&state, std::slice::from_ref(&s)).await;
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(
                v["type"],
                serde_json::json!("terminal.meta.updated"),
                "an unchanged pass must not re-broadcast: {v}"
            );
        }
    }

    /// Final-gate regression (title-sync-convergence Test 3, automation-rename
    /// vs sweep race): a `PATCH /api/panes/:id` rename cascade that lands
    /// BEFORE the sweep has finalized the session must survive the next
    /// auto-title pass. The cascade goes through the REAL
    /// `crate::SettingsRenamePersistence` seam (what `main.rs` injects into
    /// `freshell-freshagent`); if that write leaves the ladder rung
    /// unfinalized (plain `{titleOverride}`, Node `router.ts:679-681`), the
    /// next pass sees a non-finalized source, computes the first-message
    /// patch, and STEALS the user's rename (override + registry + a stale
    /// `terminal.title.updated` push) — permanently, because every later pass
    /// then sees registry == override. The rename is a USER action, so the
    /// cascade must finalize `titleSource:'user'` (EDEV-10).
    #[tokio::test]
    async fn pane_rename_cascade_before_finalization_survives_next_sweep_pass() {
        use freshell_freshagent::RenamePersistence;
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);

        // The PATCH /api/panes/:id cascade, exactly as rename_persistence.rs
        // runs it against the live seam: session-override write + registry
        // write-through (`persist_syncable_terminal_rename`).
        let persistence = crate::SettingsRenamePersistence(state.settings.clone());
        persistence
            .patch_session_override_title("claude:s1", "Automation Name Three")
            .await;
        state.registry.update_title(tid, "Automation Name Three");

        // Next sweep tick: the session is still unfinalized index-side, its
        // first message present, AI off (the exact Test 3 conditions).
        let mut s = session(
            "claude",
            "s1",
            "/x/proj",
            Some("convergence gamma automation rename journey"),
        );
        s.title = Some("Automation Name Three".into()); // override-applied
        run_auto_title_pass(&state, &[s]).await;

        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(
            row["titleOverride"], "Automation Name Three",
            "the sweep must never steal a user rename that landed before finalization: {row}"
        );
        assert_eq!(
            state.registry.title_of(tid).as_deref(),
            Some("Automation Name Three"),
            "no stale registry overwrite"
        );
        let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(
            !frames.iter().any(|f| f.contains("convergence gamma")),
            "no stale first-message push after the rename: {frames:?}"
        );
    }

    #[tokio::test]
    async fn autogenerate_titles_off_disables_ai_but_keeps_heuristics() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        state
            .settings
            .patch(&json!({"sidebar": {"autoGenerateTitles": false}}))
            .await
            .unwrap();
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        run_auto_title_pass(
            &state,
            &[session("claude", "s1", "/x/proj", Some("Fix it"))],
        )
        .await;
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "first-message"); // heuristic path, no Gemini
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }
}
