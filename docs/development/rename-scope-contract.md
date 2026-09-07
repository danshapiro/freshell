# Rename Scope Contract (naming ownership)

Freshell shows several names for one underlying object. Each name has exactly
one owner and each rename surface writes exactly one scope:

| Scope | Owned by | Written by | Persists |
| --- | --- | --- | --- |
| Pane label | the pane (layout snapshot) | pane header inline rename; `PATCH /api/panes/:id` (agent API / MCP) | layout snapshot only |
| Tab label | the tab (layout organization) | TabBar inline rename; `PATCH /api/tabs/:id` | layout snapshot only |
| Terminal title | the terminal process | `PATCH /api/terminals/:id` (Overview card / terminal context menu) | `terminalOverrides[terminalId]` |
| Session title | the durable provider session | `PATCH /api/sessions/:key` (sidebar/history "Rename") | `sessionOverrides["provider:sessionId"]` |

Hard rules:

1. **Pane/tab renames never write terminal or session overrides.** The client
   `applyPaneRename`/`applyTabRename` thunks are Redux-only; the agent-API
   `PATCH /api/panes/:id` writes the layout store and broadcasts
   `ui.command{pane.rename}` with NO other side effect; nothing else PATCHes on
   a local rename. A stopped/exited pane with a retained `sessionRef` obeys the
   same rule — there is no "sessionRef fallback" write.
2. **`PATCH /api/sessions/:key` is the ONLY durable session-rename surface.**
   A non-empty `titleOverride` writes `{titleOverride, titleSource:"user"}` and
   cascades to the LIVE terminal running that session (terminal override +
   registry + `terminals.changed` + `cascadedTerminalId` in the response, then
   `sessions.changed`). `{"titleOverride": null}` REMOVES both `titleOverride`
   and `titleSource` — a leftover `titleSource:"user"` would permanently
   finalize the row at the top ladder rung and block all future automatic
   titles (both servers share this semantics).
3. **Terminal renames are terminal-scoped on both servers** and never cascade
   into session overrides (live OR retired identities). Rust ==
   Node here since b5fb; the older pane-rename cascade divisions EDEV-10 and
   EDEV-11 were removed, and `persistSyncableTerminalRename` is gone.
4. **Reset to provider title** (sidebar/history context menu, shown when the
   directory row reports `titleOverridden` and the override's source is not a
   sweep rung (`first-message`/`dir` — those would be re-applied instantly)):
   previews current vs
   provider-native title, then issues `{titleOverride: null}`. The directory
   wire carries `titleOverridden`, `providerTitle`, `titleOverrideSource` for
   this flow (Task 6/Task 7 of the b5fb plan). Reset does NOT rewrite any
   open terminal/pane title — those surfaces are their own scopes.
5. **Provider-title updates and the auto-title sweep never flip a `user`-rung
   override**, and pane/tab labels can no longer mint one — so provider titles
   update in history exactly until a user makes an explicit session rename.
6. **No title-equality inference, ever.** Identity is `provider + sessionId`;
   two same-titled rows are two sessions. No dedup, group, or cleanup infers
   sameness from equal titles.
7. **No mass migration of existing overrides.** Historical provenance is
   ambiguous; the reviewed per-session reset flow plus the existing
   one-generation `config.backup.json` (refreshed on every persist) are the
   recoverable path. The `titleSource` ladder (`shared/title-source.ts`)
   still governs all automatic writers.
