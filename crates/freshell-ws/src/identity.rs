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
use std::sync::{Arc, Mutex, RwLock};

use freshell_freshagent::naming::{NamingSink, SessionNaming};
use freshell_protocol::session_names::SessionNameRef;
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
    /// Unified agent names (Task 2): the naming identity this terminal's
    /// saved name resolves through — the pre-durable pending handle before
    /// verified materialization, the durable provider/session ref after.
    /// Written at scoped create (pending admission); advanced onto the
    /// durable identity by the verified bind lanes (`bind_pending_naming`,
    /// the main.rs naming tick), which own the pending→durable transition;
    /// retargeted onto a NEW durable session by the identity upsert's
    /// switch rule (an already-durable ref follows its current binding).
    /// Read by every rename route/projection resolver.
    /// `None` on terminals outside the six unified modes.
    pub name_ref: Option<SessionNameRef>,
    /// Unified agent names: the pre-durable naming handle retained for the
    /// reconcile/bind lanes (kept alongside `name_ref` because a bound
    /// pending ref redirects, while an UNBOUND one still needs its handle
    /// discoverable for the tick's durability-driven bind).
    pub naming_handle: Option<String>,
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
        name_ref: None,
        naming_handle: None,
        classify_generation: 0,
    }
}

/// Shared, cheaply-cloneable registry (`Arc<RwLock<..>>`), analogous to
/// [`freshell_terminal::TerminalRegistry`]'s sharing model: one instance
/// constructed in `freshell-server::main`, cloned into `WsState` (the writer --
/// terminal create/kill/exit) and into the `freshell-server` REST states that read
/// it (`TerminalsState`, `SessionsState`, `SessionDirectoryState`).
///
/// Unified agent names (Task 2): the registry ALSO carries the injected
/// naming authority ([`Self::set_session_naming`]). It is the one shared
/// handle every rename route (session/terminal/pane/tab) and every name
/// projection already reaches through, so the sink rides here instead of a
/// new `WsState` field (whose ~64 exhaustive literals live in test files
/// outside this task's file list) — the same "one shared handle, many
/// readers" model this registry already serves for identity. Unwired
/// (`None`) is the "scoped naming fails unavailable" state every
/// out-of-scope test keeps by default.
#[derive(Clone, Debug, Default)]
pub struct TerminalIdentityRegistry {
    inner: Arc<RwLock<HashMap<String, TerminalIdentity>>>,
    naming: NamingSink,
    /// T2-M6 (Task 3): per-terminal codex homes captured from a PROXIED
    /// upstream `initialize` response — the initialized root that
    /// terminal's rollouts live under, preferred over ambient env by the
    /// naming bind lane's rollout walk and the native-name adapter's
    /// root-match policy.
    codex_homes: Arc<RwLock<HashMap<String, String>>>,
    /// Per-registry memo: raw cwd string -> normalized cwd string
    /// ([`normalize_scoped_cwd`]). Shared across clones like `inner`, so one
    /// registry instance (the process-wide `WsState` clone family) resolves
    /// each distinct cwd on disk ONCE instead of once per session per ~5s
    /// auto-title sweep pass — eager per-call canonicalization stalled the
    /// async runtime 0.4-2s per resolution on WSL2 9P-mounted,
    /// cloud-sync-backed cwds (the FRESHELL host-stats `lagging` toggle root
    /// cause). Deliberately unbounded: keyed by distinct cwd strings, which
    /// a machine produces at most in the hundreds. Values are stable per
    /// raw key: a symlink retarget after first resolution keeps serving the
    /// first target for that raw spelling. Sides spelled differently (link
    /// vs target) can therefore diverge from eager-canonicalize behavior
    /// after a retarget — a permanent match miss for that pair until the
    /// raw strings change, accepted over reintroducing the per-call stall.
    cwd_memo: Arc<Mutex<HashMap<String, String>>>,
}

/// The durable session name ref for a scoped provider id (the named
/// providers reuse the structured provider/session identity — no new
/// restore identity). `None` for every non-scoped provider: a gemini/kimi/
/// amplifier association must NEVER retarget a pane's naming binding.
fn named_session_ref(provider: &str, session_id: &str) -> Option<SessionNameRef> {
    freshell_freshagent::naming::named_provider_for(Some(provider), None).map(|named| {
        SessionNameRef::Session {
            provider: named,
            session_id: session_id.to_string(),
        }
    })
}

impl TerminalIdentityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Unified agent names (Task 2): wire the naming authority (set-once;
    /// later calls are no-ops). `freshell-server::main` injects the ONE
    /// `SessionNames` store participant here, so the WS composition, every
    /// REST rename route, and the projections share the same authority.
    pub fn set_session_naming(&self, sink: std::sync::Arc<dyn SessionNaming>) -> bool {
        self.naming.set(sink)
    }

    /// The wired naming authority, if any (`None` = scoped naming fails
    /// unavailable).
    pub fn naming(&self) -> Option<std::sync::Arc<dyn SessionNaming>> {
        self.naming.get()
    }

    /// Whether a naming authority is wired.
    pub fn naming_wired(&self) -> bool {
        self.naming.is_wired()
    }

    /// T2-M6 (Task 3): capture the `codexHome` a PROXIED upstream
    /// `initialize` reported for this terminal's connection — the
    /// initialized root its rollouts live under, never re-derived from
    /// ambient env. Recorded before any candidate can adopt, so the
    /// adoption/bind lane correlates the rollout walk against it.
    pub fn record_codex_home(&self, terminal_id: &str, codex_home: &str) {
        if codex_home.is_empty() {
            return;
        }
        self.codex_homes
            .write()
            .expect("identity registry lock poisoned")
            .insert(terminal_id.to_string(), codex_home.to_string());
    }

    /// T2-M6 (Task 3): the captured proxied initialize root for this
    /// terminal, when one was observed.
    pub fn codex_home_of(&self, terminal_id: &str) -> Option<String> {
        self.codex_homes
            .read()
            .expect("identity registry lock poisoned")
            .get(terminal_id)
            .cloned()
    }

    /// Unified agent names: write a terminal's naming binding directly
    /// (the scoped create path's pending admission and the fresh/REST
    /// binders). `name_ref` is the identity the terminal's saved name
    /// resolves through; `handle` retains the pre-durable handle for the
    /// durability-driven bind lanes. Each argument is `Option`-write only
    /// (`None` keeps the current value) — a binding advances, never erases.
    pub fn set_name_binding(
        &self,
        terminal_id: &str,
        name_ref: Option<SessionNameRef>,
        handle: Option<String>,
    ) {
        let mut map = self.inner.write().expect("identity registry lock poisoned");
        let entry = map
            .entry(terminal_id.to_string())
            .or_insert_with(|| minimal_entry(terminal_id));
        if let Some(reference) = name_ref {
            entry.name_ref = Some(reference);
        }
        if let Some(handle) = handle {
            entry.naming_handle = Some(handle);
        }
        entry.updated_at = crate::terminal::now_ms();
    }

    /// Unified agent names: the naming identity this terminal's saved name
    /// resolves through (pending handle before verified materialization,
    /// durable provider/session ref after). Retired entries still answer —
    /// a rename cascade on an exited terminal must reach the same record.
    pub fn name_ref_for(&self, terminal_id: &str) -> Option<SessionNameRef> {
        self.get(terminal_id).and_then(|entry| entry.name_ref)
    }

    /// Unified agent names: the terminal's retained pre-durable naming
    /// handle, when one was admitted at create.
    pub fn naming_handle_of(&self, terminal_id: &str) -> Option<String> {
        self.get(terminal_id).and_then(|entry| entry.naming_handle)
    }

    /// Unified agent names: every identity whose pending naming handle is
    /// still awaiting its verified durable bind — `(terminal_id, provider,
    /// session_id, handle)`. The `main.rs` naming tick uses this to re-check
    /// existing provider durability evidence and bind exactly once
    /// (idempotent in the store).
    pub fn pending_naming_binds(&self) -> Vec<(String, String, String, String)> {
        self.inner
            .read()
            .expect("identity registry lock poisoned")
            .values()
            .filter_map(|entry| {
                if entry.retired {
                    // A retired pane's binding can never advance again —
                    // listing it would re-locate it every tick for the
                    // process lifetime.
                    return None;
                }
                let handle = entry.naming_handle.as_ref()?;
                // Only still-pending refs need a bind; a bound handle's ref
                // is already the durable session ref (or redirects in the
                // store).
                if !matches!(entry.name_ref, Some(SessionNameRef::Pending { .. })) {
                    return None;
                }
                Some((
                    entry.terminal_id.clone(),
                    entry.provider.clone()?,
                    entry.session_id.clone()?,
                    handle.clone(),
                ))
            })
            .collect()
    }

    /// Unified agent names: the durable session name ref for a scoped
    /// provider id (shared with the upsert retarget; `None` for
    /// non-scoped providers).
    #[allow(dead_code)] // the route resolvers key off `named_provider_for` directly
    pub fn named_session_ref_of(&self, provider: &str, session_id: &str) -> Option<SessionNameRef> {
        named_session_ref(provider, session_id)
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
                // Unified agent names (Task 2): the pane's name follows its
                // CURRENT binding — but only across an ALREADY-DURABLE ref.
                // An established SCOPED (provider, session_id) retargets a
                // `Session` name ref onto the new session (the switch/fork
                // rule: a conversation move never strands the pane on the
                // superseded session). A STILL-PENDING ref is NEVER moved by
                // the upsert: the evidence-verified bind lanes own the
                // pending→durable transition, where the retained handle
                // transfers onto this identity (`bind_pending_naming` +
                // the main.rs naming tick). A partial identity (either half
                // absent) and every NON-scoped provider keep the prior ref.
                if let (Some(provider), Some(session_id)) = (provider, session_id) {
                    if matches!(entry.name_ref, Some(SessionNameRef::Session { .. })) {
                        if let Some(next) = named_session_ref(provider, session_id) {
                            entry.name_ref = Some(next);
                        }
                    }
                }
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
        let retired = {
            let mut map = self.inner.write().expect("identity registry lock poisoned");
            match map.get_mut(terminal_id) {
                Some(entry) => {
                    entry.retired = true;
                    true
                }
                None => false,
            }
        };
        if retired {
            // T2-M6 (Task 3): a retired pane's captured proxied codex home is
            // no longer addressable — drop it with the row.
            self.codex_homes
                .write()
                .expect("identity registry lock poisoned")
                .remove(terminal_id);
        }
        retired
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
        // LAZY resolution: only claude-scoped lookups ever normalize the
        // session cwd. The eager form resolved EVERY session's cwd for every
        // provider on every ~5s sweep pass; on WSL2 9P-mounted,
        // cloud-sync-backed cwds each resolution stalled the async runtime
        // 0.4-2s (the FRESHELL host-stats `lagging` toggle root cause).
        // Non-scoped lookups never read the value, so they now pay nothing.
        let session_cwd = match (scoped, cwd) {
            (true, Some(c)) if !c.is_empty() => Some(self.normalize_scoped_cwd_cached(c)),
            _ => None,
        };
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
                        .map(|c| self.normalize_scoped_cwd_cached(c))
                        .is_some_and(|have| have == *want), // no terminal cwd -> excluded
                }
            })
            .collect()
    }

    /// [`normalize_scoped_cwd`] behind the per-registry memo: the first lookup
    /// of a raw cwd pays the on-disk canonicalize; every later lookup of the
    /// same raw string returns the memoized normalized value without touching
    /// the filesystem. Lock discipline: the filesystem resolution happens
    /// OUTSIDE the lock, so a slow path (9P stall) never holds the memo lock.
    pub(crate) fn normalize_scoped_cwd_cached(&self, cwd: &str) -> String {
        if let Some(hit) = self
            .cwd_memo
            .lock()
            .expect("cwd memo lock poisoned")
            .get(cwd)
        {
            return hit.clone();
        }
        let normalized = normalize_scoped_cwd(cwd);
        self.cwd_memo
            .lock()
            .expect("cwd memo lock poisoned")
            .insert(cwd.to_string(), normalized.clone());
        normalized
    }

    #[cfg(test)]
    pub(crate) fn cwd_memo_len_for_tests(&self) -> usize {
        self.cwd_memo.lock().expect("cwd memo lock poisoned").len()
    }
}

/// Unified agent names (Task 2): the verified pending→durable bind at a
/// CLI identity adoption (claude signal, codex locator, opencode locator).
/// The identity `upsert` has ALREADY established the durable (provider,
/// session_id) — and deliberately left a still-pending `name_ref` alone (the
/// switch rule retargets only already-durable refs, so the pending→durable
/// transition stays HERE) — so this transfers the stashed PENDING record onto
/// that session once the caller's existing durability evidence verified it,
/// then advances both identity homes (the ref onto the durable session; the
/// retained handle is never erased). Idempotent (an already-bound handle
/// answers a Read in the store), never blocking the adoption (a failure
/// retains the handle for the main.rs naming tick's visible retry). The
/// terminal registry's display cache follows the accepted record. Answers
/// whether the binding is in place (a successful or already-idempotent
/// bind), so the tick's reconcile can report its progress.
pub(crate) async fn bind_pending_naming(
    identity: &TerminalIdentityRegistry,
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
    provider: freshell_protocol::session_names::NamedProvider,
    session_id: &str,
    acquisition: freshell_protocol::native_location::NativeAcquisition,
) -> bool {
    let Some(sink) = identity.naming() else {
        return false;
    };
    let Some(handle) = identity.naming_handle_of(terminal_id) else {
        return false; // no pending handle: the pane was never in naming scope
    };
    // Only a still-pending name ref needs the transfer; a ref already
    // retargeted to THIS session (or bound earlier) makes this a no-op.
    if !matches!(
        identity.name_ref_for(terminal_id),
        Some(SessionNameRef::Pending { .. })
    ) {
        return false;
    }
    let pending = SessionNameRef::Pending { id: handle };
    let target = SessionNameRef::Session {
        provider,
        session_id: session_id.to_string(),
    };
    match sink
        .bind_pending(freshell_freshagent::naming::BindNameInput {
            pending: pending.clone(),
            target: target.clone(),
            acquisition,
        })
        .await
    {
        Ok(update) => {
            if update.record.name_ref == target {
                identity.set_name_binding(terminal_id, Some(target.clone()), None);
                registry.set_naming(terminal_id, Some(target), None);
            }
            registry.update_session_name(terminal_id, &update.record);
            true
        }
        Err(error) => {
            // Structured failure log under THIS crate's target (the shared
            // `log_name_error` logs under the freshagent crate's own target).
            tracing::warn!(
                target: "freshell_ws::naming",
                op = "bind_pending",
                name_ref = %freshell_freshagent::naming::name_ref_debug_key(&pending),
                revision = error.log_revision(),
                class = %error.code(),
                "session_names.operation_failed: {error}"
            );
            false
        }
    }
}

/// Unified agent names: the claude reconcile tick's one pending row — locate
/// the session's transcript and, when it exists, transfer the retained
/// pending handle onto the durable session through the CLI lanes' SHARED
/// bind ([`bind_pending_naming`]), so a successful tick advances the
/// identity binding and the registry display cache exactly like a signal/
/// locator adoption and the row leaves the pending list (no re-location on
/// subsequent ticks). The transcript file IS the verified persistence
/// evidence (the CLI writes the session transcript at startup, so a
/// zero-turn create binds as soon as the file lands). `false` leaves the
/// row pending for the next tick's visible retry: no transcript yet, no
/// authority wired, or a failed transfer (logged, never blocking).
///
/// `pub`: `freshell-server`'s naming tick drives it per pending row, and the
/// ws integration tests drive it directly for determinism (the file's
/// drive-the-sweep-body-directly convention). The retained handle is read
/// from the identity row itself (the same source [`bind_pending_naming`]
/// trusts).
pub async fn bind_pending_claude_transcript(
    identity: &TerminalIdentityRegistry,
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
    session_id: &str,
) -> bool {
    if identity.naming().is_none() {
        return false;
    }
    let Some(selected) = freshell_freshagent::locate_transcript_selected(session_id) else {
        return false;
    };
    let acquisition = freshell_protocol::native_location::NativeAcquisition {
        location: freshell_protocol::native_location::NativeLocation::Claude {
            config_root: selected.config_root.to_string_lossy().into_owned(),
            transcript_path: Some(selected.transcript_path.to_string_lossy().into_owned()),
            project_directory_key: None,
            transcript_cwd: selected.transcript_cwd.clone(),
            effective_project_key_override: None,
        },
        evidence: freshell_protocol::native_location::NativeEvidenceKind::SelectedTranscript,
        persistence: freshell_protocol::native_location::NativePersistence::Verified,
    };
    bind_pending_naming(
        identity,
        registry,
        terminal_id,
        freshell_protocol::session_names::NamedProvider::Claude,
        session_id,
        acquisition,
    )
    .await
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
///
/// Deliberate divergence from the Node original: callers route through
/// [`TerminalIdentityRegistry::normalize_scoped_cwd_cached`], which resolves
/// each distinct raw cwd ONCE per registry lifetime instead of on every
/// lookup. The Node code's per-call realpath is the same 9P-stall landmine
/// this memo exists to fix; matching semantics are unchanged.
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

    // ── unified agent names (Task 2): binding, retarget, reconcile ─────────

    /// A tiny recording sink for the bind-lane unit tests (the integration
    /// binaries have `common::NamingProbeSink`; lib tests cannot): records
    /// every `bind_pending` input verbatim and answers the transferred
    /// target record, mirroring the real store's same-target idempotence
    /// closely enough to pin the identity-side contract.
    struct BindRecordingSink {
        binds: std::sync::Mutex<Vec<(SessionNameRef, SessionNameRef)>>,
    }

    impl freshell_freshagent::naming::SessionNaming for BindRecordingSink {
        fn get(
            &self,
            refs: Vec<SessionNameRef>,
        ) -> freshell_freshagent::naming::NameFuture<
            Vec<freshell_protocol::session_names::SessionNameUpdate>,
        > {
            let updates = refs
                .into_iter()
                .map(
                    |target| freshell_protocol::session_names::SessionNameUpdate {
                        redirects: Vec::new(),
                        record: freshell_protocol::session_names::SessionNameRecord {
                            name_ref: target,
                            name: "unit".into(),
                            source: freshell_protocol::session_names::NameSource::Directory,
                            revision: 1,
                            manual_revision: None,
                            renamed_at: None,
                            legacy_origin: None,
                        },
                        document_generation: 1,
                        changed: false,
                        native_sync: None,
                        outcome: None,
                    },
                )
                .collect();
            Box::pin(async move { Ok(updates) })
        }

        fn ensure_pending(
            &self,
            _input: freshell_freshagent::naming::PendingNameInput,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn bind_pending(
            &self,
            input: freshell_freshagent::naming::BindNameInput,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            self.binds
                .lock()
                .unwrap()
                .push((input.pending.clone(), input.target.clone()));
            let record = freshell_protocol::session_names::SessionNameRecord {
                name_ref: input.target,
                name: "bound".into(),
                source: freshell_protocol::session_names::NameSource::Directory,
                revision: 2,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            };
            Box::pin(async move {
                Ok(freshell_protocol::session_names::SessionNameUpdate {
                    redirects: Vec::new(),
                    record,
                    document_generation: 1,
                    changed: true,
                    native_sync: None,
                    outcome: None,
                })
            })
        }

        fn rename(
            &self,
            _input: freshell_freshagent::naming::RenameNameInput,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn activity(
            &self,
            _input: freshell_freshagent::naming::NameActivity,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn observe_native(
            &self,
            _input: freshell_freshagent::naming::NativeNameObservation,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }

        fn record_acquisition(
            &self,
            _target: SessionNameRef,
            _acquisition: freshell_protocol::native_location::NativeAcquisition,
        ) -> freshell_freshagent::naming::NameFuture<
            freshell_protocol::session_names::SessionNameUpdate,
        > {
            Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(
                    "not needed here".into(),
                ))
            })
        }
    }

    /// A verified claude acquisition (the bind lanes' unit tests only need
    /// `Verified` persistence — the store's own decision logic is pinned in
    /// `freshell-server`).
    fn verified_claude_acquisition() -> freshell_protocol::native_location::NativeAcquisition {
        freshell_protocol::native_location::NativeAcquisition {
            location: freshell_protocol::native_location::NativeLocation::Claude {
                config_root: "/store".into(),
                transcript_path: Some("/store/projects/-p/s.jsonl".into()),
                project_directory_key: None,
                transcript_cwd: Some("/p".into()),
                effective_project_key_override: None,
            },
            evidence: freshell_protocol::native_location::NativeEvidenceKind::SelectedTranscript,
            persistence: freshell_protocol::native_location::NativePersistence::Verified,
        }
    }

    /// The pane's name follows its CURRENT binding, with the two halves of
    /// the transition owned separately: an established SCOPED (provider,
    /// session_id) upsert retargets an ALREADY-DURABLE name ref onto the new
    /// session (the switch/fork rule — an established binding never strands
    /// the pane on the superseded session), while a STILL-PENDING ref is
    /// NEVER moved by the upsert — the evidence-verified bind lanes own the
    /// pending→durable transition, where the retained handle transfers. A
    /// partial identity (either half absent) and every NON-scoped provider
    /// keep the prior ref, and the pre-durable handle is always retained.
    #[test]
    fn upsert_retargets_only_an_already_durable_name_ref() {
        let reg = TerminalIdentityRegistry::new();
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Pending { id: "nh-1".into() }),
            Some("nh-1".into()),
        );

        // A partial upsert (no session id) keeps the pending ref...
        reg.upsert("t1", Some("claude"), None, None, 1);
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Pending { id: "nh-1".into() })
        );
        // ...and so does a non-scoped provider...
        reg.upsert("t1", Some("gemini"), Some("s-g"), None, 2);
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Pending { id: "nh-1".into() })
        );
        // ...and so does the FULLY-ESTABLISHED scoped upsert itself — a
        // first-bind's pending ref stays pending for the bind lanes (the
        // CLI lanes' upsert-then-bind order relies on this exact hand-off).
        reg.upsert("t1", Some("claude"), Some("s-1"), None, 3);
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Pending { id: "nh-1".into() }),
            "a first-bind upsert must NOT retarget the pending ref — \
             bind_pending_naming owns the transfer"
        );

        // The verified bind advances the ref onto the durable session...
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "s-1".into(),
            }),
            None,
        );

        // ...and a LATER scoped identity move (the conversation switch /
        // fork) retargets the already-durable ref onto the new session.
        reg.upsert("t1", Some("claude"), Some("s-2"), None, 4);
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "s-2".into(),
            }),
            "an established binding must follow a scoped identity move"
        );
        // A NON-scoped provider never touches the moved ref.
        reg.upsert("t1", Some("gemini"), Some("s-g2"), None, 5);
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "s-2".into(),
            })
        );
        // The pre-durable handle stays retained for the bind lanes throughout.
        assert_eq!(reg.naming_handle_of("t1"), Some("nh-1".to_string()));
    }

    /// `bind_pending_naming` — the CLI lanes' shared transfer: a still-
    /// pending ref with a retained handle transfers onto the verified target
    /// and ADVANCES both identity homes (the ref, never erasing the handle);
    /// an already-durable ref never re-binds (the store's redirect covers
    /// it, and a moved pane names through its NEW session's own record).
    #[tokio::test]
    async fn bind_pending_naming_transfers_a_still_pending_ref_and_advances() {
        let reg = TerminalIdentityRegistry::new();
        let sink = std::sync::Arc::new(BindRecordingSink {
            binds: std::sync::Mutex::new(Vec::new()),
        });
        reg.set_session_naming(sink.clone());
        let terminal_registry = freshell_terminal::TerminalRegistry::new();
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Pending { id: "nh-1".into() }),
            Some("nh-1".into()),
        );

        bind_pending_naming(
            &reg,
            &terminal_registry,
            "t1",
            freshell_protocol::session_names::NamedProvider::Claude,
            "s-1",
            verified_claude_acquisition(),
        )
        .await;

        // Exactly one transfer, from the retained handle to the target.
        let binds = sink.binds.lock().unwrap();
        assert_eq!(binds.len(), 1, "{binds:?}");
        assert_eq!(
            binds[0],
            (
                SessionNameRef::Pending { id: "nh-1".into() },
                SessionNameRef::Session {
                    provider: freshell_protocol::session_names::NamedProvider::Claude,
                    session_id: "s-1".into(),
                }
            )
        );
        drop(binds);
        // The identity ref advanced onto the durable session; the handle is
        // retained (a binding advances, never erases).
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "s-1".into(),
            })
        );
        assert_eq!(reg.naming_handle_of("t1"), Some("nh-1".to_string()));
        // The advanced row left the pending reconcile list.
        assert!(reg.pending_naming_binds().is_empty());
    }

    /// The guard half: `bind_pending_naming` is a no-op for an already-
    /// durable ref (only a still-pending ref needs the transfer — a bound
    /// handle's ref redirects in the store, and a pane whose binding moved
    /// names through its NEW session's own record, never a re-transfer).
    #[tokio::test]
    async fn bind_pending_naming_skips_an_already_durable_ref() {
        let reg = TerminalIdentityRegistry::new();
        let sink = std::sync::Arc::new(BindRecordingSink {
            binds: std::sync::Mutex::new(Vec::new()),
        });
        reg.set_session_naming(sink.clone());
        let terminal_registry = freshell_terminal::TerminalRegistry::new();
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "old".into(),
            }),
            Some("nh-1".into()),
        );

        bind_pending_naming(
            &reg,
            &terminal_registry,
            "t1",
            freshell_protocol::session_names::NamedProvider::Claude,
            "new",
            verified_claude_acquisition(),
        )
        .await;

        assert!(
            sink.binds.lock().unwrap().is_empty(),
            "an already-durable ref must not re-transfer"
        );
        assert_eq!(
            reg.name_ref_for("t1"),
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "old".into(),
            }),
            "the skip must leave the existing binding untouched"
        );
    }

    /// `set_name_binding` is Option-write-only per argument: `None` keeps the
    /// current value (a binding advances, never erases).
    #[test]
    fn set_name_binding_is_option_write_only() {
        let reg = TerminalIdentityRegistry::new();
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Pending { id: "nh-2".into() }),
            Some("nh-2".into()),
        );
        // Advance the ref while keeping the handle...
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Codex,
                session_id: "thread-9".into(),
            }),
            None,
        );
        // ...then keep the ref while advancing the handle.
        reg.set_name_binding("t1", None, Some("nh-3".into()));
        let got = reg.get("t1").expect("row");
        assert_eq!(
            got.name_ref,
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Codex,
                session_id: "thread-9".into(),
            })
        );
        assert_eq!(got.naming_handle, Some("nh-3".to_string()));
    }

    /// `pending_naming_binds` lists exactly the still-pending scoped rows for
    /// the naming tick's durability-driven reconcile (a bound row no longer
    /// needs a bind; the store's redirect covers the handle's ref).
    #[test]
    fn pending_naming_binds_lists_only_still_pending_scoped_rows() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s-1"), None, 1);
        reg.set_name_binding(
            "t1",
            Some(SessionNameRef::Pending { id: "nh-a".into() }),
            Some("nh-a".into()),
        );
        reg.upsert("t2", Some("codex"), Some("thread-2"), None, 2);
        reg.set_name_binding(
            "t2",
            Some(SessionNameRef::Pending { id: "nh-b".into() }),
            Some("nh-b".into()),
        );
        // A durable-bound row is not pending.
        reg.upsert("t3", Some("opencode"), Some("ses_3"), None, 3);
        reg.set_name_binding(
            "t3",
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Opencode,
                session_id: "ses_3".into(),
            }),
            Some("nh-c".into()),
        );

        let mut pending = reg.pending_naming_binds();
        pending.sort();
        assert_eq!(
            pending,
            vec![
                (
                    "t1".to_string(),
                    "claude".to_string(),
                    "s-1".to_string(),
                    "nh-a".to_string(),
                ),
                (
                    "t2".to_string(),
                    "codex".to_string(),
                    "thread-2".to_string(),
                    "nh-b".to_string(),
                ),
            ]
        );
    }

    /// `pending_naming_binds` excludes RETIRED rows: a terminal whose
    /// process exited never re-enters the naming tick's reconcile list (the
    /// tick's per-row cost is a filesystem walk + a store transaction — a
    /// retired pane's binding can never advance again, so listing it would
    /// re-locate it every 2s for the process lifetime).
    #[test]
    fn pending_naming_binds_excludes_retired_rows() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t-live", Some("claude"), Some("s-live"), None, 1);
        reg.set_name_binding(
            "t-live",
            Some(SessionNameRef::Pending {
                id: "nh-live".into(),
            }),
            Some("nh-live".into()),
        );
        reg.upsert("t-exited", Some("claude"), Some("s-exited"), None, 2);
        reg.set_name_binding(
            "t-exited",
            Some(SessionNameRef::Pending {
                id: "nh-exited".into(),
            }),
            Some("nh-exited".into()),
        );
        assert!(reg.retire("t-exited"));

        let pending: Vec<String> = reg
            .pending_naming_binds()
            .into_iter()
            .map(|(t, ..)| t)
            .collect();
        assert_eq!(
            pending,
            vec!["t-live".to_string()],
            "a retired pane must never re-enter the naming tick's reconcile list"
        );
    }

    /// `named_session_ref_of` builds the durable ref for the scoped
    /// providers and answers `None` for everything else.
    #[test]
    fn named_session_ref_of_builds_the_session_ref() {
        let reg = TerminalIdentityRegistry::new();
        assert_eq!(
            reg.named_session_ref_of("claude", "s-1"),
            Some(SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: "s-1".into(),
            })
        );
        assert_eq!(reg.named_session_ref_of("gemini", "s-g"), None);
        assert_eq!(reg.named_session_ref_of("shell", "s"), None);
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

    #[test]
    #[cfg(unix)]
    fn find_all_by_session_canonicalizes_through_real_symlinks_for_claude() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).expect("mkdir");
        let session_link = dir.path().join("session-link");
        let terminal_link = dir.path().join("terminal-link");
        std::os::unix::fs::symlink(&real, &session_link).expect("symlink s");
        std::os::unix::fs::symlink(&real, &terminal_link).expect("symlink t");

        let reg = TerminalIdentityRegistry::new();
        reg.upsert(
            "t1",
            Some("claude"),
            Some("s1"),
            Some(terminal_link.to_str().expect("utf8")),
            1,
        );

        let matched =
            reg.find_all_by_session("claude", "s1", Some(session_link.to_str().expect("utf8")));
        let ids: Vec<String> = matched.into_iter().map(|t| t.terminal_id).collect();
        assert_eq!(ids, vec!["t1".to_string()]);
        // Both sides resolved exactly once, THROUGH the memo: with the eager
        // per-call canonicalize this is 0 (the pre-fix red).
        assert_eq!(reg.cwd_memo_len_for_tests(), 2);
    }

    #[test]
    fn find_all_by_session_leaves_the_memo_untouched_for_non_scoped_providers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).expect("mkdir");
        let real_str = real.to_str().expect("utf8");

        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("codex"), Some("s1"), Some(real_str), 1);

        let matched = reg.find_all_by_session("codex", "s1", Some(real_str));
        assert_eq!(
            matched
                .into_iter()
                .map(|t| t.terminal_id)
                .collect::<Vec<_>>(),
            vec!["t1".to_string()]
        );
        // The pre-fix code eagerly canonicalized EVERY session's cwd for every
        // provider; the lazy fix must never resolve cwd on disk for non-claude
        // lookups (the /mnt/d stall class this change exists to kill).
        assert_eq!(reg.cwd_memo_len_for_tests(), 0);
    }

    #[test]
    fn find_all_by_session_treats_an_empty_session_cwd_as_absent_for_scoping() {
        // Pin the previously-unpinned empty-string clause: "" must skip the
        // cwd check exactly like `None`, with no on-disk resolution either.
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s1"), Some("/a"), 1);
        reg.upsert("t2", Some("claude"), Some("s1"), None, 2);
        let mut ids: Vec<String> = reg
            .find_all_by_session("claude", "s1", Some(""))
            .into_iter()
            .map(|t| t.terminal_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
        assert_eq!(reg.cwd_memo_len_for_tests(), 0);
    }

    #[test]
    #[cfg(unix)]
    fn memoized_cwd_resolution_resolves_a_symlink_once_then_serves_retargets_from_the_memo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real_a = dir.path().join("a");
        let real_b = dir.path().join("b");
        std::fs::create_dir_all(&real_a).expect("mkdir a");
        std::fs::create_dir_all(&real_b).expect("mkdir b");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real_a, &link).expect("symlink");
        let link_str = link.to_str().expect("utf8 path").to_string();

        let reg = TerminalIdentityRegistry::new();
        let first = reg.normalize_scoped_cwd_cached(&link_str);
        assert_eq!(
            first,
            std::fs::canonicalize(&real_a)
                .expect("canonicalize expected")
                .to_str()
                .expect("utf8")
        );

        // Retarget the symlink: the memo deliberately serves the FIRST
        // resolution (the accepted tradeoff). Both matching sides share the
        // same memo, so cwd-scoped matching stays internally consistent.
        std::fs::remove_file(&link).expect("unlink");
        std::os::unix::fs::symlink(&real_b, &link).expect("retarget symlink");
        let second = reg.normalize_scoped_cwd_cached(&link_str);
        assert_eq!(
            second, first,
            "memoized resolution must be stable across retargets"
        );
        assert_eq!(reg.cwd_memo_len_for_tests(), 1);
    }

    #[test]
    fn memoized_cwd_resolution_memoizes_the_lexical_fallback_for_missing_paths() {
        let reg = TerminalIdentityRegistry::new();
        let first = reg.normalize_scoped_cwd_cached("/definitely/not/here/");
        assert_eq!(first, "/definitely/not/here"); // lexical fallback + trailing slash strip
        let second = reg.normalize_scoped_cwd_cached("/definitely/not/here/");
        assert_eq!(second, first);
        assert_eq!(reg.cwd_memo_len_for_tests(), 1);
    }

    #[test]
    fn memoized_cwd_resolution_is_shared_across_registry_clones() {
        let reg = TerminalIdentityRegistry::new();
        reg.normalize_scoped_cwd_cached("/x");
        let clone = reg.clone();
        assert_eq!(clone.cwd_memo_len_for_tests(), 1);
        clone.normalize_scoped_cwd_cached("/x");
        assert_eq!(reg.cwd_memo_len_for_tests(), 1);
    }
}
