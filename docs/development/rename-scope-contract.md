# Rename Scope Contract (naming ownership)

Freshell shows several names for one underlying object. Since the unified
agent-names change, there are two regimes:

- **Coding-agent sessions (Claude, Codex, OpenCode — terminal CLI panes and
  fresh\* panes):** ONE durable saved name per session, shared by every
  surface. No other name scope exists for these sessions.
- **Everything else (shells, browsers, document viewers, editors, and
  coding providers outside those three, e.g. Kilroy, Gemini, Kimi,
  Amplifier):** the legacy four-scope model below, unchanged.

## The unified contract (scoped coding-agent sessions)

One Claude, Codex, or OpenCode conversation (a durable provider session,
plus its pre-durable pending identity before the first message
materializes one) has exactly ONE saved name. The pane header, the tab
(when the tab's naming source is that session), the sidebar row, the
history row, the terminal presentation, and every API projection display
that same record. Renaming from ANY of those surfaces — the pane-header
inline editor, the pane context menu, the tab editor, the sidebar menu,
the history editor (desktop or mobile), the Overview card, or the
`/api/session-names`, `/api/sessions/:key`, `/api/terminals/:id`,
`/api/panes/:id`, and `/api/tabs/:id` routes, the CLI `rename-pane` /
`rename-tab` verbs, or the MCP actions — writes the same record
everywhere. There are no separately targetable pane, tab, or terminal
aliases for these sessions, and no group name.

Name sources, in precedence order: an explicit user rename (`manual`),
a migration-protected legacy label (`legacy_protected` — historic origin
unknown, never claimed as human), Freshell's short AI-generated name
(`freshell_ai`), the provider's own AI-generated title (`provider_ai`),
the first message (`first_message`), and the working directory
(`directory`). A manual name, a migration-protected label and an accepted
Freshell AI name are protected: nothing automatic ever replaces them, so
they are safe from late or stale automatic answers. Otherwise an automatic
offer replaces a saved name only by raising its rank, with three
exceptions (the rules live in
`crates/freshell-server/src/session_name_policy.rs`):

- **A provider's changed native title.** Each record keeps the last valid
  native title the provider reported (its baseline). A native title
  replaces an unprotected name below `provider_ai` (a raise) or a junk name
  (the self-heal rule below), and replaces an older `provider_ai` name at
  equal rank only once a baseline exists and the title differs from it:
  the first report over a `provider_ai` name only records the baseline,
  because older automation renames were never written back to the
  provider, which still reports its older title. A report equal to the
  baseline is an echo and never changes the name, even when it would
  raise rank, so an echo can never undo a rename.
- **Automation renames.** Automation (agent/API/CLI/MCP calls) defaults
  to an automatic suggestion, recorded at `provider_ai`: it replaces any
  unprotected name, equal rank included, and can never acquire the
  permanence of a user's rename; explicit `nameIntent: "user"` is the only
  automation path that does. It is refused when the saved name is
  protected or when its text is a default label for the target (classified
  with the target's best-known folder, so a rename to the session's own
  folder name is refused rather than applied and then healed away). Every
  scoped rename response carries `outcome`: `{applied: true}`;
  `{applied: true, reason: "unchanged"}` when the saved name already is
  that text; or `{applied: false, reason: "protected_name" | "default_label"}`.
  Broadcasts never carry it. The fresh-agent pane and tab routes' `message`
  follows it (`session name not applied: <reason>` for a refusal, else
  `session renamed`). The CLI reports a refusal on stderr as
  `name not applied: <reason>`, and the MCP tool adds it as a `warning`.
- **The self-heal rule.** An unprotected saved name (`directory`,
  `first_message`, `provider_ai`) that the shared classifier recognizes as
  a default or derived label (see "What is never name evidence" below)
  gives way to any real automatic name — a changed native title, the first
  message, or the session index's provider title or first message —
  whatever that offer's rank. A default or derived offer never replaces a
  name, except that the session index's last fallback (the folder name,
  else the provider label) may step such a name above `directory` down to
  `directory` once, after which it is an ordinary `directory` name; the
  same text is always a no-op. `manual`, `legacy_protected` and
  `freshell_ai` names are never healed. Healing happens on the
  session-index sweep (every pass offers each indexed session's first
  message and re-checks its index row, applying at most 25 records'
  changes per pass), on live native titles and on an accepted user message
  that can be the session's first — one sent while Freshell has stored no
  message for the session yet. A later message (a "continue" typed into a
  resumed session) only replaces a name below `first_message`, so a junk
  name it finds waits for the session index's real first message. Existing
  junk names therefore heal without a repair step; a session the index no
  longer lists heals only when it is seen again. A name the classifier
  does not recognize stays until someone renames it.

The user-facing control is **Rename** only. There is no "generate a new
name" action, no custom-label control, and no "reset to provider title"
for these sessions (a scoped null/blank rename is refused with
`NAME_RESET_UNSUPPORTED`). Freshell's own short-name generation is
activity-driven and server-side: it runs for UI-, CLI-, and API-created
sessions alike after the first accepted user message, with an immediate
fallback name and bounded retries. The fallback is the first message,
offered for every activity that carries one (a newly accepted or indexed
message, and a session that is opened or resumed). Once captured, the first
message remains the AI naming input across later sends; a session-index
extraction may correct that first message. Three attempts that
end in an empty or unusable answer or an ordinary request failure (a
timeout, a server error) are the limit; then the series stays exhausted
and keeps its fallback name. A credential, permission, proxy, certificate
or quota failure uses no attempt, and neither does an unreachable Google or
proxy (a connection that is refused, or not made within 10 seconds, as
when a firewall drops it): AI naming pauses for every session — 15
minutes, or for a quota answer a re-probe that starts at 60 s and doubles
up to 15 minutes — and resumes after the pause or as soon as the Gemini
key changes. The first request after a pause is for a session that has
waited longer than the refused one, so a refusal of one session's request
does not stop naming for the others. While paused, no AI naming request
starts; the pause is logged
(`session_names.generation_capability_unavailable`, then
`session_names.generation_capability_restored`) and is not shown in the
UI. A configured Gemini key (`GOOGLE_GENERATIVE_AI_API_KEY` at boot, else
Settings → Naming; a nonempty Settings save replaces it at the next attempt) is
always used: it goes straight to Google when the proxy the server
inherited from its launching shell is OneCLI's, and through any other
inherited proxy. Only when no key is configured does AI naming use the
server's inherited OneCLI connection (a boot WARN,
`session_names.generation_route_inherited_identity`, says so); with
neither, no AI naming runs and the fallback names still apply.
Clearing the Settings field does not clear the running server's cached key;
it stops using that key only after a restart with no startup key configured.
Each attempt makes one request; there is no fallback between the key and
OneCLI. Re-deriving an older session's first message (when the extraction
rules change) never starts AI naming by itself: such a session, if AI
naming never ran for it, gets its AI name when it is next opened. A
provider-generated title is a fallback
and never suppresses Freshell's generation.

The name is assigned before the durable provider identity exists (a
pending handle), transfers to that identity atomically at
materialization, and survives refreshes, reconnects, reopening, resuming,
cross-browser use, and server restarts. Every terminal row the server
creates or adopts — WebSocket and REST creates, resume, crash
auto-resume, managed-runtime reattach after a restart, compatibility
adoption — binds to its session's saved name through one helper
(`crates/freshell-freshagent/src/terminal_name_binding.rs`); a transient
store failure is retried and then finished by the 2 s tick, so a row is
never left unbound, and the row's title is the saved name or a mode
label, never "Shell" for an agent. A row rebuilt for a session that has no
saved record yet (a zero-turn pane restored or adopted after a restart)
rejoins the pane's pending handle, which every recovery request carries
(the restore create, compatibility adoption, and the `pane.reconcile`
entry's `namingHandle`); a handle the store already moved onto a
different session is never used, so the row keeps its own session and
shows its mode label instead of another conversation's name.

A multi-session tab follows its original pane's session while that pane
exists, and a tab rename targets that session — not whichever pane last
had activity or focus. The tab's stored `title` is a display copy of that
session's saved name, kept by the saved-name tab title mirror
(`src/store/savedNameTabTitleMirror.ts`): it writes the saved name only
when the session's saved record is known (never a fallback label), changes
the title only (no tab recency bump, no user flag), and otherwise leaves
the last-known title in place. Every copy of the tab (the persisted
layout, `GET /api/tabs`, the tabs registry, closed-tab snapshots)
therefore carries the saved name, and a reload shows it before names
load. The copy is never name evidence, and no legacy title writer
(terminal window titles, the shell exit suffix, session reopen retitles,
the Kilroy first-message name, unscoped terminal renames) may write a
session-owned tab's title: each asks `canWriteLegacyTabTitle`
(`src/lib/tab-title-ownership.ts`) first.

**A tab stops taking its name from a session.** When a tab's last
Claude/Codex/OpenCode pane is closed or replaced by other content (for
example `[Claude | shell]` with the Claude pane closed), the tab goes back to
the non-agent title rules. If its stored title is still the saved name the
mirror copied, it returns to the `Tab N` placeholder, so the tab shows its
own derived label (and later window titles from its shell), never the old
session's name. The mirror takes back only the name it copied: a title that
changed in the same update, or a user-renamed tab, is kept. The session
keeps its own saved name.

**Conversation switch.** When a conversation switch (Claude's `/clear` or
`/resume`, an OpenCode session switch, a new Codex thread) moves a pane's
terminal onto another session, the pane, the terminal row and the tab
(when it takes its name from that pane) show the NEW session's saved
name, or the pane's fallback label until that session has one (the tab's
stored title returns to the `Tab N` placeholder, which every display
treats as no title). Nothing is copied
from the old session, whose name is untouched; the switch creates or
changes no record. A rename immediately after the switch can admit the
new session's directory fallback and rename it before the session index
creates its record. A pending handle that resolves to the old session
cannot redirect that rename back to it. The retry pins the pending record's
revision so a concurrent bind cannot change its target silently.
For terminal pane and tab renames, the current registry binding takes
precedence over a lagging browser layout. An editor's pending capture
continues to match its own verified materialization, but not a different
conversation, and revision checks still apply.
A pane switched before its first message keeps its
pending name, which transfers to the new session when that session
materializes.

Association and materialization frames carry the server's current naming
reference. The client adopts it even before it has read pending redirects:
a zero-turn pending reference stays pending, while a switch releases the
old handle and names the new session.

**Undo and redo.** A Claude undo or redo replaces its runtime as an
internal continuation. Before announcing the replacement, the name store
seeds its name once from the current session (or its still-pending name),
preserving manual provenance, rename time and generation history. The
child settles a copied in-flight generation start as interrupted, using
the existing retry budget; the source's actual request stays untouched.
The source record stays unchanged, no durable redirect is created, and an
existing child name is never replaced. Later renames address the child.
This applies to sidebar-resumed conversations too. Ordinary forks and new
conversations start independently and never inherit a name this way.

**What is never name evidence.** One shared classifier
(`shared/name-evidence.ts` and `crates/freshell-sessions/src/name_evidence.rs`,
both run against `test/fixtures/name-evidence/cases.json`) recognizes
default and derived labels: `Tab N`; the session's own folder name (only
where the folder is known); provider and mode labels such as `Claude`,
`Codex CLI`, `OpenCode`, `Shell`, `Kilroy`, with an optional `Recovered `
prefix and ` agent` suffix (`Shell agent`, `Recovered OpenCode agent`);
`Recovered`, `Untitled` and `Tab`; provider placeholders (OpenCode's
`New session - <ISO time>` and `Child session - <ISO time>`); and text
that opens with a tool wrapper tag (`<recommended_plugins>`,
`<local-command-caveat>`, `<user_shell_command>`, ...). Such text is never
name evidence: a native title that is one is provenance only, a first
message that is one is neither a fallback name nor AI-naming input (and
the session index does not count tool wrapper records as user messages), an
automation rename to one is refused, an OpenCode session row never
presents its placeholder as its title (it shows the first-message title
instead), a managed-runtime refresh never writes an existing tab's title
and stores a reconstructed tab's view title only when it is a real name,
a stored tab title that is one heals (see "Stored tab title heal" below),
and a saved name that is one heals through the self-heal rule. User
renames are never filtered.

### Native (provider) sync status and limitations

Accepted manual and Freshell AI names are written back to the provider's
own metadata (Claude custom title, Codex thread name, OpenCode session
title) through supported metadata APIs, with a finite per-revision cycle
budget (at most three write cycles per accepted name). A non-blocking
native sync status (`pending`, `synced`, `unsynced`, `unsupported`) may
be displayed beside the name; it is status data only and never a second
name authority.

Concrete, source-supported limitations:

- **No native human-intent provenance.** The public provider metadata
  cannot reliably distinguish a human rename from an automated one
  (Codex's automatic and human callers send the same request). Native
  observations are therefore always automatic; only Freshell's Rename
  UI or an explicit `nameIntent: "user"` API/CLI/MCP call marks a name
  as human.
- **Finite unsynced recovery.** If a writeback result is ambiguous
  (timeout, restart mid-write), the status stays `unsynced` with the
  reason even after a matching readback, and repair stops once the
  cycle budget is exhausted for that revision. A new accepted name
  decision starts a new bounded series; repeated events never
  replenish one.
- **Serial generation queuing.** Generation and native writeback share
  one serial background worker; a burst of eligible sessions is served
  earliest-due-first, so completion is bounded, not instantaneous.
- **Live redraw is not guaranteed.** An already-running external CLI may
  not redraw an externally changed name promptly; the saved name in
  Freshell still converges everywhere. Native TUI redraw is not
  measured by Freshell.

### Migration and recovery

Pre-existing conflicting saved names (old pane/tab/terminal/session
labels) were consolidated once at boot into the unified record:
reliable explicit-rename recency decided between proven user names, a
deterministic precedence order decided everything else, and the losing
raw evidence was retained in immutable recovery copies under
`<data dir>/name-migration-v1/` without keeping competing overrides
active. Post-migration, the old ladder fields are no longer consulted
for these sessions.

After that one-time consolidation:

- **Each device captures at most once.** A browser profile copies only
  its genuine pre-migration layout keys (the bare shared
  `freshell.layout.v3` family and the v2 tab/pane keys, and only while they
  carry no unified-names fields) into immutable envelopes, once, then marks
  itself done (`freshell.session-names.capture-done.v1`). A live
  per-window layout, cross-window sync and machine-workspace restore are
  never evidence. Each envelope is deleted once the server acknowledges
  it, and a done device deletes any envelope an older client left. A
  failed capture is logged (`legacy_name_capture_failed`) and never blocks
  a layout save (`src/lib/legacy-name-capture-policy.ts`).
- **Post-completion browser imports are acknowledged without effect.**
  Once the server's boot consolidation has completed, every browser import
  is acknowledged and nothing is written: no record is created or changed,
  no candidate id is stored, no backup file is written, and the document
  generation does not move (one INFO
  `session_names.import_ignored_after_completion` per import id). An old
  browser tab left open after an upgrade therefore cannot revert a name.
- **An imported default label loses a bind collision.** When a pending
  name binds to a durable session whose record an import installed and
  that is still an unprotected default label ("Tab 4", "OpenCode agent"),
  the live pending name wins; every other imported name keeps the rank
  rule.
- **The migration bookkeeping is never pruned.** The acknowledged
  candidate ids and the retained winning evidence stay in the name
  document, because an older binary sharing it still relies on them.
- **Junk names heal on their own.** Default labels an earlier import left
  behind heal through the self-heal rule above; there is no repair
  command.

Recovery procedure (documented, the only supported path): read the
immutable evidence in `name-migration-v1/`, then — if a name was lost —
submit a deliberate rename through the normal Rename UI or API. Never
copy a backup over the live name document, never re-introduce old
override rows, and never reactivate competing aliases; a pre-feature
binary rollback requires an approved stopped-scratch restore from the
full config backup.

### Name-change log

Every accepted saved-name change writes one INFO line,
`session_names.name_changed`, after the durable commit
(`crates/freshell-server/src/session_name_events.rs`): the record key
(`name_ref`); the old and new name, source and revision (the old ones are
absent for a new record); the `cause` (`import`, `native_observation`,
`first_message_fallback`, `generation`, `manual_rename`,
`automation_rename`, `bind`, `bind_collision`, `ensure_pending`,
`ensure_session`, `internal_continuation`,
`hydrate`, `adopted_external`); `self_heal` (true when the self-heal rule
replaced a junk name with one whose source ranks the same or lower); and
`from_ref`, `import_id`, `evidence_key` or `series` where they apply. A
failed commit logs nothing, and a change to bookkeeping only (a generation
advance, a native sync status) logs no line. A commit whose replacement
landed but whose durability is unproven (the operation failed with
`commit_uncertain`) is logged with its own cause, once, by the next naming
transaction that confirms the document. A change another process
committed is logged once, with cause `adopted_external`, when this server
adopts it (never for the document loaded at startup). A conversation
switch changes no record, so it logs `session_names.terminal_binding_moved`
instead. Names are logged as every naming surface shows them, and every
line passes the log writer's secret scrubber.

## The legacy four-scope model (everything else)

Each non-agent name has exactly one owner and each rename surface writes
exactly one scope:

| Scope | Owned by | Written by | Persists |
| --- | --- | --- | --- |
| Pane label | the pane (layout snapshot) | pane header inline rename; `PATCH /api/panes/:id` (agent API / MCP) | layout snapshot only |
| Tab label | the tab (layout organization) | TabBar inline rename; `PATCH /api/tabs/:id`; `name` on a REST/MCP tab create (agent API / MCP) | layout snapshot only |
| Terminal title | the terminal process | `PATCH /api/terminals/:id` (Overview card / terminal context menu) | `terminalOverrides[terminalId]` |
| Session title | the durable provider session | `PATCH /api/sessions/:key` (sidebar/history "Rename") | `sessionOverrides["provider:sessionId"]` |

Hard rules (legacy scopes, unchanged — a request naming a scoped
Claude/Codex/OpenCode target instead routes to the unified authority
above):

1. **Pane/tab renames never write terminal or session overrides.** The
   client `applyPaneRename`/`applyTabRename` thunks are Redux-only; the
   agent-API `PATCH /api/panes/:id` writes the layout store and
   broadcasts `ui.command{pane.rename}` with NO other side effect;
   nothing else PATCHes on a local rename. A stopped/exited pane with a
   retained `sessionRef` obeys the same rule — there is no
   "sessionRef fallback" write.
2. **`PATCH /api/sessions/:key` is the ONLY durable session-rename
   surface.** A non-empty `titleOverride` writes
   `{titleOverride, titleSource:"user"}` and cascades to the LIVE
   terminal running that session (terminal override + registry +
   `terminals.changed` + `cascadedTerminalId` in the response, then
   `sessions.changed`). `{"titleOverride": null}` REMOVES both
   `titleOverride` and `titleSource`. (For a scoped provider this route
   becomes a unified-authority rename; the null/reset form is refused —
   see above.)
3. **Terminal renames are terminal-scoped** and never cascade into
   session overrides (live OR retired identities). (A rename through a
   scoped session's terminal presentation is a unified-authority
   rename of that session's one name.)
4. **Reset to provider title** (sidebar/history context menu, shown when
   the directory row reports `titleOverridden` and the override's source
   is not a sweep rung (`first-message`/`dir` — those would be
   re-applied instantly)): previews current vs provider-native title,
   then issues `{titleOverride: null}`. Reset does NOT rewrite any open
   terminal/pane title — those surfaces are their own scopes. (The
   control does not exist for scoped sessions; their name is never
   cleared.)
5. **Provider-title updates and the auto-title sweep never flip a
   `user`-rung override**, and pane/tab labels can no longer mint one —
   so provider titles update in history exactly until a user makes an
   explicit session rename.
6. **No title-equality inference, ever.** Identity is
   `provider + sessionId`; two same-titled rows are two sessions. No
   dedup, group, or cleanup infers sameness from equal titles.
7. **No mass migration of existing overrides.** The unified consolidation
   above covers the three scoped providers; every other provider's rows
   are untouched. The `titleSource` ladder (`shared/title-source.ts`)
   still governs automatic writers in the legacy scopes, and the
   one-generation `config.backup.json` (refreshed on every persist)
   remains their recoverable path.

## Display precedence (composition of stored labels)

The rules above govern WRITE scoping (who owns which rename surface). This
section records how the DISPLAY composes the several labels one tab or row can
hold at read time — exactly as the code composes them. The "Persists" column
above is untouched by this section. For a scoped coding-agent session every
surface displays the ONE canonical name from the unified contract above; this
section composes the legacy scopes.

**Tab display title** (enforced by `getTabDisplayTitle`, `src/lib/tab-title.ts`;
a session-owned tab displays its source pane's canonical session name through
`selectTabDisplayTitles` instead, and falls back to this composition only while
that saved record is not loaded — its stored title is then the last name the
saved-name tab title mirror copied, see the unified contract above):

1. **Explicit title** — `tab.title` with `titleSetByUser: true`: a TabBar
   inline rename, a `PATCH /api/tabs/:id`, or an explicit non-empty `name` on a
   REST/MCP tab create (the `tab.create` fold sets the user flag for a
   caller-provided name, except on a Claude/Codex/OpenCode tab: there the
   name seeds the session's saved name as an automatic suggestion and the tab
   title stays a mirror of the saved name, never frozen). An empty explicit
   title falls through.
2. **Single-pane override** — the sole leaf pane's stored non-derived pane
   title, whatever composed it (see the pane ladder below — a registry
   auto-title like "Codex CLI" or a mirrored session title can show as the
   tab title when no explicit title outranks it).
3. **Stored non-derived `tab.title`** set without the user flag that is not
   a `Tab N` placeholder — for example a window title a program set on a split
   tab. A stored default label never stays on this rung: the store heals it
   (below).
4. **cwd-leaf derived titles** — the `deriveTabName`/`derivePaneTitle`
   fallbacks.

**Stored tab title heal** (`src/store/storedTabTitleHeal.ts`; the rule is
`isHealableStoredTabTitle` in `src/lib/tab-title.ts`). Earlier builds'
managed-runtime refresh stored provider labels ("Shell agent", "OpenCode
agent", "Recovered Shell agent") as the title of every unrenamed tab it
matched; such a stored title is not a name. A stored title heals to the
`Tab N` placeholder (its position) when all of these hold: the tab has no
`titleSetByUser`; it has a layout; the title is not already `Tab N`; the
saved-name mirror does not own it (a session-owned tab whose saved record is
cached keeps the mirrored saved name, so the two never fight); the title
differs from the tab's derived label (a create-time label equal to it is
already no title to every display); and the shared classifier recognizes it
for the tab's mode and provider — a provider or mode label, a provider
placeholder or tool wrapper text. The classifier's folder-name rule is not
used, so a window title that is a folder name stays. Only the title changes
(no recency bump, no flag). The heal runs once when the store is created and
after every change to tabs, layouts, saved names or extensions, so every way
a tab arrives (the persisted-layout load, cross-window sync, the new-window
rebuild, a Tabs-view open, a write from an old client) passes it, and the
persisted layout, `GET /api/tabs` and the tabs registry follow the healed
title. A title's writer is not recorded, so a live window title that is
itself such a label (a program in a shell titling the window "opencode")
heals too; a single-pane tab still shows it through its pane title. A session
name, a rename and any other window title are never healed. Closed-tab and
other-device registry records written before the heal keep their stored
label until they are opened (the opened tab heals at once).

**Rebuilt tabs keep their names.** A tab rebuilt from a recorded snapshot —
a new window or recovery rebuild (from the tabs registry's recorded
snapshots), a tab opened from a Tabs-view record, or a pane opened in its own
tab from there — gets back its recorded pane titles and pane rename flags,
remapped onto the rebuilt pane ids (a flag only together with its title; never
for a scoped agent pane, which its saved record names), and, for a tab that is
not session-owned, its tab rename flag (a pane opened in its own tab gets no
tab flag: the tab is new). One rule set, `src/lib/restored-tab-names.ts`,
serves all three; the tabs registry's pane snapshots carry the pane rename
flag (`titleSetByUser`) for it.

**Pane title** — composed per pane kind (NOT a blanket mirror-over-auto rule;
enforced by the terminal-title cache plus `sessionTitleMirrorMiddleware`,
`src/store/sessionTitleMirror.ts`, which copies session-directory titles into
the titles of NON-scoped panes only — a scoped Claude/Codex/OpenCode pane
displays its saved name. Not to be confused with
`src/store/savedNameTabTitleMirror.ts`, which copies a session's saved name
into its session-owned TAB's stored title):

- A **user-set pane title** is never mirrored over.
- **Terminal panes**: a cached terminal-level title outranks the session-title
  mirror — the mirror skips any terminal pane whose `terminalId` has a cached
  title (`collectSessionTitleTargets`, `sessionTitleMirror.ts`), so registry
  auto-titles ("Codex CLI"), `PATCH /api/terminals/:id` renames, and the
  inventory/live folds own that pane; the mirror only titles terminal panes
  with NO cached terminal title (unattached/exited/not-yet-reattached panes).
- **Non-scoped fresh-agent panes** (e.g. Kilroy): no registry pipeline — the
  session-title mirror is their runtime title source (always eligible).
- Fallback: the `initLayout`-derived cwd-leaf.

**Title-less running session rows** (a real session whose transcript has not
yet yielded a title): the sidebar row's label composes the same name order the
client-side fallback row uses — pane title, then the terminal's registry
title, then the provider label (`src/store/selectors/sidebarSelectors.ts`);
every other title-less row keeps the id-prefix fallback. The label is a
display fallback only — `hasTitle` stays false, and a later title-carrying
fetch still overrides it. For a scoped coding-agent row the canonical session
name (live cache, then the row's last-known projection) outranks this
composition; the running-row rungs below it keep a pre-transcript scoped row's
label stable.
