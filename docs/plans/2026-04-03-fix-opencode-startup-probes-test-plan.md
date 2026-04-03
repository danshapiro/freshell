# Fix OpenCode Startup Probes Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy still holds. The implementation plan changes only the client-side terminal output path after `terminal.output` begins, and the repo already has the two harnesses that matter most for that surface: the `TerminalView` output-preprocessing harness in `test/unit/client/components/TerminalView.osc52.test.tsx` and the attach/replay sequencing harness in `test/e2e/terminal-create-attach-ordering.test.tsx`.

Two small adjustments are needed inside the same cost and scope:

1. Make the exact multi-frame websocket capture the acceptance source of truth. The earlier synthetic `probe + visible output` payload is no longer acceptable as the primary contract because the real failing session emits a standalone probe frame followed by later post-reply frames.
2. Add one explicit replay-to-live boundary regression, because the real implementation can otherwise buffer a replay fragment and answer it incorrectly on the first accepted live frame.
3. Keep directory-picker coverage as a lower-priority boundary regression by extending the existing picker flow to `opencode`, rather than building a more brittle full picker-plus-real-terminal mega-harness.

The plan does not require paid services, browser automation, or a live OpenCode binary in CI. The only external artifact is the frozen startup-probe fixture captured once from the failing websocket output and checked into the repo.

## Sources Of Truth
- `S1 User-visible bug statement`: the transcript establishes that selecting a directory for an `opencode` pane must lead to a visible OpenCode UI instead of a blank hanging pane.
- `S2 Implementation invariants`: [2026-04-02-fix-opencode-startup-probes.md](./2026-04-02-fix-opencode-startup-probes.md) requires recognized startup probes to be stripped from live and replayed output, truthful replies to be emitted only for exact captured forms, replay hydration to stay reply-free, split probes to buffer correctly, and unrelated OSC/APC traffic to pass through unchanged.
- `S3 WebSocket protocol contract`: [shared/ws-protocol.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/shared/ws-protocol.ts) defines the observable `terminal.create`, `terminal.attach`, `terminal.attach.ready`, `terminal.output`, `terminal.output.gap`, and `terminal.input` surfaces.
- `S4 Existing parser contracts`: [terminal-osc52.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/terminal-osc52.ts), [turn-complete-signal.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/lib/turn-complete-signal.ts), and [request-mode-bypass.ts](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/terminal/request-mode-bypass.ts) plus their existing tests define adjacent behavior that must not regress.
- `S5 Picker handoff contract`: [PaneContainer.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/src/components/panes/PaneContainer.tsx) and [directory-picker-flow.test.tsx](/home/user/code/freshell/.worktrees/trycycle-fix-opencode-startup-probes-20260402/test/e2e/directory-picker-flow.test.tsx) define the user entry path from provider selection and directory confirmation to `TerminalPaneContent.initialCwd`.
- `S6 Frozen capture contract`: `test/helpers/opencode-startup-probes.ts` will be the authoritative reference for the exact failing websocket frame sequence, split-frame variant, expected cleaned output, and expected truthful replies. If the fixture cannot justify an assertion, that assertion is out of scope.

## Action Space
- Select `opencode` in the pane picker.
- Confirm a starting directory in the directory picker.
- Convert the picker pane into an `opencode` terminal pane with `initialCwd`.
- Send `terminal.create` for the new pane.
- Receive `terminal.created` and send `terminal.attach`.
- Receive `terminal.attach.ready` and begin replay or live streaming.
- Process a live `terminal.output` frame containing only the recognized startup probe.
- Process later live `terminal.output` frames containing the captured post-reply startup output.
- Process a startup probe split across websocket frames.
- Process replay hydration frames containing historical startup probes.
- Cross the replay-to-live boundary without completing a replay fragment on the first accepted live frame.
- Send synthetic `terminal.input` replies only for live recognized probes.
- Continue processing adjacent OSC52 and turn-complete traffic after startup-probe stripping.
- Preserve existing CSI request-mode reply behavior unchanged.

## Harness Requirements
Harness work happens first because every high-value test depends on it.

| Harness | What it does | What it exposes | Estimated complexity | Tests that depend on it |
| --- | --- | --- | --- | --- |
| `H1 Shared startup-probe fixture` | Stores the exact captured OpenCode startup frame sequence, split-frame variant, expected cleaned text, expected replies, and a short capture-source note in one module. | Typed constants that every new test imports as the single protocol reference. | Low | 1, 2, 3, 4, 5, 7, 8, 9 |
| `H2 TerminalView output-preprocessing harness` | Extends `test/unit/client/components/TerminalView.osc52.test.tsx` with deterministic theme colors, attach-request normalization, mocked websocket send capture, and xterm write capture. | Programmatic injection of `terminal.output` frames plus assertions against `ws.send`, `term.write`, clipboard/modal side effects, and call order. | Medium | 9, 10 |
| `H3 Attach/replay startup scenario harness` | Adds `test/e2e/opencode-startup-probes.test.tsx` using the existing `terminal-create-attach-ordering` pattern for `terminal.created -> terminal.attach -> terminal.attach.ready -> terminal.output`. | End-to-end create/attach/replay sequencing with visible xterm writes and outgoing `terminal.input` reply traffic across probe-only, post-reply, and replay/live-boundary frames. | Medium | 1, 2, 3, 4, 5 |
| `H4 OpenCode picker handoff harness` | Extends `test/e2e/directory-picker-flow.test.tsx` so the real picker path exercises `opencode`, not only `claude`. | User-level provider selection, directory confirmation, resulting pane content, and persisted provider cwd. | Low | 6 |

## Test Plan
1. **Name:** OpenCode startup replies unblock the captured probe-only live frame before any post-reply output is written.
   **Type:** scenario
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** A rendered `opencode` terminal pane has completed `terminal.created` and `terminal.attach.ready`; the shared fixture in `H1` is loaded; deterministic theme colors are in effect for any color-query reply bytes.
   **Actions:** Emit the captured live `OPEN_CODE_STARTUP_PROBE_FRAME` by itself. Assert the intermediate state. Then emit the captured `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` in fixture order.
   **Expected outcome:** The probe-only frame emits one `terminal.input` per `OPEN_CODE_STARTUP_EXPECTED_REPLIES` and produces no xterm write; the later post-reply frames write only `OPEN_CODE_STARTUP_EXPECTED_CLEANED`, never the raw probe bytes; the reply sequence is fully sent before the first cleaned post-reply write; the attach generation remains current. Source of truth: `S1`, `S2`, `S3`, `S6`.
   **Interactions:** `TerminalView` output pipeline, websocket `terminal.input`/`terminal.output`, attach generation scoping, xterm write queue, terminal theme resolution.

2. **Name:** Attach replay strips historical startup frames without sending late replies.
   **Type:** scenario
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** A running `opencode` terminal is attached through a replay window announced by `terminal.attach.ready`; the replay frames include the captured probe-only frame followed by the captured post-reply frames.
   **Actions:** Emit replay `terminal.output` frames for the fixture sequence during hydration, then emit a subsequent live visible-output frame after replay completes.
   **Expected outcome:** Replay writes show only the cleaned historical text with startup probes removed; no `terminal.input` reply traffic is emitted while replay hydration is in progress; once replay completes, later live visible output still renders normally. Source of truth: `S1`, `S2`, `S3`, `S6`.
   **Interactions:** Attach/replay sequence state, websocket replay contract, xterm write queue, stale-generation filtering.

3. **Name:** A replay-fragment startup probe is discarded before the first accepted live frame.
   **Type:** boundary
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** Replay hydration ends after delivering only the first fragment from `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES`; the first accepted live frame begins with the second fragment and continues with post-reply output.
   **Actions:** Emit the replay fragment during hydration, complete replay, then emit the first accepted live frame with the remaining bytes plus startup output.
   **Expected outcome:** No synthetic `terminal.input` reply is emitted for the replay-carried fragment, because replay state must be discarded before live output resumes; the cleaned live output still renders once. Source of truth: `S2`, `S3`, `S6`.
   **Interactions:** Replay-completion reset, startup-probe parser state, websocket reply path, xterm write queue.

4. **Name:** A complete startup probe on the first accepted post-replay live frame still replies normally.
   **Type:** boundary
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** Replay has fully completed and the next accepted live frame begins with a complete `OPEN_CODE_STARTUP_PROBE_FRAME`.
   **Actions:** Emit the first accepted post-replay live frame as `OPEN_CODE_STARTUP_PROBE_FRAME` followed by the captured post-reply output.
   **Expected outcome:** The parser emits the exact expected reply sequence once, then writes the cleaned post-reply output once, proving the replay reset does not suppress legitimate later live probes. Source of truth: `S2`, `S3`, `S6`.
   **Interactions:** Replay-completion reset, live output path, websocket reply ordering, xterm write queue.

5. **Name:** A startup probe split across live websocket frames buffers until complete and replies exactly once.
   **Type:** boundary
   **Disposition:** new
   **Harness:** `H3`
   **Preconditions:** A live `opencode` attach is ready; `OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES` from `H1` represent one recognized probe split across frame boundaries.
   **Actions:** Emit the first split frame alone; assert intermediate state; emit the second split frame with the remaining bytes and startup output.
   **Expected outcome:** After the first frame there is no visible write and no reply traffic because the recognized probe is incomplete; after the second frame, the exact expected reply sequence is sent once and the cleaned startup output is written once, with no duplicate replies on overlap. Source of truth: `S2`, `S3`, `S6`.
   **Interactions:** Startup-probe parser state ref, attach live output path, websocket reply path, xterm write queue.

6. **Name:** Selecting OpenCode in the directory picker still launches a terminal pane with the confirmed cwd.
   **Type:** regression
   **Disposition:** extend
   **Harness:** `H4`
   **Preconditions:** The pane picker has an enabled and available `opencode` provider; directory validation returns a resolved path.
   **Actions:** Open the picker, select `opencode`, enter a directory, and confirm it through the existing directory-picker flow.
   **Expected outcome:** The picker pane becomes `kind: 'terminal'` with `mode: 'opencode'` and `initialCwd` equal to the resolved directory, and the provider cwd patch is persisted. Source of truth: `S1`, `S5`.
   **Interactions:** `PanePicker`, `DirectoryPicker`, settings thunk dispatch, pane content creation, provider-extension metadata.

7. **Name:** The captured startup frame sequence maps to the exact cleaned output and truthful replies.
   **Type:** differential
   **Disposition:** new
   **Harness:** `H1`
   **Preconditions:** `test/helpers/opencode-startup-probes.ts` contains the frozen websocket capture and expected outputs.
   **Actions:** Call `extractTerminalStartupProbes()` with `OPEN_CODE_STARTUP_PROBE_FRAME`, then feed the captured `OPEN_CODE_STARTUP_POST_REPLY_FRAMES` in order using the deterministic colors used by the live harness.
   **Expected outcome:** The probe-only frame yields `OPEN_CODE_STARTUP_EXPECTED_REPLIES` and no cleaned output; the later post-reply frames yield `OPEN_CODE_STARTUP_EXPECTED_CLEANED` with no extra replies for forms not present in the capture. Source of truth: `S2`, `S6`.
   **Interactions:** Pure startup-probe parser only.

8. **Name:** Incomplete unknown escape traffic is preserved, and unrelated OSC/APC traffic passes through untouched.
   **Type:** invariant
   **Disposition:** new
   **Harness:** `H1`
   **Preconditions:** Parser state is fresh; sample inputs include a recognized split fixture, incomplete unknown escape traffic, malformed recognized traffic, and unrelated OSC/APC examples that are outside the frozen capture contract.
   **Actions:** Feed the parser the sample inputs across one or more calls.
   **Expected outcome:** Incomplete recognized traffic stays buffered until completion; incomplete unknown traffic is preserved rather than dropped; unrelated or malformed OSC/APC traffic remains in `cleaned` unchanged and emits no synthetic replies. Source of truth: `S2`, `S4`, `S6`.
   **Interactions:** Pure startup-probe parser buffering and passthrough logic.

9. **Name:** Startup-probe stripping preserves same-path OSC52 clipboard behavior.
   **Type:** integration
   **Disposition:** extend
   **Harness:** `H2`
   **Preconditions:** `TerminalView.osc52` test store is rendered with deterministic theme colors and a known OSC52 policy (`always` or `ask`); the startup sequence uses the captured probe-only frame followed by the captured post-reply output, and the OSC52 clipboard sequence is emitted in a later frame on the same path.
   **Actions:** Emit the startup-probe frame, then emit the captured post-reply frame sequence plus the OSC52 payload using the existing websocket message harness.
   **Expected outcome:** `ws.send` includes the exact startup-probe replies before the first cleaned post-reply write; `term.write` never receives raw startup-probe bytes; OSC52 continues to copy or prompt according to the selected policy exactly as it does today. Source of truth: `S2`, `S4`, `S6`.
   **Interactions:** Startup-probe parser, OSC52 parser, clipboard side effects, theme-derived reply bytes, xterm write scheduling.

10. **Name:** Existing CSI request-mode, OSC52, and turn-complete behavior stays green beside the new startup-probe path.
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
