//! Terminal metadata registry — the DEV-0008-closing port of
//! `server/terminal-metadata-service.ts` (`TerminalMetadataService`).
//!
//! A shared, process-wide store of git-enriched per-terminal metadata records
//! ([`freshell_protocol::common::TerminalMetaRecord`]), consumed by:
//! * the connect handshake — `terminal.inventory.terminalMeta`
//!   ([`crate::build_handshake`] ships [`TerminalMetaRegistry::list`]);
//! * the live push channel — `terminal.meta.updated {upsert, remove}`
//!   ([`broadcast_terminal_meta_updated`]), fed by three producers: the
//!   `terminal.create` path (`terminal.rs`, async-enriched off the create
//!   latency path), the amplifier/opencode association drains
//!   (`amplifier_association.rs` / `opencode_association.rs`), and
//!   `freshell-server`'s auto-title sweep (Node's `applySessionMetadata`
//!   analog, `server/index.ts:854-866`).
//!
//! Relationship to [`crate::identity::TerminalIdentityRegistry`]: identity is
//! the narrow provider/sessionId slice the rename cascades and the
//! session-directory join consume; THIS registry is the full wire-record store
//! (git fields included) behind the client's pane-header badges. Both are
//! written by the same lifecycle points; neither replaces the other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use freshell_protocol::common::TerminalMetaRecord;
use freshell_protocol::{ServerMessage, TerminalMetaUpdated};

/// How long a retired record stays resident (and `get()`-able) before pruning
/// (`TerminalMetadataService.RETIRED_TTL_MS`, `terminal-metadata-service.ts:109`).
pub const RETIRED_TTL_MS: i64 = 3_600_000; // 1h

/// One stored record + its retirement timestamp (the original's two maps,
/// `byTerminalId` + `retiredAt`, co-located since every entry needs both).
struct MetaEntry {
    record: TerminalMetaRecord,
    retired_at: Option<i64>,
}

/// Shared, cheaply-cloneable registry (`Arc<Mutex<..>>`), following the
/// [`crate::identity::TerminalIdentityRegistry`] sharing model: constructed
/// once in `freshell-server::main`, cloned into `WsState` (create/kill/exit
/// producers + the handshake reader) and into `AutoTitleSweepState` (the
/// sweep-time producer).
#[derive(Clone, Default)]
pub struct TerminalMetaRegistry {
    inner: Arc<Mutex<HashMap<String, MetaEntry>>>,
}

impl TerminalMetaRegistry {
    /// `commitIfChanged` (`terminal-metadata-service.ts:288-301`): compare
    /// against the stored record ignoring `updatedAt` (`terminalMetaEquals`,
    /// `:93-106`); identical content is suppressed (returns `None`, store
    /// untouched). Changed (or new) content is stamped `updated_at = now`,
    /// stored, and returned for broadcasting. Retirement status is untouched
    /// (the original's `retiredAt` map is not consulted here).
    pub fn commit_if_changed(
        &self,
        next: TerminalMetaRecord,
        now: i64,
    ) -> Option<TerminalMetaRecord> {
        let mut map = self.inner.lock().expect("terminal meta registry lock");
        if let Some(entry) = map.get(&next.terminal_id) {
            if terminal_meta_equals(&entry.record, &next) {
                return None;
            }
        }
        let mut stamped = next;
        stamped.updated_at = now;
        let retired_at = map
            .get(&stamped.terminal_id)
            .and_then(|entry| entry.retired_at);
        map.insert(
            stamped.terminal_id.clone(),
            MetaEntry {
                record: stamped.clone(),
                retired_at,
            },
        );
        Some(stamped)
    }

    /// `retire` (`terminal-metadata-service.ts:203-219`): strip the volatile
    /// fields (ALL git fields + `tokenUsage`) but keep
    /// `terminalId`/`cwd`/`provider`/`sessionId`/`updatedAt`, mark retired,
    /// and prune retired entries older than [`RETIRED_TTL_MS`]. `false` for an
    /// unknown id. DIVERGENCE (documented): an ALREADY-retired entry returns
    /// `false` (Node re-stamps `retiredAt` and returns `true`) — on this port
    /// a kill fires BOTH the kill path and the PTY exit hook, and the `false`
    /// makes the second site a no-op so exactly ONE
    /// `terminal.meta.updated{remove}` frame is broadcast per terminal
    /// lifetime (Node has a single retire site, `server/index.ts:657-665`,
    /// so the case never arises there).
    pub fn retire(&self, terminal_id: &str, now: i64) -> bool {
        let mut map = self.inner.lock().expect("terminal meta registry lock");
        let Some(entry) = map.get_mut(terminal_id) else {
            return false;
        };
        if entry.retired_at.is_some() {
            return false; // see the doc comment: single remove frame per lifetime
        }
        entry.record = TerminalMetaRecord {
            terminal_id: entry.record.terminal_id.clone(),
            updated_at: entry.record.updated_at,
            branch: None,
            checkout_root: None,
            cwd: entry.record.cwd.clone(),
            display_subdir: None,
            is_dirty: None,
            provider: entry.record.provider.clone(),
            repo_root: None,
            session_id: entry.record.session_id.clone(),
            token_usage: None,
        };
        entry.retired_at = Some(now);
        prune_stale_retired(&mut map, now);
        true
    }

    /// `list` (`terminal-metadata-service.ts:128-132`): every LIVE
    /// (non-retired) record. Also prunes retired entries older than
    /// [`RETIRED_TTL_MS`] (the original prunes on `retire()` only; pruning on
    /// the read path too keeps a long-idle server's map bounded without a
    /// timer).
    pub fn list(&self, now: i64) -> Vec<TerminalMetaRecord> {
        let mut map = self.inner.lock().expect("terminal meta registry lock");
        prune_stale_retired(&mut map, now);
        map.values()
            .filter(|entry| entry.retired_at.is_none())
            .map(|entry| entry.record.clone())
            .collect()
    }

    /// `get` (`terminal-metadata-service.ts:134-136`): the record regardless
    /// of retirement — retired entries keep answering until pruned, exactly
    /// like the original (rename cascades resolve after exit).
    pub fn get(&self, terminal_id: &str) -> Option<TerminalMetaRecord> {
        self.inner
            .lock()
            .expect("terminal meta registry lock")
            .get(terminal_id)
            .map(|entry| entry.record.clone())
    }
}

/// `pruneStaleRetired` (`terminal-metadata-service.ts:226-234`): drop entries
/// retired strictly BEFORE `now - RETIRED_TTL_MS` (`timestamp < cutoff`).
fn prune_stale_retired(map: &mut HashMap<String, MetaEntry>, now: i64) {
    let cutoff = now - RETIRED_TTL_MS;
    map.retain(|_, entry| {
        entry
            .retired_at
            .is_none_or(|retired_at| retired_at >= cutoff)
    });
}

/// `terminalMetaEquals` (`terminal-metadata-service.ts:93-106`): every field
/// EXCEPT `updatedAt` (`tokenUsageEquals` is the derived `PartialEq` on
/// [`freshell_protocol::common::TokenSummary`] — it compares the same eight
/// fields the original enumerates).
fn terminal_meta_equals(a: &TerminalMetaRecord, b: &TerminalMetaRecord) -> bool {
    a.terminal_id == b.terminal_id
        && a.cwd == b.cwd
        && a.checkout_root == b.checkout_root
        && a.repo_root == b.repo_root
        && a.display_subdir == b.display_subdir
        && a.branch == b.branch
        && a.is_dirty == b.is_dirty
        && a.provider == b.provider
        && a.session_id == b.session_id
        && a.token_usage == b.token_usage
}

/// `enrichFromCwd` (`terminal-metadata-service.ts:260-286`): fill
/// `checkout_root`/`repo_root`/`display_subdir`/`branch`/`is_dirty` from the
/// record's `cwd` via the Task 17 git helpers. Live git wins for
/// `branch`/`is_dirty`, the record's existing values are kept as fallback
/// (`:283-284`); the three root fields are REPLACED. A falsy cwd (`None` or
/// empty — JS `if (!cwd)`) clears the three root fields and runs no git.
/// The git probes are BLOCKING (up to three `git` spawns, every one with
/// `GIT_OPTIONAL_LOCKS=0`) — they run inside `spawn_blocking`.
pub async fn enrich_from_cwd(record: &mut TerminalMetaRecord) {
    // JS `if (!cwd)` (service :262): None and "" both clear the root fields.
    let Some(cwd) = record.cwd.clone().filter(|c| !c.is_empty()) else {
        record.checkout_root = None;
        record.repo_root = None;
        record.display_subdir = None;
        return;
    };
    // The original's Promise.all over the three resolvers (service :271-275);
    // here one blocking task runs them back-to-back (the roots are cached
    // process-lifetime, so branch+dirty's git spawns dominate either way).
    let probes = tokio::task::spawn_blocking(move || {
        let checkout_root = freshell_platform::git_meta::resolve_git_checkout_root(&cwd);
        let repo_root = freshell_platform::git_meta::resolve_git_repo_root(&cwd);
        let branch_and_dirty = freshell_platform::git_meta::resolve_git_branch_and_dirty(&cwd);
        (checkout_root, repo_root, branch_and_dirty)
    })
    .await;
    let (checkout_root, repo_root, branch_and_dirty) = match probes {
        Ok(probes) => probes,
        Err(join_error) => {
            // The closure only runs the Task 17 helpers, which never panic in
            // normal operation; leave the record un-enriched rather than
            // clearing fields on an infrastructure failure.
            tracing::warn!(error = %join_error, "terminal_meta_enrich_task_panicked");
            return;
        }
    };
    record.display_subdir = freshell_platform::git_meta::derive_display_subdir(
        record.cwd.as_deref(),
        checkout_root.as_deref(),
    );
    record.checkout_root = checkout_root;
    record.repo_root = repo_root;
    // Live git wins; existing values are the fallback (service :283-284).
    record.branch = branch_and_dirty.branch.or(record.branch.take());
    record.is_dirty = branch_and_dirty.is_dirty.or(record.is_dirty);
}

/// `selectMoreSpecificCwd` (`terminal-metadata-service.ts:63-76`): normalize
/// both (strip trailing separators); a missing side yields the other; when one
/// path contains the other, the deeper (more specific) one wins; unrelated
/// paths prefer the SESSION cwd (it reflects where the provider actually
/// operates — the spawn cwd can be a generic default).
pub fn select_more_specific_cwd(
    current_cwd: Option<&str>,
    session_cwd: Option<&str>,
) -> Option<String> {
    let current = normalize_path_for_display(current_cwd);
    let session = normalize_path_for_display(session_cwd);
    match (current, session) {
        (None, session) => session,
        (current, None) => current,
        (Some(current), Some(session)) => {
            if is_same_or_inside(&current, &session) {
                Some(session)
            } else if is_same_or_inside(&session, &current) {
                Some(current)
            } else {
                Some(session)
            }
        }
    }
}

/// `normalizePathForDisplay` (`terminal-metadata-service.ts:43-46`): strip
/// trailing `/` and `\`; missing or empty input is `None`.
fn normalize_path_for_display(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    Some(value.trim_end_matches(['\\', '/']).to_string())
}

/// `isSameOrInside` (`terminal-metadata-service.ts:55-61`): whether `child`
/// equals `parent` or lives under it. The original computes `path.relative`
/// and rejects `..`-escaping results; a component-prefix compare over
/// already-absolute, already-normalized paths is the same predicate without
/// the string round-trip (`/a/bc` is NOT inside `/a/b`).
fn is_same_or_inside(parent: &str, child: &str) -> bool {
    let parent: Vec<std::path::Component> = std::path::Path::new(parent).components().collect();
    let child: Vec<std::path::Component> = std::path::Path::new(child).components().collect();
    child.len() >= parent.len() && child[..parent.len()] == parent[..]
}

/// `wsHandler.broadcastTerminalMetaUpdated({upsert, remove})`
/// (`ws-handler.ts:3682-3695`): fan `{type:'terminal.meta.updated', upsert,
/// remove}` to EVERY connection over the shared broadcast bus (the original's
/// plain `this.broadcast(...)`, NOT `broadcastAuthenticated`). An
/// all-empty payload is a no-op (the original's producers guard the same way,
/// `server/index.ts:622-625`).
pub fn broadcast_terminal_meta_updated(
    tx: &tokio::sync::broadcast::Sender<String>,
    upsert: Vec<TerminalMetaRecord>,
    remove: Vec<String>,
) {
    if upsert.is_empty() && remove.is_empty() {
        return;
    }
    let msg = ServerMessage::TerminalMetaUpdated(TerminalMetaUpdated { remove, upsert });
    if let Ok(frame) = serde_json::to_string(&msg) {
        let _ = tx.send(frame);
    }
}

/// Build the create-time `TerminalMetaRecord` (DEV-0008 closure, Task 18;
/// moved here from `terminal.rs` in Fix round 1 so BOTH create paths -- the WS
/// `terminal.create` handler and the REST pipeline's terminal-created hook
/// ([`seed_from_terminal`]) -- share the ONE builder).
///
/// The original's `TerminalMetadataService.seedFromTerminal`
/// (`terminal-metadata-service.ts:138-146`) runs off the registry's
/// `'terminal.created'` event (`server/index.ts:647-655`) for EVERY terminal:
/// `provider` only for non-shell modes (`isTerminalProvider`, `:39-41`), and
/// `sessionId` only riding along with a provider -- derived from
/// `record.resumeSessionId`, which is set for a fresh server-preallocated id
/// (e.g. claude) just as much as for a genuine resume
/// (`terminal-registry.ts:176-195` `TerminalSessionRefSource`).
///
/// Built here: `terminalId`, `cwd`, `provider`, `sessionId`, `updatedAt` --
/// the fields known at create time with zero extra I/O. Git enrichment
/// (`checkoutRoot`/`repoRoot`/`branch`/`isDirty`/`displaySubdir`,
/// `enrichFromCwd`) happens in the ASYNC task
/// ([`spawn_enrich_commit_broadcast`]) so terminal-creation latency never
/// pays for the git probes.
pub fn record_for_create(
    terminal_id: &str,
    mode: &str,
    resume_session_id: Option<&str>,
    cwd: Option<&str>,
    updated_at: i64,
) -> TerminalMetaRecord {
    let provider = (mode != "shell").then(|| mode.to_string());
    let session_id = if provider.is_some() {
        resume_session_id.map(str::to_string)
    } else {
        None
    };
    TerminalMetaRecord {
        terminal_id: terminal_id.to_string(),
        updated_at,
        branch: None,
        checkout_root: None,
        cwd: cwd.map(str::to_string),
        display_subdir: None,
        is_dirty: None,
        provider,
        repo_root: None,
        session_id,
        token_usage: None,
    }
}

/// The async half of create-time seeding (extracted from `terminal.rs`'s
/// `handle_create` in Fix round 1 so both create paths share it): git-enrich +
/// commit + broadcast OFF the create path, exactly like Node's async
/// `seedFromTerminal` fan-out (`server/index.ts:647-655`) -- the git probes
/// must never add latency to the create reply. `commit_if_changed` on a fresh
/// terminalId always changes, so the enriched upsert reaches every connected
/// client; the handshake's `terminal_meta.list()` serves late-connecting
/// clients the same record.
pub fn spawn_enrich_commit_broadcast(
    terminal_meta: &TerminalMetaRegistry,
    broadcast_tx: &Arc<tokio::sync::broadcast::Sender<String>>,
    mut record: TerminalMetaRecord,
) {
    let terminal_meta = terminal_meta.clone();
    let broadcast_tx = Arc::clone(broadcast_tx);
    tokio::spawn(async move {
        enrich_from_cwd(&mut record).await;
        if let Some(record) = terminal_meta.commit_if_changed(record, crate::terminal::now_ms()) {
            broadcast_terminal_meta_updated(&broadcast_tx, vec![record], vec![]);
        }
    });
}

/// Node's `seedFromTerminal` (`server/index.ts:647-655` +
/// `terminal-metadata-service.ts:138-146`) for the REST create pipeline (Fix
/// round 1, Task 23 gap): the full create-time treatment -- relaxed record
/// build ([`record_for_create`]) -> async `enrich_from_cwd` ->
/// `commit_if_changed` -> `terminal.meta.updated {upsert}` broadcast --
/// packaged as ONE call for `freshell-server`'s `main.rs` to wire into
/// `freshell_freshagent::FreshAgentState::with_terminal_created_hook`
/// (`freshell-freshagent` cannot import this crate; the hook closure built
/// where both crates are visible is the seam). The WS `terminal.create` path
/// does NOT call this: it needs the record BEFORE the `terminal.created`
/// frame (identity seeding + `sessionRef` stamping), so it calls the two
/// halves directly -- no double-seeding, since each terminal is created by
/// exactly one of the two paths.
///
/// Must be called from within a tokio runtime (it spawns the enrichment task).
pub fn seed_from_terminal(
    terminal_meta: &TerminalMetaRegistry,
    broadcast_tx: &Arc<tokio::sync::broadcast::Sender<String>>,
    terminal_id: &str,
    mode: &str,
    resume_session_id: Option<&str>,
    cwd: Option<&str>,
) {
    let record = record_for_create(
        terminal_id,
        mode,
        resume_session_id,
        cwd,
        crate::terminal::now_ms(),
    );
    spawn_enrich_commit_broadcast(terminal_meta, broadcast_tx, record);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(terminal_id: &str) -> TerminalMetaRecord {
        TerminalMetaRecord {
            terminal_id: terminal_id.to_string(),
            updated_at: 111,
            branch: Some("main".to_string()),
            checkout_root: Some("/repo".to_string()),
            cwd: Some("/repo/sub".to_string()),
            display_subdir: Some("repo".to_string()),
            is_dirty: Some(true),
            provider: Some("claude".to_string()),
            repo_root: Some("/repo".to_string()),
            session_id: Some("sess-1".to_string()),
            token_usage: None,
        }
    }

    /// `commitIfChanged` + `terminalMetaEquals` (`terminal-metadata-service.ts:93-106,288-301`):
    /// identical content is suppressed no matter what `updatedAt` says; real
    /// content changes commit and are stamped with the commit-time `now`.
    #[test]
    fn commit_if_changed_suppresses_identical_records_ignoring_updated_at() {
        let reg = TerminalMetaRegistry::default();

        // First commit: no previous entry -> stored, stamped with `now`.
        let first = reg
            .commit_if_changed(record("t1"), 1_000)
            .expect("first commit stores and returns the record");
        assert_eq!(first.updated_at, 1_000);

        // Identical content, wildly different updatedAt -> suppressed.
        let mut same = record("t1");
        same.updated_at = 999_999;
        assert_eq!(reg.commit_if_changed(same, 2_000), None);
        assert_eq!(
            reg.get("t1").map(|r| r.updated_at),
            Some(1_000),
            "a suppressed commit must not restamp the stored record"
        );

        // A real content change commits + restamps.
        let mut changed = record("t1");
        changed.branch = Some("feat".to_string());
        let second = reg
            .commit_if_changed(changed, 3_000)
            .expect("changed content commits");
        assert_eq!(second.updated_at, 3_000);
        assert_eq!(second.branch.as_deref(), Some("feat"));
        assert_eq!(
            reg.get("t1").and_then(|r| r.branch),
            Some("feat".to_string())
        );
    }

    /// `retire` (`terminal-metadata-service.ts:203-219`) + the retired-TTL
    /// prune (`:226-234`): git fields + tokenUsage are stripped, identity
    /// fields survive, `list()` excludes retired entries immediately and
    /// prunes them entirely once older than [`RETIRED_TTL_MS`].
    #[test]
    fn retire_strips_git_fields_keeps_identity_and_list_prunes_after_ttl() {
        let reg = TerminalMetaRegistry::default();
        reg.commit_if_changed(record("t1"), 1_000)
            .expect("seed commit");
        assert_eq!(reg.list(1_000).len(), 1);

        assert!(reg.retire("t1", 2_000));
        assert!(!reg.retire("ghost", 2_000), "unknown id retires to false");
        assert!(
            !reg.retire("t1", 2_500),
            "an already-retired entry is a no-op false (single remove frame per lifetime)"
        );

        // list() excludes retired entries...
        assert!(reg.list(2_000).is_empty());
        // ...but get() still answers with the STRIPPED record (service :203-219).
        let got = reg.get("t1").expect("retired entries stay get()-able");
        assert_eq!(got.terminal_id, "t1");
        assert_eq!(got.cwd.as_deref(), Some("/repo/sub"));
        assert_eq!(got.provider.as_deref(), Some("claude"));
        assert_eq!(got.session_id.as_deref(), Some("sess-1"));
        assert_eq!(got.updated_at, 1_000, "retire never restamps updatedAt");
        assert_eq!(got.branch, None);
        assert_eq!(got.checkout_root, None);
        assert_eq!(got.repo_root, None);
        assert_eq!(got.display_subdir, None);
        assert_eq!(got.is_dirty, None);
        assert_eq!(got.token_usage, None);

        // Exactly at the TTL boundary the entry survives (Node: `timestamp < cutoff`)...
        let _ = reg.list(2_000 + RETIRED_TTL_MS);
        assert!(reg.get("t1").is_some());
        // ...one ms past it, the prune removes it entirely.
        let _ = reg.list(2_000 + RETIRED_TTL_MS + 1);
        assert!(reg.get("t1").is_none());
    }

    // Same throwaway-repo fixture pattern as freshell-platform's git_meta tests.
    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn init_repo(dir: &std::path::Path) {
        git(dir, &["init", "-b", "main"]);
        std::fs::write(dir.join("f.txt"), "x").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", "init"]);
    }

    /// `enrichFromCwd` (`terminal-metadata-service.ts:260-286`) against a real
    /// repository: all five derived fields land.
    #[tokio::test]
    async fn enrich_from_cwd_fills_all_five_fields_for_a_real_repo() {
        let t = tempfile::tempdir().unwrap();
        init_repo(t.path());
        let canonical = t.path().canonicalize().unwrap();

        let mut record = TerminalMetaRecord {
            terminal_id: "t1".to_string(),
            updated_at: 0,
            branch: None,
            checkout_root: None,
            cwd: Some(t.path().to_string_lossy().into_owned()),
            display_subdir: None,
            is_dirty: None,
            provider: None,
            repo_root: None,
            session_id: None,
            token_usage: None,
        };
        enrich_from_cwd(&mut record).await;

        assert_eq!(record.branch.as_deref(), Some("main"));
        assert_eq!(record.is_dirty, Some(false));
        assert_eq!(record.checkout_root.as_deref(), canonical.to_str());
        assert_eq!(record.repo_root.as_deref(), canonical.to_str());
        let basename = canonical.file_name().unwrap().to_string_lossy();
        assert_eq!(record.display_subdir.as_deref(), Some(basename.as_ref()));
    }

    /// `enrichFromCwd`'s falsy-cwd arm (`terminal-metadata-service.ts:262-269`):
    /// the three root fields are cleared, branch/isDirty are left alone, and
    /// no git runs.
    #[tokio::test]
    async fn enrich_from_cwd_with_no_cwd_clears_root_fields() {
        let mut record = record_with_roots(None);
        enrich_from_cwd(&mut record).await;
        assert_eq!(record.checkout_root, None);
        assert_eq!(record.repo_root, None);
        assert_eq!(record.display_subdir, None);
        assert_eq!(record.branch.as_deref(), Some("stale-branch"));
        assert_eq!(record.is_dirty, Some(true));

        // JS `if (!cwd)`: the empty string is falsy too.
        let mut record = record_with_roots(Some(String::new()));
        enrich_from_cwd(&mut record).await;
        assert_eq!(record.checkout_root, None);
        assert_eq!(record.repo_root, None);
        assert_eq!(record.display_subdir, None);
    }

    fn record_with_roots(cwd: Option<String>) -> TerminalMetaRecord {
        TerminalMetaRecord {
            terminal_id: "t1".to_string(),
            updated_at: 0,
            branch: Some("stale-branch".to_string()),
            checkout_root: Some("/old/root".to_string()),
            cwd,
            display_subdir: Some("old".to_string()),
            is_dirty: Some(true),
            provider: None,
            repo_root: Some("/old/root".to_string()),
            session_id: None,
            token_usage: None,
        }
    }

    /// Fix round 1 (Task 23 gap): `seed_from_terminal` -- the Node
    /// `seedFromTerminal` analog `freshell-server` wires into the REST
    /// create path's terminal-created hook -- must run the FULL create-time
    /// pipeline the WS `terminal.create` path gets: relaxed record build ->
    /// async `enrich_from_cwd` (real git probes) -> `commit_if_changed` ->
    /// `terminal.meta.updated {upsert}` broadcast. No PTY involved.
    #[tokio::test]
    async fn seed_from_terminal_commits_enriched_record_and_broadcasts_upsert() {
        let t = tempfile::tempdir().unwrap();
        init_repo(t.path());
        // Dirty it: the branch badge's `*` half must survive the pipeline.
        std::fs::write(t.path().join("f.txt"), "dirty").unwrap();
        let canonical = t.path().canonicalize().unwrap();

        let reg = TerminalMetaRegistry::default();
        let tx = Arc::new(tokio::sync::broadcast::channel::<String>(4).0);
        let mut rx = tx.subscribe();

        seed_from_terminal(
            &reg,
            &tx,
            "t-rest",
            "shell",
            None,
            Some(&t.path().to_string_lossy()),
        );

        // The enrichment task is async off the create path; the broadcast is
        // its completion signal (exactly one frame per fresh terminal --
        // `commit_if_changed` on a fresh id always changes).
        let frame = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
            .await
            .expect("terminal.meta.updated within 30s")
            .expect("broadcast channel open");
        let msg: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["type"], serde_json::json!("terminal.meta.updated"));
        assert_eq!(msg["remove"], serde_json::json!([]));
        let upsert = msg["upsert"].as_array().expect("upsert array");
        assert_eq!(upsert.len(), 1);
        assert_eq!(upsert[0]["terminalId"], serde_json::json!("t-rest"));
        assert_eq!(upsert[0]["branch"], serde_json::json!("main"));
        assert_eq!(upsert[0]["isDirty"], serde_json::json!(true));
        assert_eq!(
            upsert[0]["checkoutRoot"],
            serde_json::json!(canonical.to_str().unwrap())
        );
        // A shell terminal seeds WITHOUT provider/sessionId (Node
        // `isTerminalProvider` gate) -- absent fields are skipped on the wire.
        assert!(upsert[0].get("provider").is_none());
        assert!(upsert[0].get("sessionId").is_none());

        // The registry holds the SAME enriched record (this is what the WS
        // handshake's `terminal_meta.list()` serves to late-connecting
        // clients -- the reload-persistence leg of the badge feature).
        let stored = reg.get("t-rest").expect("record committed");
        assert_eq!(stored.branch.as_deref(), Some("main"));
        assert_eq!(stored.is_dirty, Some(true));
        assert_eq!(stored.provider, None);
    }

    /// `selectMoreSpecificCwd` (`terminal-metadata-service.ts:63-76`).
    #[test]
    fn select_more_specific_cwd_prefers_deeper_nested_path_and_session_when_unrelated() {
        // one side missing -> the other (normalized)
        assert_eq!(
            select_more_specific_cwd(None, Some("/a/b/")),
            Some("/a/b".to_string())
        );
        assert_eq!(
            select_more_specific_cwd(Some("/a/b/"), None),
            Some("/a/b".to_string())
        );
        assert_eq!(select_more_specific_cwd(None, None), None);
        // nested either way -> the deeper path wins
        assert_eq!(
            select_more_specific_cwd(Some("/a/b"), Some("/a/b/wt")),
            Some("/a/b/wt".to_string())
        );
        assert_eq!(
            select_more_specific_cwd(Some("/a/b/wt"), Some("/a/b")),
            Some("/a/b/wt".to_string())
        );
        // equal -> that path
        assert_eq!(
            select_more_specific_cwd(Some("/a/b"), Some("/a/b/")),
            Some("/a/b".to_string())
        );
        // unrelated -> the session cwd
        assert_eq!(
            select_more_specific_cwd(Some("/spawned/here"), Some("/actually/working/here")),
            Some("/actually/working/here".to_string())
        );
        // sibling with a shared name prefix is NOT "inside" (/a/bc vs /a/b)
        assert_eq!(
            select_more_specific_cwd(Some("/a/b"), Some("/a/bc")),
            Some("/a/bc".to_string())
        );
    }

    /// `broadcastTerminalMetaUpdated` remove-arm wire shape
    /// (`server/index.ts:627-629` -> `ws-handler.ts:3682-3695`), plus the
    /// empty-payload no-op guard (`server/index.ts:622-625`).
    #[tokio::test]
    async fn broadcast_helper_emits_remove_frames_and_skips_empty_payloads() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(4);

        broadcast_terminal_meta_updated(&tx, vec![], vec!["t9".to_string()]);
        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(
            frame,
            serde_json::json!({
                "type": "terminal.meta.updated",
                "remove": ["t9"],
                "upsert": [],
            })
        );

        broadcast_terminal_meta_updated(&tx, vec![], vec![]);
        assert!(
            matches!(
                rx.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "an all-empty payload must not emit a frame"
        );
    }
}
