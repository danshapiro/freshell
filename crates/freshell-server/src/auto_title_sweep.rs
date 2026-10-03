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

use freshell_freshagent::naming::SessionNaming;
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
    pub auth: crate::ai_title::GeminiSessionNameAuth,
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
    /// Unified agent names (Task 4): the ONE naming authority for scoped
    /// coding-agent sessions (claude/codex/opencode). `None` leaves the
    /// scoped branch degraded (no naming feed — the same degraded no-home
    /// policy as everywhere else); the legacy ladder below then still
    /// EXCLUDES scoped providers (never a competing settings title).
    pub names: Option<Arc<crate::session_names::SessionNames>>,
    /// Unified agent names (Task 4, review I3): the server's session
    /// metadata store (`session-metadata.json`) — the discriminator the
    /// naming plan names: a listing row whose known type is `kilroy` is a
    /// Kilroy-only session (kilroy shares the Claude runtime, so its
    /// transcripts list under provider `claude`) and never enters the
    /// naming authority or the generator merely because its provider is
    /// claude; it KEEPS the legacy ladder below. Cheap Arc/Mutex JSON —
    /// the pass batch-reads the scoped rows' types once.
    pub metadata: crate::session_metadata::SessionMetadataStore,
    /// Task 4: the shared session index, consulted for the targeted
    /// opencode first-message lookup (already-named opencode sessions carry
    /// no first message in the bounded listing).
    pub index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
    /// Task 4: whether the initial index hydration pass has run. The boot
    /// snapshot installs free fallback records and ABSORBS observed
    /// messages (no paid titles across history); later passes feed activity
    /// so genuinely newly observed messages arm generation.
    pub index_hydrated: Arc<std::sync::atomic::AtomicBool>,
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

/// The sweep's session key (`provider:sessionId`) — the same shape the
/// metadata store's `get_all()` flattens to.
fn sweep_session_key(provider: &str, session_id: &str) -> String {
    format!("{provider}:{session_id}")
}

/// Unified agent names (Task 4, review I3; generalized by delta-review
/// round 4, finding 1): the pass's KILROY-ONLY sessions, answered by the
/// ONE shared seam ([`crate::kilroy_lane`]) every server surface consults —
/// a session is kilroy-only iff the metadata store types it `kilroy` AND
/// the naming authority holds no canonical record for it AND no live
/// terminal runs it in a scoped mode. Kilroy shares the Claude runtime, so
/// its transcripts list under provider `claude`; a kilroy-only session
/// never enters the naming authority or the generator merely because its
/// provider is claude — it KEEPS the legacy ladder (the Global Constraint:
/// kilroy retains its existing UI and generation behavior). The
/// singular-record component is the Global Constraint's other half: a
/// durable session opened BOTH as kilroy and through a supported mode has
/// ONE canonical name — the supported-mode record owns it (never a
/// competing kilroy record), so a kilroy-typed row that already holds a
/// canonical record stays in the authority lane and the legacy ladder
/// never writes it a competing settings title.
async fn kilroy_only_session_keys(
    state: &AutoTitleSweepState,
    sessions: &[SweepSession],
) -> HashSet<String> {
    let has_scoped = sessions.iter().any(|s| {
        freshell_freshagent::naming::named_provider_for(Some(&s.provider), None).is_some()
    });
    if !has_scoped {
        return HashSet::new();
    }
    // One metadata read per pass (cheap Arc/Mutex JSON — cached after the
    // first load, shared with the POST route), then the shared predicate.
    let entries = state.metadata.get_all().await;
    let candidates: Vec<crate::kilroy_lane::KilroyLaneCandidate> = sessions
        .iter()
        .filter(|s| {
            freshell_freshagent::naming::named_provider_for(Some(&s.provider), None).is_some()
        })
        .map(|s| crate::kilroy_lane::KilroyLaneCandidate {
            provider: s.provider.clone(),
            session_id: s.session_id.clone(),
            cwd: s.cwd.clone(),
        })
        .collect();
    let naming = state
        .names
        .clone()
        .map(|names| names as Arc<dyn SessionNaming>);
    crate::kilroy_lane::kilroy_only_keys(
        &entries,
        naming.as_ref(),
        &state.identity,
        Some(&state.registry),
        &candidates,
    )
    .await
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
    let ai_will_auto_name = state.auth.enabled() && settings.sidebar.auto_generate_titles;
    let overrides = state.settings.session_overrides(); // freshness-reloading read
    let mut changed = false;

    // Unified agent names (Task 4, review I3): the kilroy-only rows for
    // this pass — computed once, consulted by BOTH the scoped branch
    // below (never hydrate/arm them) and the legacy-ladder gate (never
    // strip their ladder).
    let kilroy_only = kilroy_only_session_keys(state, sessions).await;

    // Unified agent names (Task 4): scoped coding-agent sessions (the six
    // unified modes' CLI half — claude/codex/opencode, which is also where
    // resumed fresh sessions' transcripts surface) route to the ONE naming
    // authority. The BOOT pass hydrates free fallback records and absorbs
    // observed messages (never a paid title across history); later passes
    // feed activity so a genuinely newly observed message arms generation —
    // no live PTY or browser is required. A session explicitly open at boot
    // (a live terminal match) gets its observed message armed too. Nothing
    // here touches the settings ladder: a scoped session never acquires a
    // competing settings title.
    if let Some(names) = &state.names {
        let hydrating = !state
            .index_hydrated
            .swap(true, std::sync::atomic::Ordering::SeqCst);
        // Delta-review round 3, finding 2 — the per-pass settled memo:
        // sessions this pass already PROVED settled on the adopted view
        // (both store pre-checks answered no-op) never re-evaluate, so a
        // repeated row in one pass costs nothing. Cleared every pass — a
        // later pass re-proves against the (refreshed) view, so foreign
        // changes always resurface through the existing refresh discipline.
        let mut settled_this_pass: HashSet<String> = HashSet::new();
        for s in sessions {
            let Some(provider) =
                freshell_freshagent::naming::named_provider_for(Some(&s.provider), None)
            else {
                continue;
            };
            let session_key = sweep_session_key(&s.provider, &s.session_id);
            if kilroy_only.contains(&session_key) {
                // A kilroy-only session keeps kilroy's existing UI and
                // generation behavior: no naming-authority record, no
                // generator arming — the legacy ladder below serves it.
                continue;
            }
            if settled_this_pass.contains(&session_key) {
                // Proven settled earlier in THIS pass: no transaction, no
                // targeted lookup, no re-evaluation.
                continue;
            }
            let target = freshell_protocol::SessionNameRef::Session {
                provider,
                session_id: s.session_id.clone(),
            };
            // OpenCode already-named sessions carry no first message in the
            // bounded listing: the targeted lookup serves eligibility, but
            // only while the session's generation can still use input (an
            // exhausted or protected session never pays the read again).
            let first_user_message = match s.first_user_message.clone() {
                Some(message) => Some(message),
                None => {
                    if provider == freshell_protocol::session_names::NamedProvider::Opencode
                        && names.needs_generation_input(&target)
                    {
                        if let Some(index) = state.index.clone() {
                            let session_id = s.session_id.clone();
                            tokio::task::spawn_blocking(move || {
                                index.opencode_first_user_message(&session_id)
                            })
                            .await
                            .ok()
                            .flatten()
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
            };
            let provider_title = if s.title_source.as_deref() == Some("provider-generated") {
                s.title.clone()
            } else {
                None
            };
            // An explicitly open session (a live terminal match) at boot is
            // the user opening it: hydration must NOT absorb the observed
            // message (the explicit-open activity below arms generation).
            let explicitly_open = !state
                .identity
                .find_all_by_session(&s.provider, &s.session_id, s.cwd.as_deref())
                .is_empty();
            let input = crate::session_name_generation::IndexedNameInput {
                provider,
                session_id: s.session_id.clone(),
                cwd: s.cwd.clone(),
                first_user_message: first_user_message.clone(),
                provider_title,
            };
            // Delta-review round 3, finding 2 — the adopted-view pre-checks:
            // a settled session (hydrated record, absorbed/duplicate message,
            // no pending work) must not pay a strict cross-process store
            // transaction per pass. `hydrate_indexed_pending`/
            // `activity_pending` prove the no-op from the in-memory view
            // (the same plan the transaction applies); a stale view can only
            // make the pre-check transact unnecessarily, never skip real
            // work — the store's own doc comments carry the full argument.
            let mut transacted = false;
            if names.hydrate_indexed_pending(&input) {
                transacted = true;
                if let Err(error) = names
                    .hydrate_indexed(input.clone(), hydrating && !explicitly_open)
                    .await
                {
                    freshell_freshagent::naming::log_name_error("hydrate_indexed", &target, &error);
                }
            }
            // The boot pass arms only explicitly open sessions; every later
            // pass feeds the newly observed message (the store's
            // fingerprint absorbs duplicates, and an explicitly open
            // session's Opened edge arms its absorbed unattempted
            // series — the plan's "explicit open/resume may arm an
            // unattempted series if a first user message exists").
            let mut activity = None;
            if first_user_message.is_some() && (!hydrating || explicitly_open) {
                activity = Some(freshell_freshagent::naming::NameActivity {
                    target: target.clone(),
                    mode: s.provider.clone(),
                    event_id: format!("{}:{}", s.provider, s.session_id),
                    reason: if explicitly_open {
                        freshell_freshagent::naming::NameActivityReason::Opened
                    } else {
                        freshell_freshagent::naming::NameActivityReason::IndexUserMessage
                    },
                    first_user_message,
                    cwd: s.cwd.clone(),
                });
            }
            if let Some(activity) = activity {
                // Re-checked AFTER the hydrate above: a boot-pass hydration
                // that just created/absorbed makes this a provable no-op on
                // the now-current view (no duplicate arming transaction).
                if names.activity_pending(&activity) {
                    transacted = true;
                    if let Err(error) = names.activity(activity).await {
                        freshell_freshagent::naming::log_name_error("activity", &target, &error);
                    }
                }
            }
            if !transacted {
                // Proven settled on the adopted view: memo so a repeated row
                // later in THIS pass never re-evaluates.
                settled_this_pass.insert(session_key);
            }
        }
    }

    // Match sessions to live terminals ONCE — both the meta refresh and the
    // title pass consume the same fan-out. BOUNDED to live terminals only
    // (server/index.ts:885); Node passes session.cwd for the cwd-scoped
    // claude match (index.ts:884, Task 3). The meta refresh below serves
    // EVERY provider (git metadata is provider-agnostic); only the legacy
    // TITLE ladder excludes scoped coding-agent sessions.
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
        // The legacy title ladder is the EXCLUDED-provider path: scoped
        // coding-agent sessions never write a competing settings title
        // (their naming lives in the authority above) — EXCEPT the
        // kilroy-only rows, which keep kilroy's existing ladder (review
        // I3: the metadata-blind sweep here is what stripped it).
        if freshell_freshagent::naming::named_provider_for(Some(&s.provider), None).is_some()
            && !kilroy_only.contains(&key)
        {
            continue;
        }
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

/// The background loop — subscribes to `SessionIndex::subscribe_changes()`
/// notifications (fed by the SessionWatcher's inotify events) and runs the
/// auto-title pass on each change. Throttled to at most once per 5s to
/// avoid hammering the Gemini API during rapid file activity. Also wakes
/// periodically (every 5s) to catch non-index-driven changes like terminal
/// identity updates and settings changes.
///
/// The `_interval` parameter is kept for API compatibility but ignored;
/// the sweep's cadence is now driven by change notifications + the 5s
/// minimum interval.
pub fn spawn_auto_title_sweep(
    state: AutoTitleSweepState,
    index: Arc<freshell_sessions::directory_index::SessionIndex>,
    _interval: std::time::Duration, // kept for API compat
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = index.subscribe_changes();
        // Minimum interval between auto-title passes. 5s balances
        // responsiveness (terminal identity changes, settings) against
        // API rate pressure (Gemini title generation).
        let min_interval = std::time::Duration::from_secs(5);
        let mut last_run = tokio::time::Instant::now() - min_interval;

        loop {
            // Wait for either a change notification or the minimum interval.
            tokio::select! {
                result = rx.changed() => {
                    if result.is_err() {
                        break;
                    }
                }
                _ = tokio::time::sleep(min_interval) => {}
            }

            // Throttle: don't run more often than min_interval.
            let elapsed = last_run.elapsed();
            if elapsed < min_interval {
                tokio::time::sleep(min_interval - elapsed).await;
            }

            last_run = tokio::time::Instant::now();
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
    use freshell_freshagent::naming::SessionNaming;
    use serde_json::json;

    /// Registers a REAL (but throwaway) terminal in the shared
    /// `TerminalRegistry` so the canonical-title push
    /// (`registry.update_title`) has an actual entry to mutate. Copied from
    /// `sessions.rs`'s module-private helper of the same name (its doc
    /// explains why a minimal `sleep` child substitutes for the
    /// crate-private `insert_headless`). The registry row's MODE defaults
    /// to `"shell"`; [`spawn_headless_terminal_with_mode_for_test`] stamps
    /// a different one (review I3's scoped-mode proxy).
    fn spawn_headless_terminal_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
    ) {
        spawn_headless_terminal_with_mode_for_test(registry, terminal_id, "shell");
    }

    /// The mode-stamping variant of [`spawn_headless_terminal_for_test`] —
    /// review I3's singular-record proxy reads the live terminal's mode.
    fn spawn_headless_terminal_with_mode_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
        mode: &str,
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
                mode,
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
        sweep_state_with(dir, ai_key, None, None)
    }

    fn sweep_state_with(
        dir: &std::path::Path,
        ai_key: Option<&str>,
        names: Option<Arc<crate::session_names::SessionNames>>,
        index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
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
            auth: crate::ai_title::GeminiSessionNameAuth::direct_for_test(
                crate::ai_title::AiKeyCell::init(ai_key.map(str::to_string), None),
            ),
            gemini: std::sync::Arc::new(FakeGemini(Ok("AI Title".into()))),
            pending_ai_titles: Default::default(),
            terminal_meta: Default::default(),
            git_meta_cache: Default::default(),
            names,
            metadata: crate::session_metadata::SessionMetadataStore::new(dir),
            index,
            index_hydrated: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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

    #[test]
    fn opencode_ai_override_row_wins_over_late_provider_title() {
        // Ladder: ai > provider-generated. A Gemini title freshell already
        // wrote is NOT clobbered when opencode later names the session
        // (the shadow guard only suppresses dir/first-message rows).
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "opencode:s1".into(),
            json!({ "titleOverride": "Gemini Title", "titleSource": "ai" }),
        );
        let title = overlay_session_title(
            &overrides,
            "opencode:s1",
            Some("Opencode Title"),
            Some("provider-generated"),
        );
        assert_eq!(title.as_deref(), Some("Gemini Title"));
    }

    #[tokio::test]
    async fn session_without_live_terminal_is_skipped_entirely() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), None);
        let changed =
            run_auto_title_pass(&state, &[session("amplifier", "s1", "/x/proj", Some("hi"))]).await;
        assert!(!changed);
        assert!(state
            .settings
            .session_overrides()
            .get("amplifier:s1")
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
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);
        let changed = run_auto_title_pass(
            &state,
            &[session(
                "amplifier",
                "s1",
                "/x/proj",
                Some("Fix the flux\nrest"),
            )],
        )
        .await;
        assert!(changed);
        let ov = state.settings.session_overrides();
        let row = ov.get("amplifier:s1").unwrap();
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
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);
        let s = [session("amplifier", "s1", "/x/proj", Some("Fix the flux"))];
        run_auto_title_pass(&state, &s).await;
        // pass 1: dir placeholder persisted (never first-message when AI on)
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "dir");
        // AI one-shot lands asynchronously; wait for it
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state
                .settings
                .session_overrides()
                .get("amplifier:s1")
                .cloned()
                .unwrap();
            if row["titleSource"] == "ai" {
                break;
            }
        }
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
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
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);
        state
            .settings
            .patch_session_override(
                "amplifier:s1",
                &[
                    ("titleOverride", Some(json!("My Name"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let mut s = session("amplifier", "s1", "/x/proj", Some("hi"));
        s.title = Some("My Name".into()); // override-applied session title
        run_auto_title_pass(&state, &[s]).await;
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
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
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);
        run_auto_title_pass(
            &state,
            &[session("amplifier", "s1", "/x/proj", Some("Fix it"))],
        )
        .await;
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "first-message"); // heuristic path, no Gemini
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    // -- opencode auto-title ladder (docs/plans/2026-08-10-opencode-auto-titles.md,
    // Task 4): sweep-level pins for the opencode reconciliation semantics ----

    #[tokio::test]
    async fn opencode_first_message_holds_dir_then_finalizes_ai() {
        // Gap A regression (docs/plans/2026-08-10-opencode-auto-titles.md):
        // an opencode session with a first user message must reach the
        // Gemini stage instead of holding the dir placeholder forever.
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/glowforge"), 1);
        let s = [session(
            "amplifier",
            "s1",
            "/x/glowforge",
            Some("This is a quick naming test"),
        )];
        run_auto_title_pass(&state, &s).await;
        // pass 1: dir placeholder persisted (never first-message when AI on)
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "dir");
        // AI one-shot lands asynchronously; wait for it
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state
                .settings
                .session_overrides()
                .get("amplifier:s1")
                .cloned()
                .unwrap();
            if row["titleSource"] == "ai" {
                break;
            }
        }
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "AI Title");
        assert_eq!(row["titleSource"], "ai");
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn opencode_provider_named_session_short_circuits_ai() {
        // Gap B: a session opencode already named must surface that name
        // and never spawn Gemini -- even when a first message is present
        // (should_generate_ai's provider-generated conjunct).
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);
        for _pass in 0..2 {
            // mirror spawn_auto_title_sweep's mapping: title is overlay-applied
            let overrides = state.settings.session_overrides();
            let title = overlay_session_title(
                &overrides,
                "amplifier:s1",
                Some("Fix login flow"),
                Some("provider-generated"),
            );
            let mut s = session("amplifier", "s1", "/x/proj", Some("hello"));
            s.title = title;
            s.title_source = Some("provider-generated".into());
            run_auto_title_pass(&state, &[s]).await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // no Gemini: nothing pending, no ai row (a dir row is claude-parity
        // behavior for provider-generated sessions and is shadow-suppressed)
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
        if let Some(row) = state.settings.session_overrides().get("amplifier:s1") {
            assert_ne!(row["titleSource"], "ai");
        }
        // the provider name is what lands on the live terminal
        assert_eq!(
            state.registry.title_of(tid).as_deref(),
            Some("Fix login flow")
        );
    }

    #[tokio::test]
    async fn opencode_stale_dir_override_yields_to_late_provider_title() {
        // The live-bug state: a dir placeholder row already persisted
        // (written while the session was unnamed) must not shadow
        // opencode's own retitle once it lands.
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/glowforge"), 1);
        state
            .settings
            .patch_session_override(
                "amplifier:s1",
                &[
                    ("titleOverride", Some(json!("glowforge"))),
                    ("titleSource", Some(json!("dir"))),
                ],
            )
            .await;
        let overrides = state.settings.session_overrides();
        let title = overlay_session_title(
            &overrides,
            "amplifier:s1",
            Some("Quick naming test"),
            Some("provider-generated"),
        );
        // shadow guard: the stale dir row loses to the provider title
        assert_eq!(title.as_deref(), Some("Quick naming test"));
        let mut s = session("amplifier", "s1", "/x/glowforge", None);
        s.title = title;
        s.title_source = Some("provider-generated".into());
        run_auto_title_pass(&state, &[s]).await;
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
        assert_eq!(
            state.registry.title_of(tid).as_deref(),
            Some("Quick naming test")
        );
    }

    #[tokio::test]
    async fn opencode_user_rename_wins_over_provider_title_and_ai() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);
        state
            .settings
            .patch_session_override(
                "amplifier:s1",
                &[
                    ("titleOverride", Some(json!("My Name"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let overrides = state.settings.session_overrides();
        let title = overlay_session_title(
            &overrides,
            "amplifier:s1",
            Some("Provider Title"),
            Some("provider-generated"),
        );
        // user rows are never shadowed
        assert_eq!(title.as_deref(), Some("My Name"));
        let mut s = session("amplifier", "s1", "/x/proj", Some("hello"));
        s.title = title;
        s.title_source = Some("provider-generated".into());
        run_auto_title_pass(&state, &[s]).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let row = state
            .settings
            .session_overrides()
            .get("amplifier:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "My Name");
        assert_eq!(row["titleSource"], "user");
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn opencode_fixture_db_end_to_end_dir_then_ai() {
        // Acceptance #1 wire-through: fixture opencode.db -> OpencodeSource
        // -> SessionIndex snapshot -> the sweep's SweepSession mapping ->
        // fake-Gemini title. Fails without the freshell-sessions data fixes
        // (first_user_message stays None and titleSource holds at "dir").
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("opencode-data");
        std::fs::create_dir_all(&data_home).unwrap();
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('ses_1', '/x/glowforge',
                'New session - 2026-08-10T23:47:23.950Z', 1000, 5000, NULL, NULL, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO message VALUES ('msg_1', 'ses_1', 100, '{"role":"user"}')"#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_1',
                '{"type":"text","text":"This is a quick naming test"}')"#,
            [],
        )
        .unwrap();
        drop(conn);

        let sources: Vec<std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>> =
            vec![std::sync::Arc::new(
                freshell_sessions::directory_index::OpencodeSource::new(data_home),
            )];
        let index = freshell_sessions::directory_index::SessionIndex::with_ttl_and_cache_path(
            sources,
            std::time::Duration::from_millis(1_000),
            None,
        );
        let items = index.snapshot().await;
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].first_user_message.as_deref(),
            Some("This is a quick naming test")
        );

        // Unified agent names (Task 4): opencode is a SCOPED provider — the
        // wire-through now lands in the naming authority (the first-message
        // fallback record plus the armed generation series the worker will
        // dispatch), and the settings ladder never acquires a competing
        // scoped title.
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) = sweep_state_with(
            dir.path(),
            Some("key"),
            Some(names.clone()),
            Some(std::sync::Arc::new(index)),
        );
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(
            tid,
            Some("opencode"),
            Some("ses_1"),
            Some("/x/glowforge"),
            1,
        );
        // mirror spawn_auto_title_sweep's IndexedSession -> SweepSession mapping
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
        // The session is explicitly open (a live terminal match), so the
        // boot pass arms its series rather than absorbing.
        run_auto_title_pass(&state, &sessions).await;
        let target = freshell_protocol::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Opencode,
            session_id: "ses_1".to_string(),
        };
        let record = naming_record(&names, target.clone())
            .await
            .expect("the fixture session reached the naming authority");
        assert_eq!(record.record.name, "This is a quick naming test");
        assert_eq!(
            record.record.source,
            freshell_protocol::session_names::NameSource::FirstMessage
        );
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == target),
            "the scoped series is armed for the worker"
        );
        assert!(state
            .settings
            .session_overrides()
            .get("opencode:ses_1")
            .is_none());
    }

    // -- Unified agent names (Task 4): the scoped branch feeds the naming
    // authority — never the settings ladder ---------------------------------

    async fn naming_record(
        names: &Arc<crate::session_names::SessionNames>,
        target: freshell_protocol::SessionNameRef,
    ) -> Option<freshell_protocol::SessionNameUpdate> {
        names
            .get(vec![target])
            .await
            .expect("naming get")
            .into_iter()
            .next()
    }

    fn scoped_session_ref(provider: &str, id: &str) -> freshell_protocol::SessionNameRef {
        freshell_protocol::SessionNameRef::Session {
            provider: freshell_freshagent::naming::named_provider_for(Some(provider), None)
                .expect("scoped provider"),
            session_id: id.to_string(),
        }
    }

    /// A scoped session routes to the naming authority: the boot pass
    /// installs the free first-message fallback record and ABSORBS the
    /// observed message (no paid title across history), and the settings
    /// ladder never acquires a competing scoped title. A live terminal at
    /// boot is the explicit-open signal that arms generation.
    #[tokio::test]
    async fn scoped_sessions_feed_the_naming_authority_never_the_settings_ladder() {
        let dir = tempfile::tempdir().unwrap();
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) = sweep_state_with(dir.path(), None, Some(names.clone()), None);

        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-boot",
                "/x/proj",
                Some("Fix the flux capacitor"),
            )],
        )
        .await;

        // No live terminal: the record installs (free fallback) and the
        // message is absorbed — the paid title is NOT scheduled.
        let record = naming_record(&names, scoped_session_ref("claude", "s-boot"))
            .await
            .expect("the boot pass installed the record");
        assert_eq!(record.record.name, "Fix the flux capacitor");
        assert_eq!(
            record.record.source,
            freshell_protocol::session_names::NameSource::FirstMessage
        );
        assert!(
            names.generation_work_snapshot().is_empty(),
            "history alone never schedules the paid title"
        );
        // The settings ladder never acquired a competing scoped title.
        assert!(state
            .settings
            .session_overrides()
            .get("claude:s-boot")
            .is_none());

        // A live terminal at boot IS the explicit-open signal: the observed
        // message arms generation for that session.
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) = sweep_state_with(dir.path(), None, Some(names.clone()), None);
        state
            .index_hydrated
            .store(false, std::sync::atomic::Ordering::SeqCst);
        spawn_headless_terminal_for_test(&state.registry, "term-open");
        state.identity.upsert(
            "term-open",
            Some("claude"),
            Some("s-open"),
            Some("/x/proj"),
            1,
        );
        run_auto_title_pass(
            &state,
            &[session("claude", "s-open", "/x/proj", Some("Open me up"))],
        )
        .await;
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("claude", "s-open")),
            "a live terminal at boot arms the explicitly open session"
        );
        assert!(state
            .settings
            .session_overrides()
            .get("claude:s-open")
            .is_none());
    }

    /// After the boot snapshot, a genuinely newly observed message arms
    /// generation — no terminal needed (a session that finishes without a
    /// browser still gets its name).
    #[tokio::test]
    async fn a_session_observed_after_boot_arms_generation() {
        let dir = tempfile::tempdir().unwrap();
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) = sweep_state_with(dir.path(), None, Some(names.clone()), None);

        // Boot pass: the historical session is absorbed.
        run_auto_title_pass(
            &state,
            &[session(
                "codex",
                "s-hist",
                "/x/hist",
                Some("Historical message"),
            )],
        )
        .await;
        assert!(names.generation_work_snapshot().is_empty());
        // Re-feeding the same absorbed message is a no-op.
        run_auto_title_pass(
            &state,
            &[session(
                "codex",
                "s-hist",
                "/x/hist",
                Some("Historical message"),
            )],
        )
        .await;
        assert!(
            names.generation_work_snapshot().is_empty(),
            "the absorbed message never arms on a later pass"
        );

        // A session that first appears AFTER boot is newly observed: its
        // message arms generation.
        run_auto_title_pass(
            &state,
            &[session(
                "codex",
                "s-new",
                "/x/new",
                Some("A brand new post-boot session"),
            )],
        )
        .await;
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("codex", "s-new")),
            "a newly observed post-boot session arms generation"
        );
        let record = naming_record(&names, scoped_session_ref("codex", "s-new"))
            .await
            .expect("the new session hydrated");
        assert_eq!(record.record.name, "A brand new post-boot session");
    }

    /// Delta-review round 3, finding 2: a SETTLED scoped session costs ZERO
    /// store transactions on a later sweep pass. Steady state used to pay
    /// hydrate_indexed + activity — each a strict cross-process transaction
    /// locking/reading/digesting/parsing the whole session-names document —
    /// for every scoped session on EVERY ~5s pass (O(H^2) per pass, forever).
    /// The adopted-view pre-checks prove the no-op without transacting; the
    /// convergence control proves a genuinely new session still reaches the
    /// store (the pre-check only skips what the strict transaction would
    /// have no-op'd — view staleness in the other direction just transacts).
    #[tokio::test]
    async fn settled_scoped_sessions_transact_zero_on_later_sweep_passes() {
        let dir = tempfile::tempdir().unwrap();
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) = sweep_state_with(dir.path(), None, Some(names.clone()), None);

        // Boot pass: the scoped session hydrates (record + absorbed message).
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-settled",
                "/x/proj",
                Some("Fix the flux capacitor"),
            )],
        )
        .await;
        assert!(
            naming_record(&names, scoped_session_ref("claude", "s-settled"))
                .await
                .is_some(),
            "the boot pass installed the record"
        );

        // Second pass (settled, message re-fed): ZERO transactions.
        let before = crate::session_names::test_store_transaction_count(dir.path());
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-settled",
                "/x/proj",
                Some("Fix the flux capacitor"),
            )],
        )
        .await;
        let after = crate::session_names::test_store_transaction_count(dir.path());
        assert_eq!(
            before, after,
            "a settled scoped session (absorbed message, unopened) must not transact on a later pass"
        );

        // The explicitly-open variant settles too: the boot-pass Opened edge
        // armed its series, and re-feeding the SAME message with Opened on an
        // armed (Eligible, attempted-count 0 but non-Idle) series is a no-op.
        spawn_headless_terminal_for_test(&state.registry, "term-open");
        state.identity.upsert(
            "term-open",
            Some("claude"),
            Some("s-open"),
            Some("/x/open"),
            1,
        );
        run_auto_title_pass(
            &state,
            &[session("claude", "s-open", "/x/open", Some("Open me up"))],
        )
        .await;
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("claude", "s-open")),
            "the open session's message armed generation"
        );
        let before_open = crate::session_names::test_store_transaction_count(dir.path());
        run_auto_title_pass(
            &state,
            &[session("claude", "s-open", "/x/open", Some("Open me up"))],
        )
        .await;
        let after_open = crate::session_names::test_store_transaction_count(dir.path());
        assert_eq!(
            before_open, after_open,
            "a settled explicitly-open scoped session must not transact on a later pass"
        );

        // Convergence control: alongside the settled sessions, a genuinely
        // NEW scoped session still reaches the store (a missing record is
        // always pending work — the pre-check never over-skips).
        let before_new = crate::session_names::test_store_transaction_count(dir.path());
        run_auto_title_pass(
            &state,
            &[
                session(
                    "claude",
                    "s-settled",
                    "/x/proj",
                    Some("Fix the flux capacitor"),
                ),
                session("claude", "s-fresh", "/x/fresh", Some("A brand new session")),
            ],
        )
        .await;
        let after_new = crate::session_names::test_store_transaction_count(dir.path());
        assert!(
            after_new > before_new,
            "a new scoped session still transacts (hydrate + arm)"
        );
        assert!(
            naming_record(&names, scoped_session_ref("claude", "s-fresh"))
                .await
                .is_some(),
            "the new session's record installed"
        );
    }

    /// An already-named opencode session carries no first message in the
    /// bounded listing: the targeted lookup serves it, the provider title
    /// installs at its own fallback rank, and the newly observed message
    /// arms generation (the provider title never suppresses it).
    #[tokio::test]
    async fn an_already_named_opencode_session_gets_the_targeted_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(data_home.path()).unwrap();
        let conn = rusqlite::Connection::open(data_home.path().join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('ses_named', '/x/named',
                'Opencode named it', 1000, 5000, NULL, NULL, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO message VALUES ('msg_1', 'ses_named', 100, '{"role":"user"}')"#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_named',
                '{"type":"text","text":"The hidden first message"}')"#,
            [],
        )
        .unwrap();
        drop(conn);
        let sources: Vec<std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>> =
            vec![std::sync::Arc::new(
                freshell_sessions::directory_index::OpencodeSource::new(
                    data_home.path().to_path_buf(),
                ),
            )];
        let index = std::sync::Arc::new(
            freshell_sessions::directory_index::SessionIndex::with_ttl_and_cache_path(
                sources,
                std::time::Duration::from_millis(1_000),
                None,
            ),
        );
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) =
            sweep_state_with(dir.path(), None, Some(names.clone()), Some(index.clone()));

        // A NON-boot pass (post-boot observation of an already-named
        // session): the targeted lookup supplies the message, the provider
        // title installs at its own rank, and the message arms generation.
        state
            .index_hydrated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut s = session("opencode", "ses_named", "/x/named", None);
        s.title = Some("Opencode named it".into());
        s.title_source = Some("provider-generated".into());
        run_auto_title_pass(&state, &[s]).await;

        let record = naming_record(&names, scoped_session_ref("opencode", "ses_named"))
            .await
            .expect("the named session hydrated");
        assert_eq!(record.record.name, "Opencode named it");
        assert_eq!(
            record.record.source,
            freshell_protocol::session_names::NameSource::ProviderAi
        );
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("opencode", "ses_named")),
            "the provider title never suppresses generation"
        );
        assert!(state
            .settings
            .session_overrides()
            .get("opencode:ses_named")
            .is_none());
    }

    /// Excluded providers keep the legacy ladder exactly: an amplifier
    /// session with no key still finalizes the first-message heuristic
    /// through the settings override row and pushes the live terminal.
    #[tokio::test]
    async fn excluded_providers_keep_the_legacy_ladder_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, mut rx) = sweep_state_with(dir.path(), None, Some(names.clone()), None);
        let tid = "term-legacy";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("amplifier"), Some("s1"), Some("/x/proj"), 1);

        run_auto_title_pass(
            &state,
            &[session(
                "amplifier",
                "s1",
                "/x/proj",
                Some("Fix the flux\nrest"),
            )],
        )
        .await;

        let ov = state.settings.session_overrides();
        let row = ov.get("amplifier:s1").unwrap();
        assert_eq!(row["titleOverride"], "Fix the flux");
        assert_eq!(row["titleSource"], "first-message");
        let mut saw_title_updated = false;
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if v["type"] == "terminal.title.updated" {
                saw_title_updated = true;
            }
        }
        assert!(saw_title_updated, "the legacy push still broadcasts");
        assert!(
            names.refresh_current().await.unwrap().is_empty(),
            "excluded providers never enter the naming authority"
        );
    }

    // -- Unified agent names (Task 4, review I3): kilroy-only sessions ----
    // Kilroy shares the Claude runtime, so its transcripts are listed by
    // the claude source under provider "claude". The metadata store's
    // known `kilroy` type is the discriminator the plan names: a
    // kilroy-only session never enters the naming authority or the
    // generator merely because its provider is claude — it KEEPS the
    // legacy ladder (the Global Constraint: kilroy retains its existing
    // UI and generation behavior).

    /// Shared setup: a sweep state with the naming authority wired, one
    /// live terminal matching the session (provider `claude`), and the
    /// metadata store's kilroy tag applied (or not, per `tag_kilroy`).
    async fn kilroy_sweep_state(
        tag_kilroy: bool,
    ) -> (
        tempfile::TempDir,
        Arc<crate::session_names::SessionNames>,
        AutoTitleSweepState,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let names = crate::session_names::SessionNames::open(dir.path().to_path_buf()).unwrap();
        let (state, _rx) = sweep_state_with(dir.path(), None, Some(names.clone()), None);
        if tag_kilroy {
            state
                .metadata
                .set("claude", "s-kilroy", "kilroy", Some("explicit"))
                .await
                .unwrap();
        }
        let tid = "term-kilroy";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s-kilroy"), Some("/x/proj"), 1);
        (dir, names, state)
    }

    /// A provider-`claude` listing row the metadata store types as kilroy
    /// (with only a non-scoped live terminal) never hydrates a
    /// naming-authority record and never arms the generator — the boot
    /// pass keeps kilroy's legacy ladder exactly (the first-message
    /// heuristic through the settings override row).
    #[tokio::test]
    async fn a_kilroy_typed_claude_row_never_hydrates_and_keeps_the_ladder() {
        let (_dir, names, state) = kilroy_sweep_state(true).await;
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-kilroy",
                "/x/proj",
                Some("Fix the flux capacitor"),
            )],
        )
        .await;

        // KEEPS the legacy ladder: the first-message heuristic finalizes
        // through the settings override row (no AI key configured).
        let row = state
            .settings
            .session_overrides()
            .get("claude:s-kilroy")
            .cloned()
            .expect("the legacy ladder still serves the kilroy-only session");
        assert_eq!(row["titleOverride"], "Fix the flux capacitor");
        assert_eq!(row["titleSource"], "first-message");
        // Never enters the naming authority — no record, no armed series.
        assert!(
            naming_record(&names, scoped_session_ref("claude", "s-kilroy"))
                .await
                .is_none(),
            "a kilroy-only session never acquires a naming record"
        );
        assert!(
            names.generation_work_snapshot().is_empty(),
            "a kilroy-only session never arms the generator"
        );
    }

    /// The same row AFTER boot: a live terminal at boot is the
    /// explicit-open signal that would ARM the generator on a
    /// metadata-blind sweep — a kilroy-only session still never arms, and
    /// the ladder still writes.
    #[tokio::test]
    async fn a_kilroy_typed_claude_row_never_arms_generation_post_boot() {
        let (_dir, names, state) = kilroy_sweep_state(true).await;
        state
            .index_hydrated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-kilroy",
                "/x/proj",
                Some("Open the flux capacitor"),
            )],
        )
        .await;
        assert!(
            names.generation_work_snapshot().is_empty(),
            "a kilroy-only session never arms the generator, post-boot or not"
        );
        assert!(
            naming_record(&names, scoped_session_ref("claude", "s-kilroy"))
                .await
                .is_none(),
            "a kilroy-only session never acquires a naming record"
        );
        let row = state
            .settings
            .session_overrides()
            .get("claude:s-kilroy")
            .cloned()
            .expect("the legacy ladder still serves the kilroy-only session");
        assert_eq!(row["titleOverride"], "Open the flux capacitor");
        assert_eq!(row["titleSource"], "first-message");
    }

    /// The same row WITHOUT the kilroy metadata entry behaves scoped: the
    /// naming authority owns it (first-message fallback record, armed
    /// generation) and the settings ladder never acquires a competing
    /// title — the metadata consultation is the only discriminator.
    #[tokio::test]
    async fn the_same_row_without_the_kilroy_entry_behaves_scoped() {
        let (_dir, names, state) = kilroy_sweep_state(false).await;
        state
            .index_hydrated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-kilroy",
                "/x/proj",
                Some("Scoped session message"),
            )],
        )
        .await;
        let record = naming_record(&names, scoped_session_ref("claude", "s-kilroy"))
            .await
            .expect("the untagged claude session hydrates like any scoped row");
        assert_eq!(record.record.name, "Scoped session message");
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("claude", "s-kilroy")),
            "the untagged claude session arms generation (explicitly open)"
        );
        assert!(
            state
                .settings
                .session_overrides()
                .get("claude:s-kilroy")
                .is_none(),
            "a scoped session never acquires a settings title"
        );
    }

    /// The singular-record rule: a kilroy-typed row whose identical durable
    /// session is ALSO open through a supported mode (a live terminal in
    /// a scoped mode — here a `claude` CLI pane) still participates in
    /// the naming authority: one canonical saved name, never a competing
    /// kilroy record, and the ladder still excludes it.
    #[tokio::test]
    async fn a_kilroy_typed_row_with_a_live_scoped_terminal_participates_singularly() {
        let (_dir, names, state) = kilroy_sweep_state(true).await;
        // A SECOND live terminal in a scoped mode (a resumed claude CLI
        // pane holding the same durable session) — the singular-record
        // proxy that outvotes the kilroy-only skip.
        spawn_headless_terminal_with_mode_for_test(&state.registry, "term-scoped", "claude");
        state.identity.upsert(
            "term-scoped",
            Some("claude"),
            Some("s-kilroy"),
            Some("/x/proj"),
            1,
        );
        state
            .index_hydrated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-kilroy",
                "/x/proj",
                Some("Dual mode session message"),
            )],
        )
        .await;
        let record = naming_record(&names, scoped_session_ref("claude", "s-kilroy"))
            .await
            .expect("the singular record serves the session also open through a supported mode");
        assert_eq!(record.record.name, "Dual mode session message");
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("claude", "s-kilroy")),
            "the session also open through a supported mode arms generation"
        );
        assert!(
            state
                .settings
                .session_overrides()
                .get("claude:s-kilroy")
                .is_none(),
            "the singular scoped record keeps the ladder excluded"
        );
    }

    /// Delta-review round 4, finding 1 (the seam's singular-record
    /// component): a kilroy-typed row whose session ALREADY holds a
    /// canonical record — with NO live scoped terminal — stays in the
    /// naming-authority lane. The supported-mode record owns the session's
    /// ONE singular name, so the legacy ladder never writes it a competing
    /// settings title, and observed activity feeds the authority (arms
    /// generation) exactly like any scoped row.
    #[tokio::test]
    async fn a_kilroy_typed_row_with_a_canonical_record_stays_in_the_authority_lane() {
        let (_dir, names, state) = kilroy_sweep_state(true).await;
        // The canonical record through the claude mode (the index-adopted
        // hydration path) — the only live terminal is the non-scoped one
        // `kilroy_sweep_state` registers, so the live-scoped-terminal
        // component cannot be what keeps this row scoped.
        names
            .hydrate_indexed(
                crate::session_name_generation::IndexedNameInput {
                    provider: freshell_protocol::session_names::NamedProvider::Claude,
                    session_id: "s-kilroy".to_string(),
                    cwd: Some("/x/proj".to_string()),
                    first_user_message: Some("Canonical first".to_string()),
                    provider_title: None,
                },
                false,
            )
            .await
            .unwrap();
        state
            .index_hydrated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s-kilroy",
                "/x/proj",
                Some("A later scoped message"),
            )],
        )
        .await;
        // The legacy ladder never acquired a competing settings title.
        assert!(
            state
                .settings
                .session_overrides()
                .get("claude:s-kilroy")
                .is_none(),
            "a record-holding kilroy-typed session keeps the ladder excluded"
        );
        // The authority keeps the session: the record survives with its
        // name, and the later observed message fed the authority (armed
        // generation) instead of the legacy ladder.
        let record = naming_record(&names, scoped_session_ref("claude", "s-kilroy"))
            .await
            .expect("the canonical record keeps owning the session");
        assert_eq!(record.record.name, "Canonical first");
        assert!(
            names
                .generation_work_snapshot()
                .iter()
                .any(|item| item.target == scoped_session_ref("claude", "s-kilroy")),
            "activity feeds the naming authority for a record-holding kilroy-typed row"
        );
    }

    // -- cwd-canonicalize-lag (docs/plans/2026-09-20-cwd-canonicalize-lag.md,
    // Task 3): sweep-level integration pins through the FULL pass path --
    // SweepSession list -> find_all_by_session matching -> the per-pass
    // terminal-meta refresh fan-out. The unified agent-names work moved
    // scoped coding-agent sessions' TITLES to the naming authority (the
    // legacy title ladder skips named providers), so the observable fan-out
    // of cwd matching in the pass is the `terminal.meta.updated` upsert
    // batch: every matched terminal's record is rebuilt and committed
    // change-gated, and only matching terminals are ever in that set ----

    /// Seeds the create-time terminal-meta record the pass's refresh path
    /// requires (`refresh_terminal_meta` skips terminals the create path
    /// never seeded).
    fn seed_terminal_meta_for_test(state: &AutoTitleSweepState, terminal_id: &str) {
        let record = freshell_ws::terminal_meta::record_for_create(
            terminal_id,
            "shell",
            None,
            None,
            now_ms(),
        );
        state.terminal_meta.commit_if_changed(record, now_ms());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_cwd_discriminates_between_two_live_claude_terminals() {
        let dir = tempfile::tempdir().unwrap();
        let cwd_a = dir.path().join("a");
        let cwd_b = dir.path().join("b");
        std::fs::create_dir_all(&cwd_a).unwrap();
        std::fs::create_dir_all(&cwd_b).unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);

        spawn_headless_terminal_for_test(&state.registry, "t-a");
        spawn_headless_terminal_for_test(&state.registry, "t-b");
        state.identity.upsert(
            "t-a",
            Some("claude"),
            Some("s1"),
            Some(cwd_a.to_str().unwrap()),
            1,
        );
        state.identity.upsert(
            "t-b",
            Some("claude"),
            Some("s1"),
            Some(cwd_b.to_str().unwrap()),
            2,
        );
        seed_terminal_meta_for_test(&state, "t-a");
        seed_terminal_meta_for_test(&state, "t-b");

        // The session's cwd is cwd_a: only t-a matches, so the meta-refresh
        // fan-out must upsert t-a only — never t-b.
        run_auto_title_pass(
            &state,
            &[session("claude", "s1", cwd_a.to_str().unwrap(), Some("hi"))],
        )
        .await;
        let mut saw_a = false;
        let mut saw_b = false;
        while let Ok(frame) = rx.try_recv() {
            if frame.contains("t-a") {
                saw_a = true;
            }
            if frame.contains("t-b") {
                saw_b = true;
            }
        }
        assert!(
            saw_a,
            "the cwd-matched terminal must receive the meta upsert"
        );
        assert!(!saw_b, "the cwd-mismatched terminal must never receive it");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_matches_a_claude_terminal_through_real_symlinked_cwds() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let session_link = dir.path().join("session-link");
        let terminal_link = dir.path().join("terminal-link");
        std::os::unix::fs::symlink(&real, &session_link).unwrap();
        std::os::unix::fs::symlink(&real, &terminal_link).unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);

        let tid = "t-sym";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(
            tid,
            Some("claude"),
            Some("s1"),
            Some(terminal_link.to_str().unwrap()),
            1,
        );
        seed_terminal_meta_for_test(&state, tid);

        // Different raw strings, same canonical directory: the pass must
        // match through REAL canonicalization (not the lexical fallback
        // every cwd-less sweep test exercises) and upsert the matched
        // terminal's meta.
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s1",
                session_link.to_str().unwrap(),
                Some("hi"),
            )],
        )
        .await;
        let mut saw_upsert = false;
        while let Ok(frame) = rx.try_recv() {
            if frame.contains(tid) {
                saw_upsert = true;
            }
        }
        assert!(
            saw_upsert,
            "the symlink-resolved match must reach the terminal meta fan-out"
        );

        // Second pass, same input: the memoized resolution keeps the match
        // stable and the change-gated commit suppresses a second upsert.
        run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s1",
                session_link.to_str().unwrap(),
                Some("hi"),
            )],
        )
        .await;
        while let Ok(frame) = rx.try_recv() {
            assert!(
                !frame.contains(tid),
                "a memo-stable identical pass must not re-upsert: {frame}"
            );
        }
    }

    #[tokio::test]
    async fn sweep_stays_cwd_blind_for_codex_sessions_with_real_cwds() {
        let dir = tempfile::tempdir().unwrap();
        let cwd_session = dir.path().join("a");
        let cwd_terminal = dir.path().join("b");
        std::fs::create_dir_all(&cwd_session).unwrap();
        std::fs::create_dir_all(&cwd_terminal).unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);

        let tid = "t-codex";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(
            tid,
            Some("codex"),
            Some("s1"),
            Some(cwd_terminal.to_str().unwrap()),
            1,
        );
        seed_terminal_meta_for_test(&state, tid);

        // Different real cwds, same provider+session: codex matching must
        // stay cwd-blind (the lazy fix must never accidentally scope it) —
        // the terminal still reaches the meta fan-out despite the mismatch.
        run_auto_title_pass(
            &state,
            &[session(
                "codex",
                "s1",
                cwd_session.to_str().unwrap(),
                Some("hi"),
            )],
        )
        .await;
        let mut saw_upsert = false;
        while let Ok(frame) = rx.try_recv() {
            if frame.contains(tid) {
                saw_upsert = true;
            }
        }
        assert!(
            saw_upsert,
            "cwd-blind codex matching must still fan out to the terminal"
        );
    }
}
