# Pane Context Menu Stability And Terminal Clipboard Section — Test Plan

Date: 2026-03-10
Source: `/home/user/code/freshell/.worktrees/trycycle-pane-context-menu-fix/docs/plans/2026-03-07-pane-context-menu-stability-and-terminal-clipboard-section-replan.md`

Strategy reconciliation: no strategy changes are required. The implementation plan keeps the agreed medium automated-only scope, uses the same four proof seams from the transcript, and adds no external services, paid APIs, or broader interaction surface than the strategy already covered.

Named sources of truth used below:

- `S1 User request`: right-clicking a pane must stop immediately reclosing the custom menu; terminal `copy`, `Paste`, and `Select all` must move into their own top section; those three items must have icons; `copy` must be labeled exactly `copy`.
- `S2 Agreed testing strategy`: use medium coverage centered on one inactive-pane regression, one builder contract, one provider/rendered DOM proof, and one screenshot proof; automated checks only.
- `S3 Implementation plan`: `test/e2e/pane-context-menu-stability.test.tsx` is the authoritative stability proof; `test/unit/client/context-menu/menu-defs.test.ts` is the canonical contract for order, labels, disabled state, and action wiring; `test/unit/client/components/ContextMenuProvider.test.tsx` proves rendered order and icon presence; `test/unit/client/ui-screenshot.test.ts` must write `/tmp/freshell-terminal-context-menu-proof.png` and prove the captured DOM contains the requested menu section; non-clipboard terminal actions stay after the new separator in their current relative order; primary-click pane activation must still work.
- `S4 Existing behavior and regression oracles`: pane shells currently activate on primary interaction, terminal menus still expose terminal actions like `Refresh pane`, `Search`, `Scroll to bottom`, `Clear scrollback`, `Reset terminal`, and `Replace pane`, and the custom menu exposes accessible `menu`, `menuitem`, and `separator` roles.
- `S5 Screenshot capture contract`: `captureUiScreenshot({ scope: 'view' })` captures the view root or `document.body`, so a portal-mounted context menu is part of the capture target when the screenshot test renders without a `[data-context="global"]` wrapper.

## Harness requirements

1. `test/e2e/pane-context-menu-stability.test.tsx`
What it does: renders a real two-pane layout under `ContextMenuProvider` with mocked websocket, API, and xterm surfaces so right-click behavior can be exercised on inactive pane chrome and inactive terminal content.
What it exposes: user-event right-click and left-click simulation, Redux state inspection for active pane changes, DOM inspection of the live context menu.
Estimated complexity: low; it copies existing `refresh-context-menu-flow` and xterm mock patterns.
Tests that depend on it: 1, 2, 3.

2. `test/unit/client/context-menu/menu-defs.test.ts`
What it does: calls `buildMenuItems(target, ctx)` directly for terminal targets.
What it exposes: ordered menu item arrays, labels, separators, disabled state, attached icons, and action callbacks.
Estimated complexity: low; the harness already exists and only needs stronger assertions.
Tests that depend on it: 5, 6.

3. `test/unit/client/components/ContextMenuProvider.test.tsx`
What it does: opens a real portal-backed `ContextMenu` through `ContextMenuProvider` against a store-backed terminal pane.
What it exposes: right-click input simulation, rendered DOM order, `role="menu"` / `role="menuitem"` / `role="separator"` inspection, and inline SVG presence.
Estimated complexity: low; the provider harness already exists.
Tests that depend on it: 4, 7.

4. `test/unit/client/ui-screenshot.test.ts`
What it does: runs real `captureUiScreenshot()` against a rendered provider tree, captures the cloned DOM passed to `html2canvas`, and persists the returned image bytes to disk.
What it exposes: screenshot result payload, cloned DOM inspection for captured menu content, and filesystem verification of the PNG artifact at `/tmp/freshell-terminal-context-menu-proof.png`.
Estimated complexity: medium; it extends the existing screenshot test with store setup and artifact I/O.
Tests that depend on it: 8.

## Test plan

1. Name: `Right-clicking an inactive pane header keeps the pane menu open instead of flashing closed`

Type: scenario
Harness: `test/e2e/pane-context-menu-stability.test.tsx`
Preconditions: a two-pane tab is rendered; `pane-1` starts active; `pane-2` is a terminal pane with a visible header and is inactive.
Actions:
1. Right-click the header (`role="banner"`) of `pane-2`.
2. Wait for the same post-event settling window the implementation plan calls out for this race.
Expected outcome:
- A context menu with `role="menu"` remains present after settling. Source: `S1`, `S2`, `S3`.
- The visible menu still exposes pane-shell actions such as `Refresh pane`, proving the pane context menu opened rather than a native menu or a closed state. Source: `S3`, `S4`.
- The test must fail against the pre-fix behavior where the menu recloses immediately on this path. Source: `S1`, `S2`, `S3`.
Interactions: pane shell mouse handling in `Pane.tsx`, document-level `contextmenu` interception in `ContextMenuProvider`, menu portal rendering in `ContextMenu`.

2. Name: `Right-clicking inside an inactive terminal body keeps the terminal menu open`

Type: scenario
Harness: `test/e2e/pane-context-menu-stability.test.tsx`
Preconditions: the same two-pane layout is rendered; `pane-2` is inactive; the xterm mock has opened a discoverable terminal surface inside `pane-2`.
Actions:
1. Right-click the xterm surface inside inactive `pane-2`.
2. Wait for the menu-settling window.
Expected outcome:
- A context menu with `role="menu"` remains present after settling. Source: `S1`, `S2`, `S3`.
- The menu exposes terminal-specific actions such as `Search`, proving the terminal target kept its own context menu instead of closing or downgrading to the pane menu. Source: `S3`, `S4`.
- This scenario reproduces the same user complaint through the terminal-body route, which the original request left ambiguous and the strategy explicitly chose to cover. Source: `S1`, `S2`.
Interactions: xterm surface mounting from `TerminalView`, terminal target parsing in `ContextMenuProvider`, terminal menu branch in `buildMenuItems`.

3. Name: `Primary click still activates an inactive pane after the secondary-click fix`

Type: regression
Harness: `test/e2e/pane-context-menu-stability.test.tsx`
Preconditions: a two-pane layout is rendered; `pane-2` starts inactive.
Actions:
1. Primary-click the header of `pane-2`.
2. Wait for the pane state update.
Expected outcome:
- Redux active-pane state for `tab-1` changes to `pane-2`. Source: `S3`, `S4`.
- No context menu is required for this flow; the unchanged primary-click activation behavior remains intact while right-click handling changes. Source: `S3`, `S4`.
Interactions: pane shell `onMouseDown` behavior, pane activation state in `panesSlice`, header event bubbling.

4. Name: `Opening the terminal context menu shows copy, Paste, and Select all as the first rendered section with icons`

Type: scenario
Harness: `test/unit/client/components/ContextMenuProvider.test.tsx`
Preconditions: a store-backed terminal pane is rendered inside `ContextMenuProvider`; the terminal target can be right-clicked.
Actions:
1. Right-click the terminal context target.
2. Read the first rendered children of the `role="menu"` element.
Expected outcome:
- The first three rendered `menuitem` nodes are `copy`, `Paste`, and `Select all`, followed by a `separator`. Source: `S1`, `S2`, `S3`.
- The rendered text for the first item is exactly `copy`, not `Copy selection`. Source: `S1`, `S3`.
- Each of the first three rendered items contains an SVG icon. Source: `S1`, `S3`, `S4`.
Interactions: provider target parsing, `buildMenuItems` output, `ContextMenu` DOM rendering, Lucide icon rendering.

5. Name: `The terminal menu builder places the clipboard commands in the top section with the requested label and icons`

Type: integration
Harness: `test/unit/client/context-menu/menu-defs.test.ts`
Preconditions: `buildMenuItems()` is called for a terminal target with available terminal actions.
Actions:
1. Build terminal menu items.
2. Inspect the first four entries and the per-item metadata for the clipboard commands.
Expected outcome:
- The top sequence is `terminal-copy`, `terminal-paste`, `terminal-select-all`, then the clipboard separator. Source: `S1`, `S2`, `S3`.
- `terminal-copy.label === 'copy'`. Source: `S1`, `S3`.
- `terminal-copy`, `terminal-paste`, and `terminal-select-all` each provide a non-empty `icon`. Source: `S1`, `S3`.
Interactions: terminal branch in `buildMenuItems`, menu item metadata consumed later by `ContextMenu`.

6. Name: `The terminal menu builder preserves copy enablement and keeps the remaining terminal actions after the new separator in their prior order`

Type: boundary
Harness: `test/unit/client/context-menu/menu-defs.test.ts`
Preconditions: one builder call runs with `hasSelection()` true and another with `hasSelection()` false; terminal action callbacks are spies.
Actions:
1. Build terminal menu items with a selected terminal and invoke the `copy` item callback.
2. Build terminal menu items with no selection.
3. Compare the relative positions of `Search`, any resume item, `Scroll to bottom`, `Clear scrollback`, `Reset terminal`, and `Replace pane` against the new clipboard separator.
Expected outcome:
- When the terminal reports a selection, `copy` is enabled and invokes `copySelection()` exactly once. Source: `S2`, `S3`.
- When the terminal reports no selection, `copy` is disabled while the terminal menu still includes `Paste` and `Select all`. Source: `S2`, `S3`, `S4`.
- `Search` appears after the new clipboard separator, and the remaining non-clipboard terminal actions keep their existing relative order after that separator. Source: `S3`, `S4`.
Interactions: terminal action registry contract, resume-command insertion path, builder ordering logic.

7. Name: `The rendered terminal menu keeps accessible menu structure while adding the new top section`

Type: invariant
Harness: `test/unit/client/components/ContextMenuProvider.test.tsx`
Preconditions: the terminal context menu is opened through `ContextMenuProvider`.
Actions:
1. Query the rendered menu by role.
2. Inspect the first section and the role-bearing separator node.
Expected outcome:
- The open menu is still addressable as `role="menu"` and its actions as `role="menuitem"`. Source: `S4`.
- The divider between the clipboard section and the rest of the terminal menu is rendered as `role="separator"`. Source: `S3`, `S4`.
- Adding icons does not remove the visible action labels needed for menuitem discovery. Source: `S1`, `S4`.
Interactions: `ContextMenu` role rendering, provider-driven portal mount, DOM text content used by accessibility and automation.

8. Name: `Screenshot capture writes a real PNG proof that includes the new terminal clipboard section`

Type: integration
Harness: `test/unit/client/ui-screenshot.test.ts`
Preconditions: a store-backed terminal menu is opened through `ContextMenuProvider`; the screenshot test renders without a `[data-context="global"]` wrapper so `captureUiScreenshot({ scope: 'view' })` captures `document.body`; `/tmp/freshell-terminal-context-menu-proof.png` does not exist before the test starts.
Actions:
1. Open the terminal context menu.
2. Mock `html2canvas` so the test can inspect the cloned DOM and return deterministic PNG bytes.
3. Call `captureUiScreenshot({ scope: 'view' })`.
4. Write the returned base64 payload to `/tmp/freshell-terminal-context-menu-proof.png`.
5. Read the file back from disk.
Expected outcome:
- `captureUiScreenshot()` succeeds and targets the view-level root that includes the portalized menu. Source: `S3`, `S5`.
- The cloned DOM passed to the screenshot capture contains `copy`, `Paste`, and `Select all` as the first captured menuitems, each with an SVG icon. Source: `S1`, `S3`, `S5`.
- The written artifact exists at `/tmp/freshell-terminal-context-menu-proof.png` and begins with the PNG file signature bytes, proving the artifact is a real PNG rather than placeholder text. Source: `S3`.
Interactions: screenshot focus-management path in `captureUiScreenshot`, context-menu portal rendering, `html2canvas` clone hook, filesystem writes under `/tmp`.

## Coverage summary

- Covered action space:
  - Right-clicking an inactive pane header.
  - Right-clicking inside an inactive terminal body.
  - Primary-click pane activation after the right-click fix.
  - Opening a terminal context menu through the real provider and rendered DOM.
  - The requested clipboard-section order, exact `copy` label, and icon presence.
  - Clipboard action enable/disable behavior and callback wiring.
  - Preservation of the remaining terminal action order after the new separator.
  - Screenshot capture of the portalized menu and proof-artifact creation.

- Explicitly excluded per the agreed strategy:
  - Manual browser verification or human spot checks.
  - Mobile long-press paths and other touch-specific context-menu behavior.
  - Non-terminal menu branches beyond regression coverage for unchanged pane and terminal actions.
  - Dedicated performance benchmarks.

- Risks carried by those exclusions:
  - A browser-only quirk outside jsdom could still exist, but the agreed strategy accepted automated-only proof and concentrates on the exact right-click race the user reported.
  - Mobile long-press regressions would rely on existing long-press coverage because this change is targeted at pane mouse-down focus and terminal menu ordering.
  - No performance assertion is added because the agreed strategy classified runtime perf risk as low; a regression here would most likely surface as a functional close/open failure, which the scenario tests already exercise.
