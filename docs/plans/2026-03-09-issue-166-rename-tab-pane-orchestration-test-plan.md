# Issue 166 Rename Tab and Pane Orchestration Test Plan

Reconciliation note: the implementation plan does not invalidate the expected testing strategy. The risk remains concentrated in four boundaries: CLI target/name parsing, HTTP rename normalization, authoritative `LayoutStore` persistence, and client convergence from `ui.command` broadcasts. No external services, paid APIs, browser infrastructure, or scope increases were introduced by the plan.

## Sources of truth

- `AC-1`: The orchestration surface exposes an operation for renaming a tab. Source: issue transcript in the trycycle dispatch prompt.
- `AC-2`: The orchestration surface exposes an operation for renaming a pane. Source: issue transcript in the trycycle dispatch prompt.
- `AC-3`: Rename operations can target the active item and, where applicable, a specific tab or pane identifier. Source: issue transcript in the trycycle dispatch prompt.
- `AC-4`: A user or agent can create or split a workspace and then assign meaningful tab and pane names without manual UI interaction. Source: issue transcript in the trycycle dispatch prompt.
- `Plan-1`: Rename stays server-authoritative; names are normalized once at the HTTP boundary; blank names are rejected; rename broadcasts are success-only. Source: [2026-03-09-issue-166-rename-tab-pane-orchestration.md](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/docs/plans/2026-03-09-issue-166-rename-tab-pane-orchestration.md).
- `Plan-2`: Pane rename persists through `LayoutStore.renamePane(paneId, title)` and `PATCH /api/panes/:id`, with pane ownership resolved internally from the pane target. Source: [2026-03-09-issue-166-rename-tab-pane-orchestration.md](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/docs/plans/2026-03-09-issue-166-rename-tab-pane-orchestration.md).
- `Plan-3`: Connected UIs converge by handling `tab.rename` and `pane.rename` `ui.command` broadcasts after successful authoritative mutations. Source: [2026-03-09-issue-166-rename-tab-pane-orchestration.md](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/docs/plans/2026-03-09-issue-166-rename-tab-pane-orchestration.md).
- `Skill-1`: `rename-tab` supports active-target default, explicit positional target, and flagged `-t/-n` forms. Source: post-change contract in [.claude/skills/freshell-orchestration/SKILL.md](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/.claude/skills/freshell-orchestration/SKILL.md) and the implementation plan.
- `Skill-2`: `rename-pane` supports active-target default, explicit positional target, and flagged `-t/-n` forms. Source: post-change contract in [.claude/skills/freshell-orchestration/SKILL.md](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/.claude/skills/freshell-orchestration/SKILL.md) and the implementation plan.
- `Skill-3`: The orchestration skill documents a concrete create/split/select/rename flow that assigns tab and pane names with no manual UI interaction. Source: post-change contract in [.claude/skills/freshell-orchestration/SKILL.md](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/.claude/skills/freshell-orchestration/SKILL.md) and the implementation plan.

## Harness requirements

1. `cli-real-layout` harness
   - What it does: starts an ephemeral Express server with `createAgentApiRouter`, a real `LayoutStore`, and a minimal fake terminal registry; spawns `server/cli/index.ts` as a child process against that server.
   - What it exposes: CLI stdout/stderr, exit status, parsed JSON helpers, and direct post-command inspection of the real `LayoutStore` snapshot.
   - Estimated complexity: medium; the helper already exists in [test/e2e/agent-cli-flow.test.ts](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/test/e2e/agent-cli-flow.test.ts) and needs small extension, not a new subsystem.
   - Tests that depend on it: 1, 2.

2. `agent-api-route` harness
   - What it does: mounts `createAgentApiRouter` in a minimal Express app and drives HTTP requests through `supertest` with mocked `layoutStore`, `registry`, and `wsHandler`.
   - What it exposes: request/response assertions, spyable route inputs, and captured `broadcastUiCommand` payloads.
   - Estimated complexity: low; this matches the existing style in [test/server/agent-tabs-write.test.ts](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/test/server/agent-tabs-write.test.ts) and [test/server/agent-panes-write.test.ts](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/test/server/agent-panes-write.test.ts).
   - Tests that depend on it: 3, 4, 6, 7.

3. `ui-command-dispatch` harness
   - What it does: calls `handleUiCommand()` with a dispatch spy to observe the Redux action emitted for a broadcast command.
   - What it exposes: dispatched action type and payload.
   - Estimated complexity: low; the pattern already exists in [test/unit/client/ui-commands.test.ts](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/test/unit/client/ui-commands.test.ts).
   - Tests that depend on it: 5.

4. `layout-store-snapshot` harness
   - What it does: instantiates a real `LayoutStore`, seeds it with a UI snapshot when needed, and inspects the resulting snapshot after a write operation.
   - What it exposes: `renamePane()` return value, `listTabs()`, `getPaneSnapshot()`, and direct snapshot metadata such as `paneTitles`.
   - Estimated complexity: low; existing coverage already seeds snapshots directly in [test/unit/server/agent-layout-store-write.test.ts](/home/user/code/freshell/.worktrees/trycycle-issues-166-163-162-160-158-156-151/test/unit/server/agent-layout-store-write.test.ts).
   - Tests that depend on it: 9.

5. `skill-doc-inspection` harness
   - What it does: reads the canonical orchestration skill markdown and asserts on the published command reference and example workflow.
   - What it exposes: file-content assertions against documented commands and playbooks.
   - Estimated complexity: low.
   - Tests that depend on it: 8.

Build order: `agent-api-route`, `layout-store-snapshot`, and `ui-command-dispatch` can be extended first because they unblock the lower-level red tests. `cli-real-layout` comes next because it proves the end-to-end acceptance flow. `skill-doc-inspection` is last because it depends on the documented contract after the CLI surface is settled.

## Test plan

1. **Name:** Creating and splitting a workspace can be followed by tab and pane renames entirely through orchestration
   - **Type:** scenario
   - **Harness:** `cli-real-layout`
   - **Preconditions:** Start with an empty real `LayoutStore` behind the agent API; configure the fake registry so `new-tab --codex` and `split-pane --editor` succeed without picker interaction.
   - **Actions:**
     - Run `new-tab -n "Workspace" --codex --cwd <repo>`.
     - Run `split-pane -t <firstPaneId> --editor <file>`.
     - Run `rename-tab -t <tabId> -n "Issue 166 work"`.
     - Run `rename-pane -t <firstPaneId> -n "Codex agent"`.
     - Run `rename-pane <secondPaneId> Editor notes`.
   - **Expected outcome:**
     - Each CLI command exits successfully and returns a success JSON envelope, proving the orchestration surface exposes both rename operations and keeps them usable in a real workflow. Source: `AC-1`, `AC-2`, `AC-4`.
     - The real `LayoutStore` snapshot shows the tab title updated to `Issue 166 work`, and `paneTitles[tabId]` contains `Codex agent` for the first pane and `Editor notes` for the second pane. Source: `AC-4`, `Plan-2`.
     - The workflow completes with only CLI/API calls; no browser-side rename gesture is required anywhere in the sequence. Source: `AC-4`, `Skill-3`.
     - The explicit target forms exercised here remain valid in both flagged and positional variants. Source: `AC-3`, `Skill-1`, `Skill-2`.
   - **Interactions:** CLI argument parsing, CLI target resolution, HTTP agent API, `LayoutStore`, fake terminal registry, pane split creation.

2. **Name:** Omitted rename targets act on the active tab and active pane without disturbing non-active siblings
   - **Type:** scenario
   - **Harness:** `cli-real-layout`
   - **Preconditions:** Start a real `LayoutStore`; create two tabs so one inactive tab exists; split the active tab so it has two panes; select the pane that should become active before the pane rename.
   - **Actions:**
     - Run `new-tab -n "Backlog" --shell system`.
     - Run `new-tab -n "Active" --shell system`.
     - Run `split-pane --editor <file>` against the active tab's active pane.
     - Run `select-pane -t <secondPaneId>`.
     - Run `rename-tab Release prep`.
     - Run `rename-pane Docs review`.
   - **Expected outcome:**
     - The active tab, not the inactive `Backlog` tab, is renamed to `Release prep` when no target is provided. Source: `AC-3`, `Skill-1`.
     - The active pane in the active tab, not its sibling pane, is renamed to `Docs review` when no target is provided. Source: `AC-3`, `Skill-2`.
     - The inactive tab and the non-active pane retain their original titles, proving omitted-target behavior is a selection default rather than a broad rename. Source: `AC-3`, `Skill-1`, `Skill-2`.
   - **Interactions:** CLI active-target inference, tab selection state, pane selection state, HTTP agent API, `LayoutStore`.

3. **Name:** Renaming a tab through the agent API trims the requested name and emits a `tab.rename` broadcast only after success
   - **Type:** integration
   - **Harness:** `agent-api-route`
   - **Preconditions:** Mount `createAgentApiRouter` with a mocked `layoutStore.renameTab()` that returns `{ tabId: "tab_1" }` and a spy `broadcastUiCommand()`.
   - **Actions:** Send `PATCH /api/tabs/tab_1` with `{ "name": "  Release prep  " }`.
   - **Expected outcome:**
     - The response is successful and `layoutStore.renameTab()` receives `tab_1` and the trimmed name `Release prep`. Source: `Plan-1`.
     - `broadcastUiCommand()` is called once with `command: "tab.rename"` and payload `{ id: "tab_1", title: "Release prep" }`, proving broadcasts happen after a successful authoritative mutation and use normalized names. Source: `AC-1`, `Plan-1`, `Plan-3`.
   - **Interactions:** HTTP validation/normalization, layout-store write boundary, websocket broadcast boundary.

4. **Name:** Renaming a pane through the agent API resolves the pane target once, ignores redundant tab input, and broadcasts the authoritative tab/pane pair
   - **Type:** integration
   - **Harness:** `agent-api-route`
   - **Preconditions:** Mount `createAgentApiRouter` with `layoutStore.resolveTarget("1.0") -> { tabId: "tab_1", paneId: "pane_real" }`, `layoutStore.renamePane() -> { tabId: "tab_1", paneId: "pane_real" }`, and a spy `broadcastUiCommand()`.
   - **Actions:** Send `PATCH /api/panes/1.0` with `{ "name": "  Logs  ", "tabId": "wrong_tab" }`.
   - **Expected outcome:**
     - The response is successful and `layoutStore.renamePane()` receives `pane_real` plus the trimmed name `Logs`, proving the route resolves the pane target internally and normalizes the name at the HTTP boundary. Source: `AC-2`, `AC-3`, `Plan-1`, `Plan-2`.
     - The request body `tabId` has no effect on the authoritative mutation path. Source: `Plan-2`.
     - `broadcastUiCommand()` is called once with `command: "pane.rename"` and payload `{ tabId: "tab_1", paneId: "pane_real", title: "Logs" }`. Source: `Plan-2`, `Plan-3`.
   - **Interactions:** HTTP validation/normalization, pane-target resolution, layout-store ownership lookup, websocket broadcast boundary.

5. **Name:** A `pane.rename` UI command updates the client as an explicit pane title override
   - **Type:** integration
   - **Harness:** `ui-command-dispatch`
   - **Preconditions:** A dispatch spy is available; no browser rendering is needed.
   - **Actions:** Call `handleUiCommand()` with `{ type: "ui.command", command: "pane.rename", payload: { tabId: "t1", paneId: "p1", title: "Logs" } }`.
   - **Expected outcome:**
     - The client dispatches `panes/updatePaneTitle` with `{ tabId: "t1", paneId: "p1", title: "Logs" }`. Source: `Plan-3`.
     - The action is treated as an intentional title override rather than a system-only runtime title refresh, so the dispatched payload does not downgrade it to `setByUser: false`. Source: `Plan-3`.
   - **Interactions:** websocket message handling, client command dispatcher, panes Redux slice.

6. **Name:** Blank tab rename requests are rejected before mutation, and failed tab mutations do not broadcast stale `tab.rename` events
   - **Type:** boundary
   - **Harness:** `agent-api-route`
   - **Preconditions:** Mount `createAgentApiRouter` twice or reset spies between subcases; one subcase uses a `renameTab` spy that should not run, and the other uses `renameTab()` returning `{ message: "tab not found" }` with a broadcast spy.
   - **Actions:**
     - Send `PATCH /api/tabs/tab_1` with `{ "name": "   " }`.
     - Send `PATCH /api/tabs/missing` with `{ "name": "Ghost" }`.
   - **Expected outcome:**
     - The blank-name request returns `400` and does not call `layoutStore.renameTab()`. Source: `Plan-1`.
     - The failed-mutation request may preserve the existing response envelope semantics, but it does not emit any `tab.rename` broadcast because the authoritative store did not confirm a rename. Source: `Plan-1`, `Plan-3`.
   - **Interactions:** HTTP validation boundary, layout-store error path, websocket broadcast suppression.

7. **Name:** Blank pane rename requests are rejected before mutation, and failed pane mutations do not broadcast stale `pane.rename` events
   - **Type:** boundary
   - **Harness:** `agent-api-route`
   - **Preconditions:** Mount `createAgentApiRouter` twice or reset spies between subcases; one subcase uses a `renamePane` spy that should not run, and the other uses `renamePane()` returning `{ message: "pane not found" }` with a broadcast spy.
   - **Actions:**
     - Send `PATCH /api/panes/pane_1` with `{ "name": "   " }`.
     - Send `PATCH /api/panes/missing` with `{ "name": "Ghost" }`.
   - **Expected outcome:**
     - The blank-name request returns `400` and does not call `layoutStore.renamePane()`. Source: `Plan-1`, `Plan-2`.
     - The failed-mutation request does not emit any `pane.rename` broadcast because the authoritative store did not confirm an owning `{ tabId, paneId }` rename result. Source: `Plan-1`, `Plan-2`, `Plan-3`.
   - **Interactions:** HTTP validation boundary, layout-store error path, websocket broadcast suppression.

8. **Name:** The orchestration skill advertises both rename commands, their active-target defaults, and a no-UI create/split/rename playbook
   - **Type:** regression
   - **Harness:** `skill-doc-inspection`
   - **Preconditions:** Read the canonical skill file at `.claude/skills/freshell-orchestration/SKILL.md`.
   - **Actions:** Assert that the skill markdown contains the `rename-tab` and `rename-pane` command forms, the omitted-target semantics, and a concrete create/split/select/rename example.
   - **Expected outcome:**
     - The command reference includes `rename-tab NEW_NAME`, `rename-tab TARGET NEW_NAME`, and `rename-tab -t TARGET -n NEW_NAME`. Source: `AC-1`, `AC-3`, `Skill-1`.
     - The command reference includes `rename-pane NEW_NAME`, `rename-pane TARGET NEW_NAME`, and `rename-pane -t TARGET -n NEW_NAME`. Source: `AC-2`, `AC-3`, `Skill-2`.
     - The skill explicitly states that omitted targets use the active tab or active pane, and includes a documented create/split/select/rename workflow that needs no manual UI interaction. Source: `AC-4`, `Skill-2`, `Skill-3`.
   - **Interactions:** Agent skill consumers, plugin indirection through the canonical skill file.

9. **Name:** Renaming a pane in `LayoutStore` writes the title under the pane’s owning tab and never renames the tab itself
   - **Type:** invariant
   - **Harness:** `layout-store-snapshot`
   - **Preconditions:** Seed a real `LayoutStore` with a snapshot containing at least two tabs, make one tab active, and place the target pane in the non-active tab with an existing tab title.
   - **Actions:** Call `renamePane(<paneIdInInactiveTab>, "Logs")`.
   - **Expected outcome:**
     - `renamePane()` returns the owning `{ tabId, paneId }` for the targeted pane rather than the active tab. Source: `Plan-2`.
     - `snapshot.paneTitles[owningTabId][paneId]` becomes `Logs`. Source: `Plan-2`.
     - The owning tab’s `tabs[].title` remains unchanged, proving pane rename does not auto-rename the tab. Source: `Plan-2`.
   - **Interactions:** layout snapshot persistence, pane ownership lookup, tab metadata stability.

## Coverage summary

Covered action space:
- Creating a workspace and splitting it before renaming anything.
- Renaming a tab via explicit target and via active-target default.
- Renaming a pane via explicit target, tmux-style pane target, and active-target default.
- Multi-word rename names in both flagged and positional CLI forms.
- HTTP rename validation, trimming, and success-only broadcast behavior for both tabs and panes.
- Client convergence for the new `pane.rename` broadcast.
- Published orchestration-skill documentation for the new rename surface and the no-UI workflow.

Explicit exclusions:
- No browser-level manual UI automation is planned for this issue. The acceptance criteria require a no-UI orchestration flow, and the highest-value proof is the real CLI plus real `LayoutStore` scenario coverage. Residual risk: a live browser WebSocket client could still mishandle a rename even if `handleUiCommand()` is correct, though that risk is limited because `tab.rename` already exists and the new client-side work is a single `pane.rename` dispatch path.
- No dedicated performance benchmark is planned. These renames are single PATCH requests plus small in-memory mutations, so performance risk is low. Residual risk: a pathological regression in target resolution or broadcast fan-out would not be caught by this plan, but any such regression would more likely surface as functional test timeouts first.
- No separate test targets the plugin pointer file at `.claude/plugins/freshell-orchestration/skills/freshell-orchestration`, because the implementation plan explicitly leaves that pointer unchanged and the canonical skill file is the source of truth. Residual risk: if the pointer is independently broken, agents loading the plugin indirection could still miss the updated docs despite the canonical file being correct.
