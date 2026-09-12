# Task 3 independent review

Reviewed `a97dc0a3d` and `daf5f51ac` against `2c95c2bac`, including the Task 3 plan and unchanged user-request block. The referenced `usual-sdd/task-003-brief.md` was not present in the worktree, so it could not be reviewed.

## Requirements-compliance verdict: FAIL

The implementation removes the named Node-only callers and the exact local receipt is real, but the required Rust E2E proof is materially incomplete.

1. **Major** — [test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts:29](../test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts#L29)
   - **Evidence:** The test title promises both supported localhost HTTP proxying and the remote HTTPS-loopback unavailable state, but it only enters `http://localhost:4321/health` and checks its iframe source (lines 32–36). It never navigates to an HTTPS loopback URL from a remote browser or asserts the required baseline message.
   - **Impact:** The mandated remote-loopback behavior can regress while the Rust-only browser spec remains green.
   - **Remediation:** In this scenario, set a non-loopback page host, navigate to `https://localhost:<port>`, assert the exact unavailable message, absence of an iframe/forward call, and retain the supported HTTP proxy assertion.

2. **Major** — [test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts:39](../test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts#L39)
   - **Evidence:** This test opens a context menu on `.xterm` (line 42), then asserts that editor-only items are absent (line 43). It never creates an editor pane, opens its context menu, or verifies the retained save behavior.
   - **Impact:** It cannot detect external-open/reveal entries returning to the editor menu or a regression in supported editor save.
   - **Remediation:** Create an editor pane for a real file, open the editor context menu, assert the two entries are absent and save remains available, and inspect the captured requests.

3. **Major** — [test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts:47](../test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts#L47)
   - **Evidence:** The extension scenario only waits for the bootstrap terminal and asserts an empty captured-request array (lines 48–50); it creates neither a client nor a server extension pane and never checks the accessible unsupported panel.
   - **Impact:** Neither required extension category nor its request-free lifecycle/asset behavior is exercised.
   - **Remediation:** Seed/create one pane for each category, assert the labelled status panel and exact message, and fail after interaction if lifecycle or asset routes are requested.

4. **Major** — [test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts:53](../test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts#L53)
   - **Evidence:** The markdown-editor scenario performs no editor, file, save, disk, or preview operation; it only asserts an empty request array (lines 54–56).
   - **Impact:** There is no Rust E2E proof of the required read/edit/save/disk-verify/preview round trip.
   - **Remediation:** Create a markdown fixture inside the owned server home, edit and save it through the UI, verify the file contents on disk, then switch to preview and assert the rendered result.

5. **Major** — [test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts:59](../test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts#L59)
   - **Evidence:** The fresh-agent scenario likewise only waits for the terminal and checks an empty captured-request array (lines 60–62); it never creates a fake-provider fresh-agent pane, types `!command`, inspects attachment controls, or supplies a diff summary.
   - **Impact:** The attachment, shell-command, and non-expandable-diff requirements have no Rust E2E coverage.
   - **Remediation:** Use the existing fake-provider harness to create a fresh-agent pane with a diff summary; assert the attachment control is absent, submit `!command` and assert the exact notice/no send, and assert the diff has no expansion control or forbidden request.

6. **Major** — [test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx:4](../test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx#L4)
   - **Evidence:** This still imports and executes `attachmentRejection`, which Task 3 removed from `FreshAgentComposer`. Running `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx --config config/vitest/vitest.config.ts` produced 3 failures: `attachmentRejection is not a function` at lines 83, 90, and 95.
   - **Impact:** A relevant checked-in client unit test file is red after the attachment feature removal.
   - **Remediation:** Delete the obsolete attachment-rejection test block and import (or replace it with assertions for the intentionally absent attachment UI if that behavior needs coverage).

## Code-quality verdict: FAIL

1. **Major** — [test/unit/client/components/panes/BrowserPane.test.tsx:408](../test/unit/client/components/panes/BrowserPane.test.tsx#L408)
   - **Evidence:** The combined diff changes the remote-access suite to `describe.skip`; that block contains still-supported HTTP localhost-proxy cases (for example lines 409–457). The same commit also skips the refresh-request and runtime-activity suites at lines 234 and 326. The implementation report consequently records 18 skipped legacy-forwarding tests rather than replacing/removing only retired behavior.
   - **Impact:** Supported BrowserPane behavior and unrelated refresh/activity behavior lose executable regression coverage, contrary to the plan's requirement to preserve the localhost proxy helper and appropriate coverage.
   - **Remediation:** Remove tests exclusively for the retired TCP-forward path, restore the supported HTTP-proxy and unrelated suites, and rewrite assertions that changed to the unavailable-state behavior.

## Verification receipt

- The exact local command from the Task 3 E2E-fix report was run:
  `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/rust-baseline-browser-actions.spec.ts test/e2e-browser/specs/browser-pane.spec.ts`.
  It completed with 10/10 passing tests (`test-results/.last-run.json` reports `status: passed`).
- The fixture-bootstrap change is present: every scenario consumes `freshellPage`, whose fixture navigates to the worker-owned Rust server, waits for harness/WebSocket readiness, and creates the initial shell.
- This receipt proves the selected tests boot and execute on the Rust fixture; findings 1–5 show that five named scenarios do not perform the required product actions.
