# Fix OpenCode Startup Probes Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy still holds: the strongest evidence remains the real `TerminalView` create/attach/output path, with the pure startup-probe parser covered only as supporting proof. The material adjustment is narrower and stays within the agreed cost and scope: the repo already contains a first-pass startup-probe helper and tests, but the remaining review blockers show two acceptance gaps still are not encoded tightly enough. First, the `TerminalView` acceptance surface must prove startup-probe stripping is mode-agnostic, because the pure helper is already startup-armed and passes later standalone OSC 11 queries through unchanged. Second, the attach/replay acceptance surface must prove that replay completion announced by `terminal.output.gap` discards any buffered startup-probe fragment before the first live frame. The implementation plan and latest investigation still require the acceptance contract to be the real multi-frame websocket `terminal.output` sequence rather than invented combined payloads.

That means this plan reuses and extends the existing `test/e2e/opencode-startup-probes.test.tsx`, `test/unit/client/components/TerminalView.osc52.test.tsx`, and `test/unit/client/lib/terminal-startup-probes.test.ts` suites rather than creating parallel coverage. The shared helper must become a websocket-frame-first fixture, and the existing scenario tests must assert per-frame reply/no-write behavior before any later post-reply output is written. No paid services, browser automation, or broader infrastructure are needed.

Task 4 Step 3 in the implementation plan still requires the repo-wide `npm run lint` gate to pass in this worktree. That means this branch intentionally retains the small verification-only cleanup surface already needed for that gate in `src/components/TabsView.tsx`, `src/components/Sidebar.tsx`, `src/components/context-menu/ContextMenuProvider.tsx`, `src/store/persistMiddleware.ts`, and `test/unit/client/components/TabsView.test.tsx`. Those files are not alternate startup-probe behavior surfaces, but they are part of the finalized branch scope because the accepted verification path requires them.

## Sources Of Truth
- `S1 User-visible bug statement`: the transcript establishes that selecting a directory for an `opencode` pane must lead to a visible OpenCode UI instead of a blank hanging pane.
- `S2 Implementation invariants`: [2026-04-02-fix-opencode-startup-probes.md](./2026-04-02-fix-opencode-startup-probes.md) requires recognized startup probes to be stripped from live and replayed output, truthful replies to be emitted only for exact captured forms, replay hydration to stay reply-free, split probes to buffer correctly, and replay-carried fragments to be reset before live output resumes.
- `S3 WebSocket protocol contract`: [shared/ws-protocol.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/shared/ws-protocol.ts) defines the observable `terminal.create`, `terminal.attach`, `terminal.attach.ready`, `terminal.output`, `terminal.output.gap`, and `terminal.input` surfaces.
- `S4 Adjacent parser contracts`: [terminal-osc52.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/terminal-osc52.ts), [turn-complete-signal.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/turn-complete-signal.ts), and [request-mode-bypass.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/terminal/request-mode-bypass.ts) plus their existing tests define adjacent behavior that must not regress.
- `S5 Picker handoff contract`: [PaneContainer.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/panes/PaneContainer.tsx) and [directory-picker-flow.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/directory-picker-flow.test.tsx) define the user entry path from provider selection and directory confirmation to `TerminalPaneContent.initialCwd`.
- `S6 Frozen websocket capture contract`: update [opencode-startup-probes.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/helpers/opencode-startup-probes.ts) so it records the exact captured websocket startup frame sequence, the split-frame variant, the expected cleaned output, the expected truthful replies, and a short capture-source note. Any convenience joined text constant must be derived from `OPEN_CODE_STARTUP_POST_REPLY_FRAMES`, not the other way around.
- `S7 Existing acceptance surfaces`: [opencode-startup-probes.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/opencode-startup-probes.test.tsx), [TerminalView.osc52.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/unit/client/components/TerminalView.osc52.test.tsx), [terminal-startup-probes.test.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/unit/client/lib/terminal-startup-probes.test.ts), and [directory-picker-flow.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/directory-picker-flow.test.tsx) are the suites to extend or rerun. Once their expectations reflect `S6`, they become the acceptance gates for this fix.
- `S8 Generic safety proof for removing the mode gate`: [terminal-startup-probes.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/terminal-startup-probes.ts) and [terminal-startup-probes.test.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/unit/client/lib/terminal-startup-probes.test.ts) already show the helper only recognizes the captured OSC 11 query while it remains startup-armed, and that embedded or later standalone OSC 11 traffic is passed through unchanged. That makes a `mode === 'opencode'` gate unnecessary unless new evidence disproves this contract.

## Action Space
- Select `opencode` in the pane picker.
- Confirm a starting directory in the directory picker.
- Convert the picker pane into an `opencode` terminal pane with `initialCwd`.
- Send `terminal.create` for the new pane and receive `terminal.created`.
- Send `terminal.attach` and receive `terminal.attach.ready`.
- Process a live `terminal.output` frame containing only the captured startup probe.
- Process the later live `terminal.output` frames that carry the post-reply startup bytes in captured order.
- Process the captured startup probe through the same `TerminalView` output-preprocessing path in a non-`opencode` terminal mode.
- Process a recognized startup probe split across websocket frames.
- Process replay hydration frames containing historical startup probe bytes.
- Cross the replay-to-live boundary without completing a replay fragment on the first accepted live frame, including when replay completion is announced by `terminal.output.gap`.
- Send synthetic `terminal.input` replies only for live recognized startup probes.
- Continue OSC52 and turn-complete processing after startup-probe stripping.
- Preserve existing CSI request-mode replies unchanged.

## Harness Requirements
Harness work happens first because every high-value check depends on the frozen websocket fixture and the existing attach/output test surfaces.

| Harness | What it does | What it exposes | Estimated complexity | Tests that depend on it |
| --- | --- | --- | --- | --- |
| `H1 Shared websocket startup-probe fixture` | Replaces the current raw-PTY/synthetic helper assumptions with the exact websocket startup frame sequence, split-frame variant, expected cleaned output, expected replies, and a short capture-source note in one module. | Typed constants for `OPEN_CODE_STARTUP_PROBE_FRAME`, `OPEN_CODE_STARTUP_POST_REPLY_FRAMES`, `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES`, `OPEN_CODE_STARTUP_EXPECTED_REPLIES`, and `OPEN_CODE_STARTUP_EXPECTED_CLEANED`, plus any derived convenience join. | Low | 1, 2, 3, 4, 5, 6, 8, 9 |
| `H2 TerminalView output-preprocessing harness` | Extends `test/unit/client/components/TerminalView.osc52.test.tsx` with deterministic theme colors, mocked websocket send capture, xterm write capture, frame-by-frame `terminal.output` injection, and a way to render the same output path in both `opencode` and a non-`opencode` mode. | Assertions against outgoing `terminal.input`, xterm `write()`, clipboard/prompt side effects, and send-before-write ordering across multiple pane modes. | Medium | 6, 10 |
| `H3 Attach/replay startup scenario harness` | Extends `test/e2e/opencode-startup-probes.test.tsx` using the existing `terminal.created -> terminal.attach -> terminal.attach.ready -> terminal.output` path plus explicit `terminal.output.gap` replay completion. | End-to-end create/attach/replay sequencing with frame-by-frame startup output injection, visible xterm writes, and outgoing reply traffic across live, replay, split-frame, replay/live-boundary, and replay-completes-on-gap cases. | Medium | 1, 2, 3, 4, 5 |
| `H4 OpenCode picker handoff harness` | Reuses the existing directory-picker flow to exercise the user entry path into an `opencode` terminal pane. | User-level provider selection, directory confirmation, resulting pane content, and persisted provider cwd patch. | Low | 7 |

## Test Plan
1. **Name:** Live OpenCode startup replies to the probe-only websocket frame before any later startup output is written.
   **Type:** scenario
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** An `opencode` terminal pane has completed `terminal.created` and `terminal.attach.ready` with no replay window; `H1` provides the captured probe-only frame and later post-reply frames; deterministic terminal theme colors are active for reply bytes.
   **Actions:** Emit `OPEN_CODE_STARTUP_PROBE_FRAME` by itself as the first live `terminal.output` frame. Assert the intermediate state. Then emit each `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` item in captured order.
   **Expected outcome:** The probe-only frame emits one `terminal.input` per `OPEN_CODE_STARTUP_EXPECTED_REPLIES` and produces no xterm write. The later frames write only `OPEN_CODE_STARTUP_EXPECTED_CLEANED`, never the raw probe bytes. The reply sequence is fully sent before the first cleaned write. Source of truth: `S1`, `S2`, `S3`, `S6`, `S7`.
   **Interactions:** `TerminalView` output pipeline, websocket `terminal.input`/`terminal.output`, attach generation scoping, xterm write queue, terminal theme resolution.

2. **Name:** Replay hydration strips historical startup frames without sending late replies.
   **Type:** scenario
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** `terminal.attach.ready` announces a replay window covering the captured startup sequence from `H1`.
   **Actions:** Emit the captured probe-only frame and captured post-reply frames during replay hydration. After replay completes, emit one later live visible-output frame.
   **Expected outcome:** Replay writes contain only the cleaned historical startup text with probe bytes removed. No `terminal.input` reply traffic is emitted while replay hydration is in progress. Once replay completes, later live visible output still renders normally. Source of truth: `S1`, `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Attach/replay sequencing, replay-window tracking, stale attach filtering, websocket reply path, xterm write queue.

3. **Name:** A replay-carried startup-probe fragment is discarded before the first accepted live frame when replay completes on `terminal.output.gap`.
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** Replay hydration has delivered only the first fragment from `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES`; replay completion will be announced by `terminal.output.gap` rather than by a final replay `terminal.output` frame; the first accepted live frame begins with the second fragment and continues with captured startup output.
   **Actions:** Emit the first split fragment during replay. Emit a `terminal.output.gap` message that closes the replay window. Then emit the first accepted live frame with the remaining bytes plus captured startup output.
   **Expected outcome:** No synthetic `terminal.input` reply is emitted for the replay-carried fragment. The first live visible output writes only the cleaned post-reply startup bytes, with the replay fragment discarded rather than completed across the gap boundary. Source of truth: `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Startup-probe parser pending state, replay-completion reset on `terminal.output.gap`, websocket reply path, xterm write queue.

4. **Name:** The first accepted live frame after replay still replies to a complete startup probe.
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** Replay has fully completed and the next accepted live frame is the captured standalone `OPEN_CODE_STARTUP_PROBE_FRAME`.
   **Actions:** Emit `OPEN_CODE_STARTUP_PROBE_FRAME` as the first accepted post-replay live frame, then emit the captured `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` in order.
   **Expected outcome:** The parser emits `OPEN_CODE_STARTUP_EXPECTED_REPLIES` exactly once, then writes `OPEN_CODE_STARTUP_EXPECTED_CLEANED` exactly once, proving the replay reset does not suppress legitimate later live probes. Source of truth: `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Replay reset, live output path, websocket reply ordering, xterm write queue.

5. **Name:** A startup probe split across live websocket frames buffers until complete and replies exactly once.
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `H3`
   **Preconditions:** A live `opencode` attach is ready and `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES` from `H1` represent one recognized startup probe split across websocket boundaries.
   **Actions:** Emit the first split frame alone and assert the intermediate state. Then emit the second split frame followed by the first captured post-reply bytes, followed by any remaining captured post-reply frames.
   **Expected outcome:** After the first frame there is no visible write and no reply traffic. After the second frame completes the probe, the exact expected reply sequence is sent once and the cleaned startup output is written once, with no duplicate replies or raw probe bytes. Source of truth: `S2`, `S3`, `S6`, `S7`.
   **Interactions:** Startup-probe parser buffering, attach live output path, websocket reply path, xterm write queue.

6. **Name:** Startup-probe stripping in `TerminalView` is mode-agnostic and preserves same-path OSC52 clipboard behavior.
   **Type:** integration
   **Disposition:** extend
   **Harness:** `H2`
   **Preconditions:** `TerminalView` is rendered with deterministic theme colors and a known OSC52 policy once as `mode: 'opencode'` and once as a non-`opencode` terminal mode such as `shell`; `H1` supplies the captured probe-only frame and post-reply frames; an OSC52 clipboard sequence is appended to a later post-reply frame on the same output path.
   **Actions:** For each mode, emit `OPEN_CODE_STARTUP_PROBE_FRAME`, then emit the captured `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` in order with the OSC52 payload attached to a later frame.
   **Expected outcome:** In both modes, `ws.send` includes the exact startup-probe replies before the first cleaned write; xterm `write()` never receives raw startup-probe bytes; OSC52 still copies or prompts according to the selected policy. Source of truth: `S2`, `S4`, `S6`, `S7`, `S8`.
   **Interactions:** Startup-probe parser, pane mode selection, OSC52 parser, clipboard side effects, theme-derived reply bytes, xterm write scheduling.

7. **Name:** Selecting OpenCode in the directory picker launches a terminal pane with the confirmed cwd.
   **Type:** regression
   **Disposition:** existing
   **Harness:** `H4`
   **Preconditions:** The pane picker exposes an enabled and available `opencode` provider, and directory validation resolves the entered path.
   **Actions:** Open the picker, select `OpenCode`, enter a directory, and confirm it through the existing directory-picker flow.
   **Expected outcome:** The pane content becomes `kind: 'terminal'` with `mode: 'opencode'` and `initialCwd` equal to the resolved directory, and the provider cwd patch is persisted. Source of truth: `S1`, `S5`, `S7`.
   **Interactions:** `PanePicker`, `DirectoryPicker`, settings patch dispatch, pane content creation, provider metadata.

8. **Name:** The shared parser fixture maps the captured websocket sequence to exact replies and cleaned output.
   **Type:** differential
   **Disposition:** extend
   **Harness:** `H1`
   **Preconditions:** `H1` exports the captured probe-only frame, captured post-reply frames, expected replies, and expected cleaned output.
   **Actions:** Call `extractTerminalStartupProbes()` with `OPEN_CODE_STARTUP_PROBE_FRAME`, then feed each `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` item in order using the same deterministic colors as the live harness.
   **Expected outcome:** The probe-only frame yields `OPEN_CODE_STARTUP_EXPECTED_REPLIES` and no cleaned output. The later frames yield `OPEN_CODE_STARTUP_EXPECTED_CLEANED` with no extra replies for forms not present in the frozen capture. Source of truth: `S2`, `S6`, `S7`.
   **Interactions:** Pure startup-probe parser only.

9. **Name:** Unrecognized or incomplete OSC/APC traffic is preserved unless it matches the frozen startup contract.
   **Type:** invariant
   **Disposition:** existing
   **Harness:** `H1`
   **Preconditions:** Parser state is fresh; sample inputs include incomplete unknown escape traffic, malformed `OSC 11` traffic, and unrelated OSC/APC examples outside the frozen startup contract.
   **Actions:** Feed the parser the sample inputs across one or more calls.
   **Expected outcome:** Incomplete unknown traffic is buffered and later re-emitted unchanged; malformed or unrelated OSC/APC traffic remains in `cleaned` unchanged and emits no synthetic replies. Source of truth: `S2`, `S4`, `S6`, `S7`.
   **Interactions:** Pure startup-probe parser buffering and passthrough logic.

10. **Name:** Existing CSI request-mode, turn-complete, and non-startup OSC52 suites stay green beside the new startup-probe contract.
    **Type:** regression
    **Disposition:** existing
    **Harness:** existing repo suites plus `H2`
    **Preconditions:** Startup-probe changes are complete and the adjacent protocol suites remain available unchanged.
    **Actions:** Run the existing request-mode bypass unit tests, the existing client OSC52 parser tests, the existing client turn-complete parser tests, and the existing `TerminalView` lifecycle checks that cover adjacent terminal output preprocessing.
    **Expected outcome:** All existing suites continue to pass unchanged, proving the new startup-probe handling did not steal CSI request-mode queries, misclassify non-startup OSC traffic, or change turn-complete behavior. Source of truth: `S2`, `S4`, `S7`.
    **Interactions:** xterm CSI parser registration, client-side escape-sequence preprocessors, `TerminalView` output ordering.

## Coverage Summary
Covered:
- The actual failure surface after directory confirmation: live `terminal.output` handling in `TerminalView`, including reply-before-write ordering and visible startup rendering.
- Replay hydration semantics for historical startup bytes, including replay/live reset behavior and replay completion via `terminal.output.gap`.
- Split-frame buffering across websocket boundaries.
- Mode-agnostic startup-probe handling at the `TerminalView` output-preprocessing layer.
- Coexistence with adjacent preprocessing behavior, especially OSC52, request-mode bypass, and turn-complete parsing.
- The user entry path from picker selection to `opencode` terminal pane creation.
- The exact parser contract driven by the frozen websocket fixture.

Explicitly excluded per the agreed strategy:
- Launching a real OpenCode binary inside automated CI after the fixture is captured.
- Using raw PTY chunk boundaries as the acceptance source of truth for websocket-frame tests.
- Broad server-side spawn or launcher tests, because the investigation and implementation plan both show the bug occurs after PTY launch and after `terminal.output` begins.
- Manual QA or human visual inspection as a pass/fail gate.
- Guessing support for startup probe forms not present in the frozen capture.

Risks carried by those exclusions:
- If a future OpenCode release changes its startup probes again, the fixture-driven suite will need a new captured websocket sequence; it will not predict unseen upstream probe formats ahead of time.
- Because the automated suite does not launch a live OpenCode process, it proves Freshell's client contract against the frozen failing bytes rather than every future upstream OpenCode version.
- Because server spawn is excluded from the acceptance stack, a future bug that combines launch-path and startup-probe failures would require an additional integrated scenario beyond this narrow fix.
