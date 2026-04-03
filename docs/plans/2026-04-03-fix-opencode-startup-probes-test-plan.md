# Fix OpenCode Startup Probes Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy still holds: acceptance should stay centered on the real `terminal.create -> terminal.created -> terminal.attach -> terminal.attach.ready -> terminal.output` path in `TerminalView`, with the pure startup-probe parser used only as supporting proof and the directory-picker flow kept as the user entry regression. The implementation plan and current branch state only require a narrower adjustment: the websocket fixture and the focused harnesses already exist in this worktree, so this revision is limited to encoding the two remaining round-9 blockers without widening scope.

The required adjustments are:
- The `TerminalView` acceptance surface must instantiate at least one explicit non-`opencode` terminal mode, because the finalized plan forbids a `mode === 'opencode'` gate once the captured startup-probe handling is proven safe generically.
- The attach/replay acceptance surface must drive an attach that completes on `terminal.output.gap` after only a replay-carried startup-probe fragment, then prove the first accepted live frame discards that stale fragment instead of leaking `1;?\u0007...` bytes or suppressing a later legitimate live reply.

No paid services, external infrastructure, browser automation, or live OpenCode binary runs are needed for this revision. The frozen websocket fixture, existing Vitest/Testing Library harnesses, and the repo `lint`/`check` gates remain sufficient.

## Sources Of Truth
- `S1 User-visible bug statement`: the transcript establishes that selecting a directory for an `opencode` pane must lead to a visible OpenCode UI instead of a blank hanging pane.
- `S2 Finalized implementation invariants`: [2026-04-02-fix-opencode-startup-probes.md](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/docs/plans/2026-04-02-fix-opencode-startup-probes.md) requires captured startup probes to be stripped from live and replay output, truthful replies to be emitted only for the captured live forms, startup-probe handling to be mode-agnostic if safe, and replay-carried probe fragments to be discarded before later live traffic, including replay completion on `terminal.output.gap`.
- `S3 WebSocket protocol contract`: [ws-protocol.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/shared/ws-protocol.ts) defines the observable `terminal.create`, `terminal.attach`, `terminal.attach.ready`, `terminal.output`, `terminal.output.gap`, and `terminal.input` surfaces.
- `S4 Adjacent parser contracts`: [terminal-osc52.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/terminal-osc52.ts), [turn-complete-signal.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/turn-complete-signal.ts), and [request-mode-bypass.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/terminal/request-mode-bypass.ts) define neighboring output-preprocessing behavior that must not regress.
- `S5 Picker handoff contract`: [PaneContainer.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/panes/PaneContainer.tsx) and [directory-picker-flow.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/directory-picker-flow.test.tsx) define the user entry path from provider selection and directory confirmation to `TerminalPaneContent.initialCwd`.
- `S6 Frozen websocket startup fixture`: [opencode-startup-probes.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/helpers/opencode-startup-probes.ts) is the single source of truth for the exact captured probe-only websocket frame, later post-reply frames, split-frame variant, expected cleaned output, and truthful replies.
- `S7 Existing acceptance surfaces`: [opencode-startup-probes.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/opencode-startup-probes.test.tsx), [TerminalView.osc52.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/unit/client/components/TerminalView.osc52.test.tsx), [terminal-startup-probes.test.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/unit/client/lib/terminal-startup-probes.test.ts), and [directory-picker-flow.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/directory-picker-flow.test.tsx) are the harnesses to extend or rerun.
- `S8 Branch verification gate`: the finalized implementation plan keeps repo-wide `npm run lint` and `FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm run check` in scope, plus the retained cleanup files required for those gates to pass in this worktree.
- `S9 Generic-safety proof for removing the mode gate`: [terminal-startup-probes.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/terminal-startup-probes.ts) and [terminal-startup-probes.test.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/unit/client/lib/terminal-startup-probes.test.ts) already show the helper only recognizes the captured startup OSC 11 query while it remains startup-armed and passes later or embedded OSC 11 traffic through unchanged.

## Action Space
- Click the `OpenCode` provider button in the pane picker.
- Submit the directory-picker form for `OpenCode`.
- Convert the picker pane into a terminal pane with `mode: 'opencode'` and `initialCwd`.
- Send `terminal.create` for the new pane.
- Receive `terminal.created`.
- Send `terminal.attach`.
- Receive `terminal.attach.ready`.
- Receive a live `terminal.output` frame containing only the captured startup probe.
- Receive the later live `terminal.output` frames carrying the captured post-reply startup bytes.
- Receive the same captured startup-probe bytes while the pane mode is `shell`.
- Receive replay `terminal.output` frames containing historical startup bytes.
- Receive replay completion on a terminal-output frame.
- Receive replay completion on `terminal.output.gap`.
- Receive the first accepted live `terminal.output` frame after replay completion.
- Send synthetic `terminal.input` replies for live recognized startup probes.
- Process a later OSC52 clipboard sequence on the same output path.
- Run the existing request-mode bypass path for CSI request-mode replies.
- Run the repo `lint` and `check` verification gates for the retained branch scope.

## Harness Requirements
No new harness families are required. Extend the existing harnesses first.

| Harness | What it does | What it exposes | Estimated complexity | Tests that depend on it |
| --- | --- | --- | --- | --- |
| `H1 Shared websocket startup fixture` | Reuses the existing exact websocket startup fixture and, if needed, tightens comments or names so every suite consumes the same captured frame boundaries and split-frame variant. | `OPEN_CODE_STARTUP_PROBE_FRAME`, `OPEN_CODE_STARTUP_POST_REPLY_FRAMES`, `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES`, `OPEN_CODE_STARTUP_EXPECTED_REPLIES`, and `OPEN_CODE_STARTUP_EXPECTED_CLEANED`. | Low | 1, 2, 3, 4, 5, 6, 8, 9 |
| `H2 TerminalView output-preprocessing harness` | Extends the existing `TerminalView.osc52` harness so it can render the same output path in both `opencode` and `shell` modes, capture `terminal.input` sends, capture xterm writes, and assert send-before-write ordering with deterministic theme colors. | Frame-by-frame `terminal.output` injection, outgoing `terminal.input`, xterm `write()`, clipboard side effects, and exact ordering across pane modes. | Medium | 2, 8, 10 |
| `H3 Attach/replay startup scenario harness` | Extends the existing `opencode-startup-probes` scenario harness so it can drive replay windows, replay completion on `terminal.output` and `terminal.output.gap`, stale-fragment discard, split probes, and first-live-frame assertions through the real create/attach/output path. | End-to-end `terminal.created -> terminal.attach -> terminal.attach.ready -> terminal.output` sequencing, replay/live transitions, visible writes, and outgoing reply traffic. | Medium | 1, 3, 4, 5, 6 |
| `H4 OpenCode picker handoff harness` | Reuses the existing directory-picker flow so the user entry path from provider selection to terminal-pane creation remains protected. | Provider selection, directory confirmation, resulting pane content, and persisted provider cwd patch. | Low | 7 |
| `H5 Broad branch verification gate` | Reuses existing repo commands and retained unit suites so the branch-scoped cleanup files remain honest and adjacent protocol behavior stays green. | `npm run lint`, `npm run check`, and targeted adjacent suites for request-mode, OSC52, turn-complete, lifecycle, and `TabsView`. | Low | 10 |

## Test Plan
1. **Name:** Replay completion on `terminal.output.gap` discards a stale startup-probe fragment before the first live frame.
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** An attach is in replay mode; replay has delivered only the first element of `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES`; replay completion will arrive on `terminal.output.gap`; the first accepted live frame begins with the remaining probe bytes followed by captured startup output.
   **Actions:** Emit the first split fragment during replay. Emit `terminal.output.gap` that closes the replay window. Then emit the first accepted live `terminal.output` frame containing the remainder of the split probe plus the first captured post-reply bytes.
   **Expected outcome:** No `terminal.input` reply is emitted for the replay-carried fragment. The first accepted live write contains only the cleaned post-reply startup bytes from `OPEN_CODE_STARTUP_EXPECTED_CLEANED`; no raw or partial startup-probe bytes such as `1;?\u0007` leak into the write stream. Source of truth: `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Attach sequence state, replay completion on `terminal.output.gap`, startup-probe parser pending state, websocket reply path, xterm write queue.

2. **Name:** `TerminalView` strips captured startup probes in both `opencode` and `shell` modes and still preserves OSC52 behavior.
   **Type:** integration
   **Disposition:** extend
   **Harness:** `H2`
   **Preconditions:** `TerminalView` is rendered twice with deterministic theme colors and the same startup fixture from `H1`: once with `mode: 'opencode'` and once with `mode: 'shell'`; an OSC52 clipboard sequence is appended to a later post-reply frame.
   **Actions:** For each mode, emit `OPEN_CODE_STARTUP_PROBE_FRAME`, then emit `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` in order with the OSC52 payload attached to a later frame.
   **Expected outcome:** In both modes, `ws.send` emits `OPEN_CODE_STARTUP_EXPECTED_REPLIES` before the first cleaned write; xterm `write()` never receives the probe bytes; the later OSC52 payload still follows the configured clipboard policy. This test must fail if `handleTerminalOutput` keeps a `mode === 'opencode'` gate. Source of truth: `S2`, `S4`, `S6`, `S7`, `S9`.
   **Interactions:** Startup-probe parser, pane mode handling, OSC52 parser, clipboard side effects, theme-derived reply bytes, xterm write scheduling.

3. **Name:** The first live probe-only websocket frame is answered before any later startup output is written.
   **Type:** scenario
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** An `opencode` terminal pane has completed `terminal.created` and `terminal.attach.ready` with no replay window; `H1` provides the captured probe-only frame and later post-reply frames.
   **Actions:** Emit `OPEN_CODE_STARTUP_PROBE_FRAME` as the first live `terminal.output` frame. Assert the intermediate state. Then emit each `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` item in captured order.
   **Expected outcome:** The probe-only frame emits one `terminal.input` per `OPEN_CODE_STARTUP_EXPECTED_REPLIES` and causes no xterm write. The later frames write only `OPEN_CODE_STARTUP_EXPECTED_CLEANED`. The reply sequence is fully sent before the first visible write. Source of truth: `S1`, `S2`, `S3`, `S6`, `S7`.
   **Interactions:** `TerminalView` output pipeline, websocket `terminal.input`/`terminal.output`, xterm write queue, terminal theme resolution.

4. **Name:** Replay hydration strips historical startup bytes without sending late replies.
   **Type:** scenario
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** `terminal.attach.ready` announces a replay window covering the captured startup sequence from `H1`.
   **Actions:** Emit the captured probe-only frame and captured post-reply frames during replay hydration. After replay completes, emit one later live visible-output frame.
   **Expected outcome:** Replay writes contain only cleaned historical startup output with the probe bytes removed. No `terminal.input` reply traffic is emitted during replay hydration. Later live output still renders normally after replay ends. Source of truth: `S1`, `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Attach/replay sequencing, replay-window tracking, websocket reply path, xterm write queue.

5. **Name:** The first accepted live frame after replay still replies to a complete startup probe.
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** Replay has completed and the next accepted live frame is the captured standalone `OPEN_CODE_STARTUP_PROBE_FRAME`.
   **Actions:** Emit `OPEN_CODE_STARTUP_PROBE_FRAME` as the first accepted post-replay live frame, then emit `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` in order.
   **Expected outcome:** The parser emits `OPEN_CODE_STARTUP_EXPECTED_REPLIES` exactly once and writes `OPEN_CODE_STARTUP_EXPECTED_CLEANED` exactly once, proving replay cleanup does not suppress legitimate later live probes. Source of truth: `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Replay reset behavior, live output path, websocket reply ordering, xterm write queue.

6. **Name:** A startup probe split across live websocket frames buffers until complete and replies exactly once.
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** A live `opencode` attach is ready and `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES` represents one recognized startup probe split across websocket boundaries.
   **Actions:** Emit the first split frame alone. Then emit the second split frame followed by the first captured post-reply bytes, followed by any remaining captured post-reply frames.
   **Expected outcome:** After the first frame there is no reply and no visible write. After the second frame completes the probe, the exact expected reply sequence is sent once and the cleaned startup output is written once, with no duplicate replies or raw probe bytes. Source of truth: `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Startup-probe parser buffering, live output path, websocket reply path, xterm write queue.

7. **Name:** Selecting `OpenCode` in the directory picker launches a terminal pane with the confirmed cwd.
   **Type:** regression
   **Disposition:** existing
   **Harness:** `H4`
   **Preconditions:** The pane picker exposes an enabled `OpenCode` provider and directory validation resolves the entered path.
   **Actions:** Open the picker, select `OpenCode`, enter a directory, and confirm it through the existing directory-picker flow.
   **Expected outcome:** The pane content becomes `kind: 'terminal'` with `mode: 'opencode'` and `initialCwd` equal to the resolved directory, and the provider cwd patch is persisted. Source of truth: `S1`, `S5`, `S7`.
   **Interactions:** `PanePicker`, `DirectoryPicker`, pane content creation, provider settings persistence.

8. **Name:** The shared parser fixture maps the captured websocket startup sequence to exact replies and cleaned output.
   **Type:** differential
   **Disposition:** existing
   **Harness:** `H1`
   **Preconditions:** `H1` exports the captured probe-only frame, captured post-reply frames, expected replies, and expected cleaned output; deterministic colors are available.
   **Actions:** Call `extractTerminalStartupProbes()` with `OPEN_CODE_STARTUP_PROBE_FRAME`, then feed each `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` item in order using the same colors as the live harness.
   **Expected outcome:** The probe-only frame yields `OPEN_CODE_STARTUP_EXPECTED_REPLIES` and no cleaned output. The later frames yield `OPEN_CODE_STARTUP_EXPECTED_CLEANED` with no extra replies for forms not present in the frozen capture. Source of truth: `S2`, `S6`, `S7`, `S9`.
   **Interactions:** Pure startup-probe parser only.

9. **Name:** Unrecognized, malformed, or incomplete OSC/APC traffic is preserved unless it matches the frozen startup contract.
   **Type:** invariant
   **Disposition:** existing
   **Harness:** `H1`
   **Preconditions:** Parser state is fresh; inputs include incomplete unknown escape traffic, malformed startup-probe traffic, and unrelated OSC/APC examples outside the frozen capture.
   **Actions:** Feed the parser the sample inputs across one or more calls.
   **Expected outcome:** Unknown incomplete traffic is buffered and later re-emitted unchanged; malformed or unrelated OSC/APC traffic remains in `cleaned` unchanged and emits no synthetic replies. Source of truth: `S2`, `S4`, `S6`, `S7`, `S9`.
   **Interactions:** Pure startup-probe parser buffering and passthrough logic.

10. **Name:** Adjacent protocol suites and retained lint-gate cleanup stay green with the startup-probe fix.
   **Type:** regression
   **Disposition:** existing
   **Harness:** `H5`
   **Preconditions:** Startup-probe changes are complete and the retained cleanup files remain in branch scope.
   **Actions:** Run the existing request-mode bypass suite, the existing `terminal-osc52` and `turn-complete-signal` parser suites, the relevant `TerminalView` lifecycle/OSC52 suites, the retained `TabsView` unit suite, `npm run lint`, and `FRESHELL_TEST_SUMMARY="opencode startup probe fix" npm run check`.
   **Expected outcome:** All suites and repo gates pass unchanged, proving the new startup-probe handling does not steal CSI request-mode replies, regress neighboring output preprocessors, or leave the retained cleanup surface unverified. Source of truth: `S2`, `S4`, `S7`, `S8`.
   **Interactions:** xterm CSI parser registration, client-side escape-sequence preprocessors, `TerminalView` lifecycle behavior, `TabsView` accessibility expectations, lint/typecheck/coordinated repo suite.

## Coverage Summary
Covered:
- The actual user-visible failure surface after directory confirmation: live `terminal.output` handling in `TerminalView`, including reply-before-write ordering.
- The two remaining acceptance blockers: mode-agnostic startup-probe stripping and replay-fragment discard when replay completes on `terminal.output.gap`.
- Replay hydration semantics, split-frame buffering, and first-live-frame behavior after replay.
- Coexistence with adjacent output preprocessors, especially OSC52, turn-complete, and CSI request-mode bypass.
- The user entry path from picker selection to an `opencode` terminal pane with the confirmed cwd.
- The retained branch verification gates needed to keep the current worktree mergeable.

Explicitly excluded per the agreed strategy:
- Launching a real OpenCode binary in automated CI after the websocket fixture is frozen.
- Using raw PTY chunk boundaries as the acceptance source of truth for websocket-frame tests.
- Broad server-side spawn or launcher tests, because the investigation and implementation plan both place the bug after PTY launch and after `terminal.output` begins.
- Manual QA or human visual inspection as a pass/fail gate.
- Guessing support for startup-probe forms not present in the frozen websocket capture.

Risks carried by those exclusions:
- If a future OpenCode release changes its startup probes again, the fixture-driven suites will need a new captured websocket sequence; they will not predict unseen upstream probe formats ahead of time.
- Because the automated suite does not launch a live OpenCode process, it proves Freshell's client behavior against the frozen failing bytes rather than every future upstream OpenCode version.
- Because server spawn is excluded from the acceptance stack, a future bug that combines launch-path and startup-probe failures would need a separate integrated scenario.
