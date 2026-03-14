# Settings Persistence Stabilization Note

Date: 2026-03-14

This note follows [docs/plans/2026-03-13-settings-persistence-split.md](/home/user/code/freshell/.worktrees/trycycle-settings-persistence-split/docs/plans/2026-03-13-settings-persistence-split.md). The local-vs-server split still stands. What changed is the failure analysis: the remaining bugs are mostly state-machine bugs at the boundaries between browser-local prefs, server-save reconciliation, and config normalization.

This pass is a stabilization pass, not a re-plan of the entire feature.

## Scope

- Keep the current server/local setting ownership split.
- Fix the current correctness hazards instead of layering more local patches.
- Reduce state-machine coupling where possible.

## Invariants

### Browser-local preferences

1. The browser-preferences blob is the authoritative durable state for browser-local preferences.
2. Only explicit durable local edits may change that blob.
3. Responsive or viewport-driven UI state is not a durable preference.
4. Cross-tab/storage updates are authoritative for durable browser prefs.
5. Visible browser-local settings may include local unsaved durable edits, but they must not include transient UI overlays when calculating what to persist.
6. Writes remain sparse and default-eliding.

### Server settings reconciliation

1. `confirmedServerSettings` means the last authoritative server snapshot from bootstrap, websocket, or an API response.
2. `stagedPatches` are preview-only local edits that have not been sent yet.
3. `pendingPatches` are writes that have been sent and are still in flight or queued.
4. Visible server settings are `confirmedServerSettings + stagedPatches + pendingPatches`, applied in sequence order.
5. When an authoritative server snapshot arrives, it replaces the confirmed baseline and staged/pending overlays are re-applied on top.
6. Settings UI must preserve provider names already present in server settings unless the user explicitly toggles that provider.

### Config normalization

1. `ConfigStore.load()` may normalize config in memory.
2. A normalization write failure must never make a read fail.
3. All disk writes remain serialized under the config write mutex.
4. `loadForWrite()` must not perform opportunistic normalization writes.

## Concrete decisions for this pass

1. Remove responsive sidebar auto-collapse mutations from persisted local settings.
   - Mobile and landscape auto-collapse become an App-level overlay, not a Redux settings write.
   - User-triggered sidebar collapse still writes `settings.sidebar.collapsed`.

2. Simplify browser-preferences persistence around that decision.
   - Delete the transient local-settings tracking that existed only to avoid persisting responsive auto-collapse.
   - Persist browser-local settings from durable local state only.

3. Preserve server-returned provider names in `SettingsView`.
   - Toggling one provider must add/remove only that provider.
   - The client must not silently drop other enabled provider names because they are not currently live or browser-known.

4. Keep the current server-save queue model, but verify it against the invariants above instead of expanding it further in this pass.

## Acceptance checks

1. Mobile auto-collapse hides the sidebar without writing `sidebar.collapsed: true` into browser preferences.
2. An authoritative browser-preference value for `sidebar.collapsed` survives unrelated local preference writes.
3. Toggling a live provider does not delete preserved enabled providers that the current browser cannot enumerate.
4. Config normalization failures on read still return normalized in-memory settings and do not clobber later writes.
