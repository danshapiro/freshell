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
}

/// Shared, cheaply-cloneable registry (`Arc<RwLock<..>>`), analogous to
/// [`freshell_terminal::TerminalRegistry`]'s sharing model: one instance
/// constructed in `freshell-server::main`, cloned into `WsState` (the writer --
/// terminal create/kill/exit) and into the `freshell-server` REST states that read
/// it (`TerminalsState`, `SessionsState`, `SessionDirectoryState`).
#[derive(Clone, Default)]
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
        map.insert(
            terminal_id.to_string(),
            TerminalIdentity {
                terminal_id: terminal_id.to_string(),
                provider: provider.map(str::to_string),
                session_id: session_id.map(str::to_string),
                cwd: cwd.map(str::to_string),
                updated_at,
                retired: false,
            },
        );
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
    fn upsert_over_a_retired_entry_un_retires_it() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s1"), None, 1);
        reg.retire("t1");
        assert!(reg.list().is_empty());

        reg.upsert("t1", Some("claude"), Some("s1"), None, 2);
        assert_eq!(reg.list().len(), 1);
    }
}
