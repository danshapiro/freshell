//! Shared terminal-identity registry -- the port-side analog of
//! `server/terminal-metadata-service.ts`'s `provider`/`sessionId` association slice.
//!
//! **Scope, honestly bounded.** This is NOT a full port of `TerminalMetadataService`
//! (no git enrichment, no `associateSession`/late `terminal.session.bound` wiring --
//! see `terminal.rs`'s `terminal_meta_record_for_create` doc for what's deferred and
//! why). It exists to close the "Fix Spec: Session Naming Cluster" gap: the rename
//! cascades (`terminals.rs`'s forward cascade, `sessions.rs`'s reverse cascade) and
//! the session-directory live-terminal join (`session_directory.rs`) all need to ask
//! "does this terminal have a coding-CLI session identity, and is it still live?" --
//! exactly the two queries `TerminalMetadataService.get()`/`.list()` answer in the
//! original (`terminal-metadata-service.ts:128-136`).
//!
//! Two semantics, ported faithfully because callers depend on the distinction:
//! * [`TerminalIdentityRegistry::get`] -- returns an entry EVEN IF retired (a
//!   terminal's provider/sessionId survives process exit, `terminal-metadata-service.ts:203-219`,
//!   so a rename cascade still finds the session after the terminal exits,
//!   `server/index.ts:526-534`).
//! * [`TerminalIdentityRegistry::list`]/[`find_by_session`] -- exclude retired
//!   entries (`TerminalMetadataService.list()` filters `retiredAt`,
//!   `terminal-metadata-service.ts:128-132`), matching the reverse cascade's
//!   live-only lookup (`deps.terminalMetadata.list()`, `sessions-router.ts:149`)
//!   and the session-directory join's live-terminal set (`service.ts:77-151`).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use freshell_protocol::SessionLocator;

/// One terminal's coding-CLI session identity, as known to this port. A faithful
/// subset of `TerminalMeta` (`terminal-metadata-service.ts:19-31`): only the fields
/// the rename cascades and the session-directory join actually consume.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalIdentity {
    pub terminal_id: String,
    pub provider: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: i64,
    /// `retiredAt.has(terminalId)` (`terminal-metadata-service.ts:130`): the
    /// terminal process exited, but the provider/sessionId association (and cwd)
    /// are deliberately preserved -- `retire()`'s doc explains why.
    pub retired: bool,
    /// `Some(true)` when this terminal's resume target is an opencode
    /// SUBAGENT (child) session — display classification for the sidebar
    /// rail (`showSubagents` filter). `None` = unclassified. Recomputed
    /// whenever the resume target changes (create, respawn, signal rebind,
    /// REST bind); preserved across plain upserts. Never consulted by
    /// association logic.
    pub is_subagent: Option<bool>,
    /// Out-of-order guard for the async classification writes feeding
    /// [`Self::is_subagent`] (Bug-1 review): the latest classification
    /// REQUEST generation for this terminal. Advanced synchronously by
    /// [`TerminalIdentityRegistry::begin_subagent_classification`] at
    /// request time; an async answer writes only while its captured
    /// generation is still current
    /// ([`TerminalIdentityRegistry::complete_subagent_classification`]),
    /// so the newest request wins regardless of resolution order. Private:
    /// bookkeeping between the two registry methods, not identity data.
    /// Memory hygiene: rides the identity entry itself (entries are
    /// retained-on-retire by design, see [`TerminalIdentityRegistry::retire`]),
    /// so it adds no new growth beyond the map that already exists.
    classify_generation: u64,
}

/// The minimal entry created when a write lands before the terminal's first
/// identity upsert (classification and its generation guard can both fire
/// before the create-path seed — terminal.rs orders the classify hook ahead
/// of `identity.upsert`).
fn minimal_entry(terminal_id: &str) -> TerminalIdentity {
    TerminalIdentity {
        terminal_id: terminal_id.to_string(),
        provider: None,
        session_id: None,
        cwd: None,
        updated_at: 0,
        retired: false,
        is_subagent: None,
        classify_generation: 0,
    }
}

/// Shared, cheaply-cloneable registry (`Arc<RwLock<..>>`), analogous to
/// [`freshell_terminal::TerminalRegistry`]'s sharing model: one instance
/// constructed in `freshell-server::main`, cloned into `WsState` (the writer --
/// terminal create/kill/exit) and into the `freshell-server` REST states that read
/// it (`TerminalsState`, `SessionsState`, `SessionDirectoryState`).
#[derive(Clone, Debug, Default)]
pub struct TerminalIdentityRegistry {
    inner: Arc<RwLock<HashMap<String, TerminalIdentity>>>,
}

impl TerminalIdentityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// `TerminalMetadataService.seedFromTerminal`/`upsert`
    /// (`terminal-metadata-service.ts:138-146,236-258`): (re)establish an entry,
    /// un-retiring it if it was previously retired (matches the original: a
    /// resumed/reused terminalId re-seeding clears any stale retirement).
    pub fn upsert(
        &self,
        terminal_id: &str,
        provider: Option<&str>,
        session_id: Option<&str>,
        cwd: Option<&str>,
        updated_at: i64,
    ) {
        let mut map = self.inner.write().expect("identity registry lock poisoned");
        match map.get_mut(terminal_id) {
            Some(entry) => {
                // Full replacement of the association fields (the signal
                // rebinds upsert a NEW session_id over the old one and
                // depend on replacement) + un-retire-on-reseed; the display
                // classification (`is_subagent`) is carried forward
                // UNCHANGED -- classification is recomputed only at
                // resume-target acquisition, never wiped by a plain upsert.
                entry.provider = provider.map(str::to_string);
                entry.session_id = session_id.map(str::to_string);
                entry.cwd = cwd.map(str::to_string);
                entry.updated_at = updated_at;
                entry.retired = false;
            }
            None => {
                map.insert(
                    terminal_id.to_string(),
                    TerminalIdentity {
                        provider: provider.map(str::to_string),
                        session_id: session_id.map(str::to_string),
                        cwd: cwd.map(str::to_string),
                        updated_at,
                        ..minimal_entry(terminal_id)
                    },
                );
            }
        }
    }

    /// Set the subagent display classification. Creates a minimal entry when
    /// the terminal has no identity yet (classification can land before the
    /// first provider/session upsert); otherwise patches the existing entry
    /// in place without touching provider/session/cwd.
    pub fn set_is_subagent(&self, terminal_id: &str, value: Option<bool>) {
        let mut map = self.inner.write().expect("identity registry lock poisoned");
        let entry = map
            .entry(terminal_id.to_string())
            .or_insert_with(|| minimal_entry(terminal_id));
        entry.is_subagent = value;
        entry.updated_at = crate::terminal::now_ms();
    }

    /// Out-of-order guard, request half (Bug-1 review): atomically advance
    /// and return this terminal's subagent-classification generation. Call
    /// SYNCHRONOUSLY at the moment a classification request is made (before
    /// any async resolution), so the program order of requests is captured
    /// even though their answers may resolve out of order. Creates a
    /// minimal entry when the terminal has no identity yet — the WS
    /// create-path hook fires before the identity seed (terminal.rs), so
    /// requiring an existing entry would wrongly invalidate legitimate
    /// create-path classifications.
    pub fn begin_subagent_classification(&self, terminal_id: &str) -> u64 {
        let mut map = self.inner.write().expect("identity registry lock poisoned");
        let entry = map
            .entry(terminal_id.to_string())
            .or_insert_with(|| minimal_entry(terminal_id));
        entry.classify_generation += 1;
        entry.classify_generation
    }

    /// Out-of-order guard, answer half (Bug-1 review): write the subagent
    /// classification IFF `generation` is still this terminal's latest —
    /// newest-request-wins regardless of resolution order. Returns whether
    /// the write happened, so callers gate their change broadcast on it.
    /// The compare-and-write is atomic under the registry lock: a stale
    /// answer can never land after a newer one.
    pub fn complete_subagent_classification(
        &self,
        terminal_id: &str,
        generation: u64,
        value: Option<bool>,
    ) -> bool {
        let mut map = self.inner.write().expect("identity registry lock poisoned");
        match map.get_mut(terminal_id) {
            Some(entry) if entry.classify_generation == generation => {
                entry.is_subagent = value;
                entry.updated_at = crate::terminal::now_ms();
                true
            }
            // Entry missing (nothing ever removes entries, so only possible
            // if begin() was never called) or a newer request superseded
            // this one: skip the write.
            _ => false,
        }
    }

    /// `TerminalMetadataService.retire` (`terminal-metadata-service.ts:203-219`):
    /// called on terminal exit (kill or natural). Strips nothing this port tracks
    /// beyond marking `retired` -- `terminal_id`/`cwd`/`provider`/`session_id`/
    /// `updated_at` are ALL preserved, exactly like the original's explicit
    /// "preserve the provider/sessionId association so rename cascades can still
    /// find the session after the terminal exits" comment
    /// (`terminal-metadata-service.ts:207-208`). `false` for an unknown id (no-op,
    /// matching the original's `if (!entry) return false`).
    pub fn retire(&self, terminal_id: &str) -> bool {
        let mut map = self.inner.write().expect("identity registry lock poisoned");
        match map.get_mut(terminal_id) {
            Some(entry) => {
                entry.retired = true;
                true
            }
            None => false,
        }
    }

    /// `TerminalMetadataService.get` (`terminal-metadata-service.ts:134-136`):
    /// returns the entry regardless of retirement -- the forward cascade
    /// (`terminals.rs`'s patch_terminal) uses this so a title patch on an
    /// ALREADY-EXITED terminal still cascades to its session
    /// (`terminals-router.ts:311` `.get?.(terminalId) ?? .list().find(...)`).
    pub fn get(&self, terminal_id: &str) -> Option<TerminalIdentity> {
        self.inner
            .read()
            .expect("identity registry lock poisoned")
            .get(terminal_id)
            .cloned()
    }

    /// `TerminalMetadataService.list` (`terminal-metadata-service.ts:128-132`):
    /// every LIVE (non-retired) identity, in insertion-order-independent order (the
    /// original's `Map` iteration order isn't semantically relied on by any caller
    /// -- both `findTerminalForSession` and the session-directory join treat this
    /// as an unordered set).
    pub fn list(&self) -> Vec<TerminalIdentity> {
        self.inner
            .read()
            .expect("identity registry lock poisoned")
            .values()
            .filter(|entry| !entry.retired)
            .cloned()
            .collect()
    }

    /// The canonical wire `sessionRef` for a terminal, when (and only when)
    /// its identity is FULLY resolved -- both `provider` and `session_id`
    /// present. This is the single derivation every identity-stamped frame
    /// (`terminal.created` / `terminal.inventory` / `terminal.attach.ready`)
    /// uses, closing the dead-repair-channel gap the state-sync cartography
    /// mapped (`docs/plans/2026-07-19-state-sync-cartography.md` §1.4):
    /// shell terminals never get an entry here (create-time seeding skips
    /// them), so they are never stamped. Deliberately uses [`Self::get`]
    /// (retired entries INCLUDED): an exited terminal listed in the
    /// inventory keeps its durable identity, exactly like the rename
    /// cascade's post-exit lookup.
    pub fn session_ref_for(&self, terminal_id: &str) -> Option<SessionLocator> {
        let entry = self.get(terminal_id)?;
        match (entry.provider, entry.session_id) {
            (Some(provider), Some(session_id)) => Some(SessionLocator {
                provider,
                session_id,
            }),
            _ => None,
        }
    }

    /// `findTerminalForSession` (`rename-cascade.ts:9-17`) over the LIVE set
    /// (`.list()`, matching the reverse cascade's `deps.terminalMetadata.list()`
    /// input, `sessions-router.ts:149`): the terminal, if any, currently running
    /// this exact `provider:sessionId`.
    pub fn find_by_session(&self, provider: &str, session_id: &str) -> Option<TerminalIdentity> {
        self.list().into_iter().find(|entry| {
            entry.provider.as_deref() == Some(provider)
                && entry.session_id.as_deref() == Some(session_id)
        })
    }

    /// Guard 3b's retired-INCLUSIVE session lookup (P0.3, ledger A8): the
    /// terminal id -- live OR retired -- bound to this exact
    /// `provider:sessionId`. Unlike [`Self::find_by_session`] (live-only,
    /// serving the rename cascade), this serves the hijack guard: a session
    /// identity, once bound, may never be claimed by a DIFFERENT terminal,
    /// even after its owner exits (dead-pane candidate replay). Breaks no
    /// legitimate flow: every legit resume binds at create time, so a
    /// re-announce short-circuits at guard 3a's same-terminal check before
    /// this cross-terminal check runs.
    pub(crate) fn find_by_session_including_retired(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Option<String> {
        self.inner
            .read()
            .expect("identity registry lock poisoned")
            .values()
            .find(|entry| {
                entry.provider.as_deref() == Some(provider)
                    && entry.session_id.as_deref() == Some(session_id)
            })
            .map(|entry| entry.terminal_id.clone())
    }

    /// All LIVE terminals bound to (provider, session_id), cwd-scoped for
    /// cwd-scoped session modes. Port of Node's 3-arg
    /// `server/terminal-registry.ts::findTerminalsBySession` (:4538) +
    /// `matchesScopedSession` (:442-447): when `isCwdScopedSessionMode(mode)` —
    /// true precisely for `claude` (:410-412) — the terminal's normalized cwd
    /// must equal the session's. Absent session cwd (`cwd == None`) skips the
    /// cwd check; a terminal without a cwd while the session HAS one is
    /// excluded. Callers pass `session.cwd` (server/index.ts:841, :884).
    /// Unlike `find_by_session`, returns every match.
    pub fn find_all_by_session(
        &self,
        provider: &str,
        session_id: &str,
        cwd: Option<&str>,
    ) -> Vec<TerminalIdentity> {
        // isCwdScopedSessionMode (terminal-registry.ts:410-412): claude only.
        let scoped = provider == "claude";
        let session_cwd = cwd.filter(|c| !c.is_empty()).map(normalize_scoped_cwd);
        self.list()
            .into_iter()
            .filter(|t| {
                if t.provider.as_deref() != Some(provider)
                    || t.session_id.as_deref() != Some(session_id)
                {
                    return false;
                }
                if !scoped {
                    return true;
                }
                match &session_cwd {
                    None => true, // absent session cwd -> cwd check skipped
                    Some(want) => t
                        .cwd
                        .as_deref()
                        .map(normalize_scoped_cwd)
                        .is_some_and(|have| have == *want), // no terminal cwd -> excluded
                }
            })
            .collect()
    }
}

/// D7 guard seam: expose this registry to `TerminalRegistry::live_session_owner`
/// (and, via `freshell-server` wiring, to the REST spawn guard in
/// `freshell-freshagent`, which cannot depend on this crate directly).
/// Exactly reproduces the WS guard's identity arm: `find_by_session` -> owner
/// terminal_id (liveness is probed by the shared predicate, not here).
impl freshell_terminal::registry::SessionIdentityLookup for TerminalIdentityRegistry {
    fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String> {
        self.find_by_session(provider, session_id)
            .map(|owner| owner.terminal_id)
    }
}

/// `normalizeScopedSessionCwd` (terminal-registry.ts:414-431): realpath
/// (native preferred, lexical fallback on error) -> backslashes to `/` ->
/// strip trailing slashes -> lowercase on win32.
fn normalize_scoped_cwd(cwd: &str) -> String {
    let resolved = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string());
    let mut s = resolved.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_then_get_roundtrips_all_fields() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("sess-1"), Some("/repo"), 1000);
        let got = reg.get("t1").expect("present");
        assert_eq!(got.terminal_id, "t1");
        assert_eq!(got.provider.as_deref(), Some("claude"));
        assert_eq!(got.session_id.as_deref(), Some("sess-1"));
        assert_eq!(got.cwd.as_deref(), Some("/repo"));
        assert_eq!(got.updated_at, 1000);
        assert!(!got.retired);
    }

    #[test]
    fn get_of_unknown_terminal_is_none() {
        let reg = TerminalIdentityRegistry::new();
        assert!(reg.get("nope").is_none());
    }

    #[test]
    fn list_excludes_retired_but_get_still_finds_it() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("codex"), Some("sess-9"), None, 5);
        assert_eq!(reg.list().len(), 1);

        assert!(reg.retire("t1"));

        // list() -- the reverse-cascade / session-directory live set -- excludes it.
        assert!(reg.list().is_empty());
        // get() -- the forward-cascade lookup -- still finds it, retired.
        let got = reg.get("t1").expect("retained after retire");
        assert!(got.retired);
        assert_eq!(got.provider.as_deref(), Some("codex"));
        assert_eq!(got.session_id.as_deref(), Some("sess-9"));
    }

    #[test]
    fn retire_of_unknown_terminal_returns_false_and_is_a_noop() {
        let reg = TerminalIdentityRegistry::new();
        assert!(!reg.retire("ghost"));
        assert!(reg.list().is_empty());
    }

    #[test]
    fn find_by_session_matches_live_terminal_only() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("live", Some("claude"), Some("s1"), None, 1);
        reg.upsert("exited", Some("claude"), Some("s2"), None, 2);
        reg.retire("exited");

        assert_eq!(
            reg.find_by_session("claude", "s1").map(|m| m.terminal_id),
            Some("live".to_string())
        );
        // A retired terminal's session is no longer a live match (the reverse
        // cascade only rewrites a terminal title on a CURRENTLY RUNNING terminal).
        assert!(reg.find_by_session("claude", "s2").is_none());
    }

    #[test]
    fn find_by_session_including_retired_matches_retired_terminal() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("exited", Some("codex"), Some("s2"), None, 2);
        reg.retire("exited");

        // Live-only lookup misses it (rename-cascade semantics)...
        assert!(reg.find_by_session("codex", "s2").is_none());
        // ...but the guard-3b lookup still finds the binding.
        assert_eq!(
            reg.find_by_session_including_retired("codex", "s2"),
            Some("exited".to_string())
        );
    }

    #[test]
    fn find_by_session_no_match_is_none() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s1"), None, 1);
        assert!(reg.find_by_session("codex", "s1").is_none());
        assert!(reg.find_by_session("claude", "other").is_none());
    }

    #[test]
    fn session_ref_for_requires_both_provider_and_session_id() {
        let reg = TerminalIdentityRegistry::new();
        assert!(reg.session_ref_for("unknown").is_none());

        reg.upsert("partial", Some("amplifier"), None, None, 1);
        assert!(reg.session_ref_for("partial").is_none());

        reg.upsert("full", Some("amplifier"), Some("sess-1"), None, 2);
        assert_eq!(
            reg.session_ref_for("full"),
            Some(SessionLocator {
                provider: "amplifier".to_string(),
                session_id: "sess-1".to_string(),
            })
        );
    }

    #[test]
    fn session_ref_for_survives_retirement() {
        // An exited terminal keeps its durable identity on frames that still
        // list it (inventory rows with status 'exited').
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("sess-9"), None, 1);
        reg.retire("t1");
        assert_eq!(
            reg.session_ref_for("t1").map(|r| r.session_id),
            Some("sess-9".to_string())
        );
    }

    #[test]
    fn set_is_subagent_creates_minimal_entry_and_upsert_preserves_it() {
        let registry = TerminalIdentityRegistry::new();

        // Setter on a terminal with no identity entry yet: creates minimal entry.
        registry.set_is_subagent("t-sub", Some(true));
        assert_eq!(registry.get("t-sub").unwrap().is_subagent, Some(true));

        // A later upsert (association writes provider/session) must PRESERVE it.
        registry.upsert(
            "t-sub",
            Some("opencode"),
            Some("ses_x"),
            Some("/repo"),
            1_000,
        );
        let identity = registry.get("t-sub").unwrap();
        assert_eq!(identity.is_subagent, Some(true));
        assert_eq!(identity.provider.as_deref(), Some("opencode"));

        // Unclassified terminals stay None.
        registry.upsert(
            "t-plain",
            Some("opencode"),
            Some("ses_y"),
            Some("/repo"),
            1_000,
        );
        assert_eq!(registry.get("t-plain").unwrap().is_subagent, None);
    }

    #[test]
    fn stale_subagent_classification_cannot_overwrite_a_newer_request() {
        let reg = TerminalIdentityRegistry::new();

        // Two rapid classification requests for the same terminal, in
        // program order: A (old resume target), then B (new resume target).
        let gen_a = reg.begin_subagent_classification("t1");
        let gen_b = reg.begin_subagent_classification("t1");
        assert!(gen_b > gen_a, "generations must advance monotonically");

        // B's answer resolves FIRST and writes.
        assert!(reg.complete_subagent_classification("t1", gen_b, Some(false)));
        assert_eq!(reg.get("t1").unwrap().is_subagent, Some(false));

        // A's answer lands LATE: newest-request-wins, so it must be skipped.
        assert!(!reg.complete_subagent_classification("t1", gen_a, Some(true)));
        assert_eq!(reg.get("t1").unwrap().is_subagent, Some(false));
    }

    #[test]
    fn create_path_identity_seed_does_not_invalidate_an_in_flight_classification() {
        let reg = TerminalIdentityRegistry::new();

        // The WS create-path hook begins classification BEFORE the identity
        // seed lands (terminal.rs: classify_and_mark_resume_target fires
        // before identity.upsert), so the upsert must PRESERVE the
        // classification generation — resetting it would wrongly skip every
        // legitimate create-path write.
        let generation = reg.begin_subagent_classification("t1");
        reg.upsert("t1", Some("opencode"), Some("ses_x"), Some("/repo"), 1_000);

        assert!(reg.complete_subagent_classification("t1", generation, Some(true)));
        assert_eq!(reg.get("t1").unwrap().is_subagent, Some(true));
    }

    #[test]
    fn upsert_over_a_retired_entry_un_retires_it() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s1"), None, 1);
        reg.retire("t1");
        assert!(reg.list().is_empty());

        reg.upsert("t1", Some("claude"), Some("s1"), None, 2);
        assert_eq!(reg.list().len(), 1);
    }

    #[test]
    fn identity_registry_feeds_live_session_owner_join() {
        let registry = freshell_terminal::TerminalRegistry::new();
        registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: "t-live".into(),
            stream_id: "s-live".into(),
            mode: "codex".into(),
            resume_session_id: None, // fresh pane: row carries no resume id
            create_request_id: None,
            created_at: None,
        });
        let identity = TerminalIdentityRegistry::new();
        identity.upsert("t-live", Some("codex"), Some("sess-live-1"), None, 0);

        assert_eq!(
            registry.live_session_owner(Some(&identity), "codex", "sess-live-1"),
            Some("t-live".to_string()),
            "identity-registry-bound session of a Running terminal must be live"
        );

        // Retired bindings must not count (mirrors d9b71f50's negative pin).
        assert!(identity.retire("t-live"));
        assert_eq!(
            registry.live_session_owner(Some(&identity), "codex", "sess-live-1"),
            None,
            "a retired identity binding must not block resume"
        );

        registry.kill("t-live");
    }

    #[test]
    fn find_all_by_session_scopes_claude_by_normalized_cwd_and_skips_retired() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s1"), Some("/a"), 1);
        reg.upsert("t2", Some("claude"), Some("s1"), Some("/a/"), 2); // trailing slash normalizes equal
        reg.upsert("t3", Some("claude"), Some("s1"), Some("/b"), 3); // different cwd -> excluded when scoped
        reg.upsert("t4", Some("claude"), Some("s1"), None, 4); // no terminal cwd while session cwd present -> excluded
        reg.upsert("t5", Some("codex"), Some("s1"), Some("/a"), 5); // provider mismatch for the claude query
        reg.upsert("t6", Some("claude"), Some("s2"), Some("/a"), 6); // session mismatch
        reg.upsert("t7", Some("claude"), Some("s1"), Some("/a"), 7);
        reg.retire("t7");
        let mut ids: Vec<String> = reg
            .find_all_by_session("claude", "s1", Some("/a"))
            .into_iter()
            .map(|t| t.terminal_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
        // absent session cwd -> the cwd check is skipped entirely
        let mut all: Vec<String> = reg
            .find_all_by_session("claude", "s1", None)
            .into_iter()
            .map(|t| t.terminal_id)
            .collect();
        all.sort();
        assert_eq!(
            all,
            vec![
                "t1".to_string(),
                "t2".to_string(),
                "t3".to_string(),
                "t4".to_string()
            ]
        );
        // non-cwd-scoped provider (codex) ignores cwd even when both sides carry one
        let codex: Vec<String> = reg
            .find_all_by_session("codex", "s1", Some("/zzz"))
            .into_iter()
            .map(|t| t.terminal_id)
            .collect();
        assert_eq!(codex, vec!["t5".to_string()]);
    }
}
