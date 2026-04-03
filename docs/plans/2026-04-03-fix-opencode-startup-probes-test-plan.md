# Fix OpenCode Startup Probes Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy still holds. The implementation plan changes only the client-side terminal output path after `terminal.output` begins, and the repo already has the two harnesses that matter most for that surface: the `TerminalView` output-preprocessing harness in `test/unit/client/components/TerminalView.osc52.test.tsx` and the attach/replay sequencing harness in `test/e2e/terminal-create-attach-ordering.test.tsx`.

Two small adjustments are needed inside the same cost and scope:

1. Treat the new live/replay `TerminalView` checks as the primary acceptance gates, because they prove the actual hang is fixed on the user-visible output surface where the failure occurs.
2. Keep directory-picker coverage as a lower-priority boundary regression by extending the existing picker flow to `opencode`, rather than building a more brittle full picker-plus-real-terminal mega-harness.

The plan does not require paid services, browser automation, or a live OpenCode binary in CI. The only external artifact is the frozen startup-probe fixture captured once from the failing websocket output and checked into the repo.

## Sources Of Truth
- `S1 User-visible bug statement`: the transcript establishes that selecting a directory for an `opencode` pane must lead to a visible OpenCode UI instead of a blank hanging pane.
- `S2 Implementation invariants`: [2026-04-02-fix-opencode-startup-probes.md](./2026-04-02-fix-opencode-startup-probes.md) requires recognized startup probes to be stripped from live and replayed output, truthful replies to be emitted only for exact captured forms, replay hydration to stay reply-free, split probes to buffer correctly, and unrelated OSC/APC traffic to pass through unchanged.
- `S3 WebSocket protocol contract`: [shared/ws-protocol.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/shared/ws-protocol.ts) defines the observable `terminal.create`, `terminal.attach`, `terminal.attach.ready`, `terminal.output`, `terminal.output.gap`, and `terminal.input` surfaces.
- `S4 Existing parser contracts`: [terminal-osc52.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/terminal-osc52.ts), [turn-complete-signal.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/turn-complete-signal.ts), and [request-mode-bypass.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/terminal/request-mode-bypass.ts) plus their existing tests define adjacent behavior that must not regress.
- `S5 Picker handoff contract`: [PaneContainer.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/panes/PaneContainer.tsx) and [directory-picker-flow.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/directory-picker-flow.test.tsx) define the user entry path from provider selection and directory confirmation to `TerminalPaneContent.initialCwd`.
- `S6 Frozen capture contract`: `test/helpers/opencode-startup-probes.ts` will be the authoritative reference for the exact failing websocket bytes, split-frame variant, expected cleaned output, and expected truthful replies. If the fixture cannot justify an assertion, that assertion is out of scope.

## Action Space
- Select `opencode` in the pane picker.
- Confirm a starting directory in the directory picker.
- Convert the picker pane into an `opencode` terminal pane with `initialCwd`.
- Send `terminal.create` for the new pane.
- Receive `terminal.created` and send `terminal.attach`.
- Receive `terminal.attach.ready` and begin replay or live streaming.
- Process a live `terminal.output` frame containing recognized startup probes.
- Process a live `terminal.output` frame containing startup probes plus visible OpenCode text in the same frame.
- Process a startup probe split across websocket frames.
- Process replay hydration frames containing historical startup probes.
- Send synthetic `terminal.input` replies only for live recognized probes.
- Continue processing adjacent OSC52 and turn-complete traffic after startup-probe stripping.
- Preserve existing CSI request-mode reply behavior unchanged.

## Harness Requirements
Harness work happens first because every high-value test depends on it.

| Harness | What it does | What it exposes | Estimated complexity | Tests that depend on it |
| --- | --- | --- | --- | --- |
| `H1 Shared startup-probe fixture` | Stores the exact captured OpenCode startup frame, split-frame variant, expected cleaned text, expected replies, and a short capture-source note in one module. | Typed constants that every new test imports as the single protocol reference. | Low | 1, 2, 3, 4, 6, 7 |
| `H2 TerminalView output-preprocessing harness` | Extends `test/unit/client/components/TerminalView.osc52.test.tsx` with deterministic theme colors, attach-request normalization, mocked websocket send capture, and xterm write capture. | Programmatic injection of `terminal.output` frames plus assertions against `ws.send`, `term.write`, clipboard/modal side effects, and call order. | Medium | 4, 8 |
| `H3 Attach/replay startup scenario harness` | Adds `test/e2e/opencode-startup-probes.test.tsx` using the existing `terminal-create-attach-ordering` pattern for `terminal.created -> terminal.attach -> terminal.attach.ready -> terminal.output`. | End-to-end create/attach/replay sequencing with visible xterm writes and outgoing `terminal.input` reply traffic. | Medium | 1, 2, 3 |
| `H4 OpenCode picker handoff harness` | Extends `test/e2e/directory-picker-flow.test.tsx` so the real picker path exercises `opencode`, not only `claude`. | User-level provider selection, directory confirmation, resulting pane content, and persisted provider cwd. | Low | 5 |

## Test Plan
1. **Name:** OpenCode startup replies unblock the first live frame before visible text is written.
   **Type:** scenario
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** A rendered `opencode` terminal pane has completed `terminal.created` and `terminal.attach.ready`; the shared fixture in `H1` is loaded; deterministic theme colors are in effect for any color-query reply bytes.
   **Actions:** Emit one live `terminal.output` frame whose payload is `OPEN_CODE_STARTUP_PROBE_FRAME + OPEN_CODE_STARTUP_VISIBLE_TEXT`.
   **Expected outcome:** The xterm write surface receives only `OPEN_CODE_STARTUP_EXPECTED_CLEANED`, never the raw probe bytes; `ws.send` records one `terminal.input` per `OPEN_CODE_STARTUP_EXPECTED_REPLIES`, in fixture order, before the cleaned write from that frame; the attach generation remains current. Source of truth: `S1`, `S2`, `S3`, `S6`.
   **Interactions:** `TerminalView` output pipeline, websocket `terminal.input`/`terminal.output`, attach generation scoping, xterm write queue, terminal theme resolution.

2. **Name:** Attach replay strips historical startup probes without sending late replies.
   **Type:** scenario
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** A running `opencode` terminal is attached through a replay window announced by `terminal.attach.ready`; the replay frames include the captured startup-probe bytes followed by visible OpenCode text.
   **Actions:** Emit replay `terminal.output` frames for the fixture bytes during hydration, then emit a subsequent live visible-output frame after replay completes.
   **Expected outcome:** Replay writes show only the cleaned historical text with startup probes removed; no `terminal.input` reply traffic is emitted while replay hydration is in progress; once replay completes, later live visible output still renders normally. Source of truth: `S1`, `S2`, `S3`, `S6`.
   **Interactions:** Attach/replay sequence state, websocket replay contract, xterm write queue, stale-generation filtering.

3. **Name:** A startup probe split across websocket frames buffers until complete and replies exactly once.
   **Type:** boundary
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** A live `opencode` attach is ready; `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES` from `H1` represent one recognized probe split across frame boundaries.
   **Actions:** Emit the first split frame alone; assert intermediate state; emit the second split frame with the remaining bytes and visible OpenCode text.
   **Expected outcome:** After the first frame there is no visible write and no reply traffic because the recognized probe is incomplete; after the second frame, the exact expected reply sequence is sent once and the cleaned visible text is written once, with no duplicate replies on overlap. Source of truth: `S2`, `S3`, `S6`.
   **Interactions:** Startup-probe parser state ref, attach live output path, websocket reply path, xterm write queue.

4. **Name:** Startup-probe stripping preserves same-path OSC52 clipboard behavior.
   **Type:** integration
   **Disposition:** extend
   **Harness:** `H2`
   **Preconditions:** `TerminalView.osc52` test store is rendered with deterministic theme colors and a known OSC52 policy (`always` or `ask`); the frame contains captured startup probes, visible text, and an OSC52 clipboard sequence in the same or immediately following frame.
   **Actions:** Emit the startup-probe frame, then emit or include the OSC52 payload using the existing websocket message harness.
   **Expected outcome:** `ws.send` includes the exact startup-probe replies before the cleaned visible write; `term.write` never receives raw startup-probe bytes; OSC52 continues to copy or prompt according to the selected policy exactly as it does today. Source of truth: `S2`, `S4`, `S6`.
   **Interactions:** Startup-probe parser, OSC52 parser, clipboard side effects, theme-derived reply bytes, xterm write scheduling.

5. **Name:** Selecting OpenCode in the directory picker still launches a terminal pane with the confirmed cwd.
   **Type:** regression
   **Disposition:** extend
   **Harness:** `H4`
   **Preconditions:** The pane picker has an enabled and available `opencode` provider; directory validation returns a resolved path.
   **Actions:** Open the picker, select `opencode`, enter a directory, and confirm it through the existing directory-picker flow.
   **Expected outcome:** The picker pane becomes `kind: 'terminal'` with `mode: 'opencode'` and `initialCwd` equal to the resolved directory, and the provider cwd patch is persisted. Source of truth: `S1`, `S5`.
   **Interactions:** `PanePicker`, `DirectoryPicker`, settings thunk dispatch, pane content creation, provider-extension metadata.

6. **Name:** The captured startup bytes map to the exact cleaned output and truthful replies.
   **Type:** differential
   **Disposition:** new
   **Harness:** `H1`
   **Preconditions:** `test/helpers/opencode-startup-probes.ts` contains the frozen websocket capture and expected outputs.
   **Actions:** Call `extractTerminalStartupProbes()` with `OPEN_CODE_STARTUP_PROBE_FRAME` and the deterministic colors used by the live harness.
   **Expected outcome:** The parser returns `OPEN_CODE_STARTUP_EXPECTED_CLEANED` and `OPEN_CODE_STARTUP_EXPECTED_REPLIES` exactly, with no extra replies for forms not present in the capture. Source of truth: `S2`, `S6`.
   **Interactions:** Pure startup-probe parser only.

7. **Name:** Incomplete unknown escape traffic is preserved, and unrelated OSC/APC traffic passes through untouched.
   **Type:** invariant
   **Disposition:** new
   **Harness:** `H1`
   **Preconditions:** Parser state is fresh; sample inputs include a recognized split fixture, incomplete unknown escape traffic, malformed recognized traffic, and unrelated OSC/APC examples that are outside the frozen capture contract.
   **Actions:** Feed the parser the sample inputs across one or more calls.
   **Expected outcome:** Incomplete recognized traffic stays buffered until completion; incomplete unknown traffic is preserved rather than dropped; unrelated or malformed OSC/APC traffic remains in `cleaned` unchanged and emits no synthetic replies. Source of truth: `S2`, `S4`, `S6`.
   **Interactions:** Pure startup-probe parser buffering and passthrough logic.

8. **Name:** Existing CSI request-mode, OSC52, and turn-complete behavior stays green beside the new startup-probe path.
   **Type:** regression
   **Disposition:** existing
   **Harness:** existing repo suites plus `H2`
   **Preconditions:** The implementation is complete and the existing adjacent suites are available unchanged.
   **Actions:** Run the existing request-mode bypass unit tests, the existing client OSC52 parser tests, the existing client turn-complete parser tests, and the existing `TerminalView` lifecycle checks that preserve OSC title BEL behavior.
   **Expected outcome:** All existing suites continue to pass unchanged, proving the new startup-probe handling did not steal CSI request-mode queries, misclassify OSC sequences, or change turn-complete behavior. Source of truth: `S2`, `S4`.
   **Interactions:** xterm CSI parser registration, client-side escape-sequence preprocessors, `TerminalView` output ordering.

## Coverage Summary
Covered:
- The actual failure surface after directory confirmation: live `terminal.output` handling in `TerminalView`, including reply-before-write ordering and visible-text rendering.
- Replay hydration semantics for historical startup bytes.
- Split-frame buffering across websocket boundaries.
- Coexistence with adjacent preprocessing behavior, especially OSC52.
- The user entry path from picker selection to `opencode` terminal pane creation.
- The exact parser contract driven by the frozen capture fixture.
- Regression protection for existing CSI request-mode, OSC52, and turn-complete behavior.

Explicitly excluded per the agreed strategy:
- Running a real OpenCode binary inside automated CI tests after the fixture is captured.
- Broad server-side spawn or launcher tests, because the investigation and implementation plan both show the bug occurs after PTY launch and after `terminal.output` begins.
- Manual QA or visual inspection beyond automated xterm write assertions.
- Guessing support for any startup probe form not present in the frozen capture.

Risks carried by those exclusions:
- If a future OpenCode release changes its startup probes again, the fixture-driven tests will correctly fail only after the fixture is updated or the new bytes appear in a failing repro; they will not predict unseen upstream probe formats ahead of time.
- Because the automated suite does not launch a live OpenCode process, it proves Freshell’s client contract against the frozen failing bytes rather than proving every future upstream OpenCode version.
- Because the full picker-plus-real-terminal path is split into a picker regression and a terminal-output acceptance suite, a future bug that changes both surfaces at once could require one more integrated scenario; the current split keeps brittleness lower for this narrow fix.
