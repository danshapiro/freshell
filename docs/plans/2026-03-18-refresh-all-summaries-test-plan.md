# Refresh All Summaries - Test Plan

## Strategy Reconciliation

The implementation plan aligns well with the agreed testing strategy. Key observations:

- **Interfaces match expectations.** The plan introduces `extractUserMessages(jsonlContent, provider)` as a pure function taking string content, not a file path. This is even more testable than the strategy assumed -- no filesystem access needed for the core logic.
- **No separate batch endpoint.** The plan reuses the existing per-terminal `POST /api/ai/terminals/:terminalId/summary` endpoint rather than creating a batch endpoint. The client calls it N times in parallel via `Promise.allSettled`. This simplifies server integration tests -- we test the enhanced single endpoint, not a new batch route.
- **The `readSessionContent` dependency injection.** The AI router gains an optional `readSessionContent` function in its deps, which keeps the server integration tests mockable without touching the filesystem or the coding-CLI indexer directly.
- **Change detection is client-side.** The `lastActivityAt` vs `summaryActivityMap` comparison lives entirely in `OverviewView`. This is testable through the component test harness with mocked API responses.
- **No new external dependencies.** The same Gemini API key check and heuristic fallback apply. No strategy changes are needed.

The strategy holds without material changes.

## Sources of Truth

- **User request transcript:** The user specified the prompt text ("This is a coding agent session with only the user messages; the assistant replies are removed"), the input format ("Fix bug 123.\n...\nNow fix bug 456."), the 250-character limit, and the recency bias.
- **Existing provider parsers:** `server/coding-cli/providers/claude.ts` (lines 310-317) and `server/coding-cli/providers/codex.ts` (line 319) define the canonical JSONL record shapes for user messages.
- **Existing AI router:** `server/ai-router.ts` defines the current heuristic fallback and endpoint shape.
- **Existing OverviewView:** `src/components/OverviewView.tsx` defines the current per-terminal generate-summary flow.
- **Server types:** `server/terminal-view/types.ts` defines `TerminalDirectoryItem` including `mode` and `resumeSessionId` -- these fields already exist on the server response.
- **Implementation plan:** `docs/plans/2026-03-18-refresh-all-summaries.md` specifies the `AiRouterDeps` interface extension, prompt template, and client-side change detection logic.

## Test Plan

### 1. AI router uses coding-CLI path for non-shell terminal with discoverable session

- **Name:** Summary endpoint returns result from user-message extraction path when terminal has a coding CLI mode and a discoverable session file
- **Type:** integration
- **Disposition:** extend
- **Harness:** `test/server/ai-api.test.ts` -- supertest against Express app with mocked `registry` and new `readSessionContent` dep
- **Preconditions:** AI key is not configured (heuristic fallback). Mock registry returns a terminal with `mode: 'claude'`, `resumeSessionId: 'session-abc'`, and a buffer with scrollback. Mock `readSessionContent` returns JSONL with two user messages and one assistant message.
- **Actions:** `POST /api/ai/terminals/term-cli/summary`
- **Expected outcome:** Response status 200. `source` is `'heuristic'`. `description` is truthy and non-empty. The heuristic fallback runs because AI is not configured, but the important assertion is that the route handler tried the coding-CLI path first. (With AI configured, it would send the user-message-extracted text to the coding-CLI prompt; without AI, it falls back to heuristic on the extracted text.)
- **Interactions:** `extractUserMessages` utility, `readSessionContent` mock, `PROMPTS.codingCliSummary`, heuristic fallback.
- **Source of truth:** Implementation plan D2 (input strategy selection), D5 (session file resolution).

### 2. AI router falls back to scrollback for shell-mode terminals

- **Name:** Summary endpoint uses scrollback-based summary for shell terminals regardless of any session data
- **Type:** integration
- **Disposition:** extend
- **Harness:** `test/server/ai-api.test.ts`
- **Preconditions:** AI key not configured. Mock registry returns `mode: 'shell'`, buffer with `'npm install\nDone in 2.3s'`.
- **Actions:** `POST /api/ai/terminals/term-shell/summary`
- **Expected outcome:** Response status 200. `source` is `'heuristic'`. `description` contains `'npm install'`. The `readSessionContent` mock is never called -- shell terminals always use scrollback.
- **Interactions:** Existing scrollback path, `PROMPTS.terminalSummary`.
- **Source of truth:** Implementation plan D2 (shell mode bypasses user-message extraction).

### 3. AI router falls back to scrollback when session file is not found for a coding CLI terminal

- **Name:** Summary endpoint falls back to scrollback when readSessionContent returns null
- **Type:** boundary
- **Disposition:** extend
- **Harness:** `test/server/ai-api.test.ts`
- **Preconditions:** AI key not configured. Mock registry returns `mode: 'claude'`, `resumeSessionId: 'session-xyz'`, buffer with `'claude running\nAssistant output'`. `readSessionContent` returns `null`.
- **Actions:** `POST /api/ai/terminals/term-no-session/summary`
- **Expected outcome:** Response status 200. `description` contains `'claude running'`. Falls back cleanly to scrollback-based heuristic rather than erroring.
- **Interactions:** `readSessionContent` null path, scrollback fallback.
- **Source of truth:** Implementation plan D5 ("For terminals that don't have a `resumeSessionId` yet... we fall back to the scrollback-based summary").

### 4. Coding-CLI summary prompt includes correct framing and user messages

- **Name:** `PROMPTS.codingCliSummary.build()` produces prompt containing the user-specified framing text and the passed user messages
- **Type:** unit
- **Disposition:** new
- **Harness:** `test/server/ai-api.test.ts` -- direct import of `PROMPTS` from `server/ai-prompts.ts`
- **Preconditions:** None (pure function).
- **Actions:** Call `PROMPTS.codingCliSummary.build('Fix bug 123.\n...\nNow fix bug 456.')`.
- **Expected outcome:** Result contains `'coding agent session'`, `'user messages'`, `'assistant replies are removed'`, `'250 characters'`, `'bias towards recency'`, and the input string verbatim.
- **Interactions:** None.
- **Source of truth:** User request specifying the prompt text. Implementation plan D4 specifying the prompt template.

### 5. Extract user messages from Claude JSONL with placeholder separators

- **Name:** `extractUserMessages()` extracts only user message text from Claude JSONL, joining with `...` placeholders and omitting assistant content
- **Type:** unit
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts` -- direct import of `extractUserMessages`
- **Preconditions:** None (pure function).
- **Actions:** Pass JSONL string with `{ type: 'user', message: { role: 'user', content: 'Fix bug 123.' } }`, an assistant record, and `{ type: 'user', message: { role: 'user', content: 'Now fix bug 456.' } }`. Provider is `'claude'`.
- **Expected outcome:** Result contains `'Fix bug 123.'` and `'Now fix bug 456.'` separated by `'...'`. Does not contain assistant text `'I will fix that.'` or `'Done.'`.
- **Interactions:** None.
- **Source of truth:** User request specifying the output format. `server/coding-cli/providers/claude.ts` lines 310-317 for the canonical Claude JSONL shape.

### 6. Extract user messages from Codex JSONL

- **Name:** `extractUserMessages()` correctly parses Codex `response_item` format user messages
- **Type:** unit
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with Codex format records (`{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] } }`). Provider is `'codex'`.
- **Expected outcome:** Result contains the user message texts, joined with `'...'` placeholders. Does not contain assistant text.
- **Interactions:** None.
- **Source of truth:** `server/coding-cli/providers/codex.ts` line 319 for the canonical Codex JSONL shape.

### 7. Extract user messages returns empty string for no user messages

- **Name:** `extractUserMessages()` returns empty string when JSONL contains no user messages
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with only system init and assistant records. Provider is `'claude'`.
- **Expected outcome:** Returns `''`.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 1 tests.

### 8. Extract user messages returns empty string for empty input

- **Name:** `extractUserMessages()` returns empty string for empty content
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Call `extractUserMessages('', 'claude')`.
- **Expected outcome:** Returns `''`.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 1 tests.

### 9. Extract user messages truncates from front to keep last 20000 chars (recency bias)

- **Name:** `extractUserMessages()` truncates from the front when combined user messages exceed 20000 characters, preserving the most recent content
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with two user messages totaling more than 20000 chars (e.g., 15000 + 10000). Provider is `'claude'`.
- **Expected outcome:** Result length is at most 20000. The recent (second) message is fully preserved. The old (first) message is truncated from the front.
- **Interactions:** None.
- **Source of truth:** User request ("the last 20000 characters of ONLY THE USER RESPONSES"). Implementation plan D1.

### 10. Extract user messages strips ANSI escape codes

- **Name:** `extractUserMessages()` strips ANSI codes from extracted user message text
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with a user message containing ANSI codes (`\x1b[32mFix the\x1b[0m bug.`).
- **Expected outcome:** Result does not contain `\x1b[`. Contains `'Fix the bug.'`.
- **Interactions:** `stripAnsi` from `ai-prompts.ts`.
- **Source of truth:** Existing `stripAnsi` behavior. Implementation plan Task 1.

### 11. Extract user messages handles malformed JSON lines gracefully

- **Name:** `extractUserMessages()` skips malformed JSON lines without crashing and still extracts valid user messages
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with `'not valid json'`, a valid user message record, and `'{ broken'`.
- **Expected outcome:** Result contains the valid user message text. No error thrown.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 1 (graceful handling).

### 12. Extract user messages handles array content blocks (Claude multi-part format)

- **Name:** `extractUserMessages()` concatenates text from multiple content blocks in a single Claude user message
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with a user message containing `content: [{ type: 'text', text: 'First part.' }, { type: 'text', text: 'Second part.' }]`.
- **Expected outcome:** Result contains both `'First part.'` and `'Second part.'`.
- **Interactions:** None.
- **Source of truth:** `server/coding-cli/providers/claude.ts` `extractUserContentText` shows content can be an array of blocks.

### 13. Extract user messages handles top-level role user format

- **Name:** `extractUserMessages()` recognizes `{ role: 'user', content: '...' }` records without a wrapping `message` field
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/server/ai-user-message-extractor.test.ts`
- **Preconditions:** None.
- **Actions:** Pass JSONL with `{ role: 'user', content: 'Direct user content.' }`.
- **Expected outcome:** Result contains `'Direct user content.'`.
- **Interactions:** None.
- **Source of truth:** `server/coding-cli/providers/claude.ts` line 311 (`if (obj?.role === 'user')`).

### 14. "Refresh all summaries" button renders and is accessible

- **Name:** OverviewView renders a "Refresh all summaries" button that is keyboard-accessible and has a proper aria-label
- **Type:** scenario
- **Disposition:** new
- **Harness:** `test/unit/client/components/OverviewView.test.tsx` -- React Testing Library with mocked API and WS client
- **Preconditions:** API returns a list of terminals. Component is mounted with a Redux store.
- **Actions:** Render `OverviewView`, wait for terminal data to load.
- **Expected outcome:** `screen.getByLabelText('Refresh all summaries')` is in the document, is a `<button>` element, and is not disabled.
- **Interactions:** API mock for `/api/terminals`, WS client mock.
- **Source of truth:** Implementation plan Task 4 step 3.4. Accessibility requirements in AGENTS.md.

### 15. "Refresh all summaries" dispatches parallel summary requests for all terminals on first click

- **Name:** Clicking "Refresh all summaries" calls the summary endpoint for every terminal when no prior summaries have been generated
- **Type:** scenario
- **Disposition:** new
- **Harness:** `test/unit/client/components/OverviewView.test.tsx`
- **Preconditions:** API returns 2 terminals (one shell, one claude). No prior summary activity map in localStorage. `api.post` mock returns `{ description: 'AI summary', source: 'heuristic' }`. `api.patch` mock returns `{}`.
- **Actions:** Render, wait for load, click "Refresh all summaries".
- **Expected outcome:** `api.post` is called twice with URLs matching `/api/ai/terminals/.*/summary`. Both terminals get summary calls because neither has a prior generation record.
- **Interactions:** `api.post` (summary generation), `api.patch` (description override persistence).
- **Source of truth:** User request ("dispatches all of them to be refreshed in parallel").

### 16. "Refresh all summaries" skips terminals unchanged since last refresh

- **Name:** Second "Refresh all summaries" click skips terminals whose `lastActivityAt` has not changed since the first refresh
- **Type:** scenario
- **Disposition:** new
- **Harness:** `test/unit/client/components/OverviewView.test.tsx`
- **Preconditions:** API returns 2 terminals. First "Refresh all" completes successfully for both.
- **Actions:** Clear mocks. Mock API to return the same 2 terminals with identical `lastActivityAt` values. Click "Refresh all summaries" again.
- **Expected outcome:** `api.post` is called zero times for summary endpoints. Both terminals are skipped because `lastActivityAt` has not changed.
- **Interactions:** localStorage persistence of the `summaryActivityMap`, `api.get` for terminal list refresh.
- **Source of truth:** User request ("IF they've changed since the last refresh"). Implementation plan D3.

### 17. "Refresh all summaries" handles partial failures gracefully

- **Name:** When one terminal's summary fails and another succeeds, the successful one is persisted and the failed one does not crash the batch
- **Type:** boundary
- **Disposition:** new
- **Harness:** `test/unit/client/components/OverviewView.test.tsx`
- **Preconditions:** API returns 2 terminals. `api.post` succeeds for the first and rejects for the second.
- **Actions:** Render, wait, click "Refresh all summaries", wait for completion.
- **Expected outcome:** `api.patch` is called exactly once (for the successful terminal). The component does not throw or show a crash state. The failed terminal remains eligible for retry on the next "Refresh all" click (its `lastActivityAt` is not recorded in the activity map).
- **Interactions:** `Promise.allSettled` handling, `summaryActivityMap` selective update.
- **Source of truth:** Implementation plan Task 4 step 3 (uses `Promise.allSettled`). Testing strategy agreement ("partial failures handled gracefully").

### 18. Existing per-terminal "Generate summary" still works and records in activity map

- **Name:** The existing per-terminal Sparkles button summary generation continues to work and also records the terminal in the summary activity map so "Refresh all" skips it
- **Type:** regression
- **Disposition:** extend
- **Harness:** `test/unit/client/components/OverviewView.test.tsx`
- **Preconditions:** API returns 1 terminal. `api.post` and `api.patch` succeed.
- **Actions:** Render, wait for load, trigger per-terminal summary generation (click the per-terminal Sparkles button on the terminal card), wait for completion, then click "Refresh all summaries".
- **Expected outcome:** After the per-terminal generation, "Refresh all" produces zero additional summary calls because the terminal's `lastActivityAt` was already recorded.
- **Interactions:** `TerminalCard.onGenerateSummary`, `summaryActivityMap`, `localStorage`.
- **Source of truth:** Implementation plan Task 4 step 5.

### 19. Existing tests continue to pass with the enhanced AiRouterDeps

- **Name:** The three existing AI API tests (404 for unknown terminal, heuristic fallback, empty buffer, ANSI stripping) pass without modification after the deps interface is extended
- **Type:** regression
- **Disposition:** existing
- **Harness:** `test/server/ai-api.test.ts`
- **Preconditions:** Existing test file with existing `beforeEach` that does not provide `readSessionContent` in deps.
- **Actions:** Run the existing four tests unmodified.
- **Expected outcome:** All four pass. The `readSessionContent` is optional in the interface, so existing callers without it still work. The code path for terminals without `mode` or with undefined `readSessionContent` falls back to existing scrollback behavior.
- **Interactions:** Backward compatibility of `AiRouterDeps`.
- **Source of truth:** `test/server/ai-api.test.ts` existing assertions.

## Coverage Summary

**Covered:**
- Server-side coding-CLI-aware summary path (tests 1-3): route handler selects user-message extraction for coding CLI terminals, scrollback for shells, and falls back gracefully when session content is unavailable.
- Prompt construction (test 4): the new `codingCliSummary` prompt template matches the user-specified framing.
- Pure extraction logic (tests 5-13): Claude and Codex JSONL parsing, placeholder insertion, empty input, no-user-messages edge case, truncation/recency bias, ANSI stripping, malformed JSON resilience, array content blocks, and alternative record formats.
- Client-side "Refresh all" behavior (tests 14-17): button rendering and accessibility, parallel dispatch, change detection skipping unchanged terminals, and partial failure handling.
- Regression protection (tests 18-19): per-terminal summary still works and records in activity map; existing AI API tests pass with extended deps.

**Explicitly excluded per agreed strategy:**
- Actual Gemini API output quality -- tests verify correct prompt construction and input selection, not LLM response quality.
- E2e browser tests for the "Refresh all" button -- the component test provides sufficient coverage for the UI behavior through Testing Library. The button is a simple action trigger; the interesting logic is in the filtering and parallel dispatch, which the component tests exercise.
- Visual appearance testing -- the Sparkles icon and animation are not structurally testable in jsdom; they are covered by the a11y lint requirement (aria-label on the button).

**Residual risks:**
- If the `codingCliIndexer.getFilePathForSession()` mapping is stale or wrong at runtime, the `readSessionContent` function returns null and the system falls back to scrollback. This is the correct degradation path but means a coding CLI terminal might get a lower-quality summary until the indexer catches up. This is acceptable per the implementation plan.
- The `summaryActivityMap` in localStorage could grow stale if terminals are deleted externally. The implementation plan includes a pruning step (Task 4 step 6) that removes entries for terminals no longer in the list.
