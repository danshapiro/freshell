# Pane Header Runtime Metadata (cwd/branch-dirty/token %) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** For Codex and Claude terminal panes, render right-aligned runtime metadata in the pane title bar as:

`<subdir> (<branch><*if dirty>)  <percentUsedToCompact>%  [existing header icons]`

Example: `freshell (main*)  25%` then whitespace, then pane action icons.

Also:
- always render a pane title bar even when a tab has only one pane.
- make the active tab background match the pane title bar color; inactive tabs should be white so tabs visually blend into the title bar.
- keep title-bar behavior as close as possible between Codex and Claude panes (same layout, spacing, truncation strategy, fallback rendering, and visibility rules), with differences only where provider telemetry differs.

**Architecture:** Keep terminal runtime metadata server-authoritative (`terminal.meta.*` over WS), store it in a non-persisted Redux slice keyed by `terminalId`, and render a single formatted right-aligned string in an always-visible `PaneHeader`. Metadata is sourced from terminal registry + coding-cli session indexer + provider token parsing. Update tab-strip styling in `TabBar` so active-tab background matches title-bar background and inactive tabs are white.

**Tech Stack:** TypeScript, Node/Express/WebSocket (`ws`), Redux Toolkit, React, Vitest, Testing Library.

---

## External Research Findings (Used to Define 100%)

### Codex
- Codex token-count event schema is nested at `event_msg.payload.info.{total_token_usage,last_token_usage,model_context_window}`.
- Codex compacts when `total_usage_tokens >= auto_compact_limit`.
- `auto_compact_limit` defaults to `90%` of model `context_window` when not explicitly configured.
- Codex also applies `effective_context_window_percent` (default `95`) when reporting usable model context.

**Implementation consequence:**
- Use `total_token_usage.total_tokens` as the active context-usage numerator.
- 100% should map to compact threshold (not full context window).
- Threshold formula:
  - preferred: explicit `model_auto_compact_token_limit` when known
  - fallback: `model_context_window * (90 / 95)` (default-behavior estimate)

### Claude Code
- Claude Code auto-compacts when context exceeds `95%` capacity.
- Claude supports `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to compact earlier (1-100); values above the default threshold do not increase the threshold.
- Claude statusline docs expose context usage semantics and default context-window fallback (`200000` tokens) when model data is unavailable.

**Implementation consequence:**
- 100% maps to Claude’s active compact trigger percent (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` when known, else default `95%`).
- Since Claude stream/session JSON does not provide context-window size directly, use:
  - model-specific context-window map when available
  - fallback `200000`, so compact threshold default is `190000`.

### Scope note
- Token-to-compact percentage is implemented for `codex` and `claude` only in this iteration.
- `opencode/gemini/kimi` continue to receive cwd/branch metadata where available, but no guaranteed `% to compact`.

---

## Scope and constraints

- Single branch / single PR delivery.
- TDD throughout: red -> green -> refactor per task.
- Keep persisted pane layout schema untouched (runtime-only metadata).
- Backward-compatible WS protocol additions only.
- Existing behavior in `App.tsx` message handlers (notably `terminal.exit` idle-warning cleanup) must be preserved.
- Provider parity rule: Codex/Claude pane-header rendering must use one shared formatter/path and identical UI behavior where possible; provider-specific branches are allowed only for token-threshold derivation.

---

### Task 1: Add explicit Git checkout-root + branch/dirty helpers (no ambiguity)

**Files:**
- Modify: `server/coding-cli/utils.ts`
- Modify: `test/unit/server/coding-cli/resolve-git-root.test.ts`
- Create: `test/unit/server/coding-cli/git-metadata.test.ts`

**Step 1: Write failing tests for checkout-root semantics**

Add tests that explicitly distinguish:
- `resolveGitCheckoutRoot()` returns the directory that contains `.git`.
- For worktrees, `resolveGitCheckoutRoot()` returns worktree dir, while `resolveGitRepoRoot()` returns canonical parent repo root.
- Submodule checkout root remains submodule root.

```ts
expect(await resolveGitCheckoutRoot(path.join(worktreeDir, 'src', 'deep'))).toBe(worktreeDir)
expect(await resolveGitRepoRoot(path.join(worktreeDir, 'src', 'deep'))).toBe(parentRepoDir)
```

**Step 2: Write failing tests for branch+dirty resolution**

Add tests for new helper (e.g. `resolveGitBranchAndDirty(cwd)`):
- returns `branch` from git metadata.
- returns `isDirty` true when porcelain status has entries.
- handles non-git directories gracefully.

**Step 3: Implement helpers with explicit behavior**

In `server/coding-cli/utils.ts`:
- add `resolveGitCheckoutRoot(cwd)` with explicit worktree behavior:
  - when `.git` is a file (worktree), return directory containing that `.git` file
  - do **not** resolve through `commondir` for checkout root
- add `resolveGitBranchAndDirty(cwd)` for branch + dirty state.

**Step 4: Run targeted tests**

Run:
- `npm test -- test/unit/server/coding-cli/resolve-git-root.test.ts`
- `npm test -- test/unit/server/coding-cli/git-metadata.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add server/coding-cli/utils.ts test/unit/server/coding-cli/resolve-git-root.test.ts test/unit/server/coding-cli/git-metadata.test.ts
git commit -m "feat(coding-cli): add explicit checkout-root and git branch/dirty metadata helpers"
```

---

### Task 2: Fix provider token parsing with current schemas (Codex + Claude)

**Files:**
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `server/coding-cli/providers/claude.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`
- Modify: `test/unit/server/coding-cli/claude-provider.test.ts`

**Step 1: Add failing Codex tests for nested `token_count.info` format**

Cover:
- parse `event_msg.payload.type = token_count` with nested `payload.info`.
- prefer `info.total_token_usage.total_tokens` for context usage.
- keep compatibility fallback for legacy flat payload shape.
- parse `session_meta.payload.git.branch` when present.

```ts
expect(events[0]).toMatchObject({
  type: 'token.usage',
  tokens: { inputTokens: 120, outputTokens: 30, cachedTokens: 40 },
})
expect(meta.tokenUsage?.contextTokens).toBe(51200)
expect(meta.gitBranch).toBe('main')
```

**Step 2: Add failing Claude tests for usage aggregation from real session structure**

Cover parse-session aggregation from assistant message usage fields:
- `message.usage.input_tokens`
- `message.usage.output_tokens`
- `message.usage.cache_read_input_tokens`
- `message.usage.cache_creation_input_tokens`
- dedupe repeated assistant records by `message.id`.

```ts
expect(meta.tokenUsage).toEqual({
  inputTokens: 20,
  outputTokens: 9,
  cachedTokens: 12,
  totalTokens: 41,
})
```

**Step 3: Extend shared types explicitly (no hidden fields)**

In `server/coding-cli/types.ts`:
- add `TokenSummary`.
- add `tokenUsage?: TokenSummary` to both `ParsedSessionMeta` and `CodingCliSession`.
- keep `TokenPayload` intact for live normalized events; document relationship clearly.

```ts
export interface TokenSummary {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  contextTokens?: number
  modelContextWindow?: number
  compactThresholdTokens?: number
  compactPercent?: number
}
```

**Step 4: Implement provider parsing**

- `codex.ts`:
  - parse nested `payload.info` first.
  - fallback to legacy flat fields if nested missing.
  - compute compact percentage from Codex threshold rules (from research section).
- `claude.ts`:
  - aggregate assistant usage across parse pass.
  - dedupe by assistant `message.id`.
  - compute `compactThresholdTokens` using Claude 95% rule + context-window fallback.

**Step 5: Run focused tests**

Run:
- `npm test -- test/unit/server/coding-cli/codex-provider.test.ts`
- `npm test -- test/unit/server/coding-cli/claude-provider.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add server/coding-cli/types.ts server/coding-cli/providers/codex.ts server/coding-cli/providers/claude.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/claude-provider.test.ts
git commit -m "fix(coding-cli): parse current codex token_count schema and aggregate claude usage for compact-percent"
```

---

### Task 3: Propagate token + git metadata through session indexing

**Files:**
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`

**Step 1: Add failing indexer tests**

Verify indexed sessions include:
- `tokenUsage`
- `gitBranch`
- `isDirty` (when metadata present)

```ts
expect(projects[0].sessions[0].tokenUsage?.compactPercent).toBe(25)
expect(projects[0].sessions[0].gitBranch).toBe('main')
```

**Step 2: Implement propagation**

When constructing `baseSession`, propagate metadata from `ParsedSessionMeta` to `CodingCliSession` explicitly.

**Step 3: Run focused tests**

Run: `npm test -- test/unit/server/coding-cli/session-indexer.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add server/coding-cli/session-indexer.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "feat(indexer): propagate token and git metadata into coding-cli session records"
```

---

### Task 4: Add terminal metadata service with explicit data sources

**Files:**
- Create: `server/terminal-metadata-service.ts`
- Create: `test/unit/server/terminal-metadata-service.test.ts`

**Step 1: Define concrete model and method contracts**

```ts
type TerminalMeta = {
  terminalId: string
  cwd?: string
  checkoutRoot?: string
  repoRoot?: string
  displaySubdir?: string
  branch?: string
  isDirty?: boolean
  provider?: 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'
  sessionId?: string
  tokenUsage?: TokenSummary
  compactPercent?: number
  updatedAt: number
}
```

Methods:
- `seedFromTerminal(record: ReturnType<TerminalRegistry['list']>[number])`
- `associateSession(terminalId, provider, sessionId)`
- `applySessionMetadata(terminalId, session)`
- `list()`
- `remove(terminalId)`

**Step 2: Add failing tests for service behavior**

Cover:
- seeds metadata from terminal list/create records.
- enriches checkout/repo/branch/dirty.
- merges token usage with `updatedAt` set by service.
- idempotent updates do not emit duplicate change payloads.

**Step 3: Implement service**

Make update paths deterministic and cheap, with equality checks for no-op updates.

**Step 4: Run tests**

Run: `npm test -- test/unit/server/terminal-metadata-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-metadata-service.ts test/unit/server/terminal-metadata-service.test.ts
git commit -m "feat(server): add terminal metadata service with explicit cwd/branch/token state"
```

---

### Task 5: Add WS protocol for terminal metadata (`terminal.meta.*`)

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `test/server/ws-protocol.test.ts`

**Step 1: Add failing WS tests**

Test:
- request `terminal.meta.list` receives `terminal.meta.list.response`.
- server can broadcast `terminal.meta.updated`.

**Step 2: Implement WS schema + handlers**

In `server/ws-handler.ts`:
- add client message: `terminal.meta.list`.
- add response: `terminal.meta.list.response`.
- add broadcast event type: `terminal.meta.updated`.

**Step 3: Run tests**

Run: `npm test -- test/server/ws-protocol.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add server/ws-handler.ts test/server/ws-protocol.test.ts
git commit -m "feat(ws): add terminal metadata list/update protocol"
```

---

### Task 6: Wire metadata service in server lifecycle + session association flows

**Files:**
- Modify: `server/index.ts`
- Modify: `test/server/session-association.test.ts`

**Step 1: Add failing association-flow tests**

For both Claude and Codex association paths, assert both broadcasts:
- existing `terminal.session.associated`
- new `terminal.meta.updated` with provider/session + branch/token fields when present.

**Step 2: Implement server wiring with explicit source points**

In `server/index.ts`:
- instantiate metadata service.
- seed from `registry.list()` for snapshot serving.
- seed/update on terminal create and title-association loops.
- on coding-cli index updates, map sessions to associated terminals and call `applySessionMetadata(...)`.
- broadcast `terminal.meta.updated` only when metadata changed.
- on terminal exit/remove, remove metadata and broadcast removal patch.

**Step 3: Run tests**

Run: `npm test -- test/server/session-association.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add server/index.ts test/server/session-association.test.ts
git commit -m "feat(server): publish terminal metadata updates from association and indexer flows"
```

---

### Task 7: Add runtime client metadata slice and WS ingestion

**Files:**
- Create: `src/store/terminalMetaSlice.ts`
- Modify: `src/store/store.ts`
- Modify: `src/App.tsx`
- Create: `test/unit/client/store/terminalMetaSlice.test.ts`

**Step 1: Add failing slice tests**

Cover:
- snapshot replace from `terminal.meta.list.response`.
- upsert patch from `terminal.meta.updated`.
- remove on terminal exit.

**Step 2: Implement slice + store registration**

State:

```ts
type TerminalMetaState = {
  byTerminalId: Record<string, TerminalMetaRecord>
}
```

Reducers:
- `setTerminalMetaSnapshot`
- `upsertTerminalMeta`
- `removeTerminalMeta`

No persistence changes.

**Step 3: Wire App WS handlers (additive, non-destructive)**

In `src/App.tsx`:
- on `ready`, call existing `ws.send(...)` helper with `terminal.meta.list` request.
- handle `terminal.meta.list.response` and `terminal.meta.updated`.
- on `terminal.exit`, keep existing `clearIdleWarning` dispatch and add `removeTerminalMeta` dispatch (do not replace current logic).

**Step 4: Run tests**

Run:
- `npm test -- test/unit/client/store/terminalMetaSlice.test.ts`
- `npm test -- test/e2e/turn-complete-notification-flow.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/terminalMetaSlice.ts src/store/store.ts src/App.tsx test/unit/client/store/terminalMetaSlice.test.ts
git commit -m "feat(client): ingest terminal metadata snapshot and live updates"
```

---

### Task 8: Render always-visible pane title bar with right-aligned metadata + existing icons

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Modify: `src/components/panes/PaneHeader.tsx`
- Create: `src/lib/format-terminal-title-meta.ts`
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`
- Modify: `test/unit/client/components/panes/Pane.test.tsx`

**Step 1: Add failing component tests**

`PaneHeader.test.tsx` should assert:
- right-aligned metadata text for coding-cli panes, e.g. `freshell (main*)  25%`.
- percentage omitted when compact threshold unknown.
- metadata hidden for non-coding-cli modes.
- icon buttons still render after metadata text.
- title bar renders even when a tab has a single pane (no split).
- Codex and Claude with equivalent metadata inputs render equivalent title text/spacing output.

`Pane.test.tsx` should assert metadata prop/select path is wired.

**Step 2: Implement formatting helper**

In `src/lib/format-terminal-title-meta.ts`:
- `formatPaneRuntimeLabel(meta): string | undefined`
- derive `subdir` from checkout root basename fallback to cwd basename.
- format branch+dirty as `(<branch>*)` when dirty.
- format percent as integer `%`.

**Step 3: Implement layout and alignment**

In `PaneHeader`:
- keep existing left icon + title behavior.
- add a right-side metadata text element before action icons.
- preserve whitespace between metadata and icons.

In pane rendering path (`Pane` / `PaneContainer`):
- remove conditional suppression of title bar for single-pane tabs.
- ensure title bar is always present for pane content types that currently use `PaneHeader`.

```tsx
<div className="ml-auto flex items-center gap-2">
  {metaLabel && <span className="text-xs text-muted-foreground text-right">{metaLabel}</span>}
  {/* existing zoom/close icons */}
</div>
```

**Step 4: Decide selector location explicitly**

Use `PaneContainer` selector + prop pass to keep `PaneHeader` largely presentational (one extra prop hop is acceptable and explicit).

**Step 5: Run tests**

Run:
- `npm test -- test/unit/client/components/panes/PaneHeader.test.tsx`
- `npm test -- test/unit/client/components/panes/Pane.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/panes/Pane.tsx src/components/panes/PaneHeader.tsx src/lib/format-terminal-title-meta.ts test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/Pane.test.tsx
git commit -m "feat(ui): render always-visible pane header metadata with right-aligned compact-percent label"
```

---

### Task 9: Blend tab strip into title bar (active matches title color, inactive white)

**Files:**
- Modify: `src/components/TabBar.tsx`
- Modify: `test/unit/client/components/TabBar.test.tsx`

**Step 1: Add failing tab-style tests**

In `TabBar.test.tsx`, assert:
- active tab has the same background token/class as pane title bar.
- inactive tabs use white background.
- existing active-state semantics (selected tab, focus, close button behavior) remain unchanged.

**Step 2: Implement tab background styling**

In `src/components/TabBar.tsx`:
- update class logic so active tab uses the same surface/background style token as `PaneHeader`.
- set inactive tabs to white background.
- keep hover/focus/contrast behavior accessible.

**Step 3: Run tests**

Run:
- `npm test -- test/unit/client/components/TabBar.test.tsx`
- `npm test -- test/unit/client/components/TabBar.a11y.test.tsx`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/TabBar.test.tsx
git commit -m "feat(ui): align active tab background with pane title bar and set inactive tabs white"
```

---

### Task 10: End-to-end metadata-to-header flow + full regression

**Files:**
- Create: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Write failing e2e test**

Flow:
- render Codex and Claude panes.
- emit metadata snapshot + update messages.
- assert right-aligned text updates correctly.
- emit `terminal.exit` and assert metadata is removed.
- assert pane title bar is present in single-pane layout.
- assert parity for equivalent Codex/Claude metadata (same text shape and fallback behavior).

**Step 2: Run e2e + full regression**

Run:
- `npm test -- test/e2e/pane-header-runtime-meta-flow.test.tsx`
- `npm run lint`
- `npm test`

Expected: all PASS.

**Step 3: Commit**

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test(e2e): verify terminal metadata websocket flow to right-aligned pane header text"
```

---

## Final verification checklist

1. `resolveGitCheckoutRoot()` explicitly returns worktree checkout root (not canonical parent repo root).
2. Codex parser handles nested `token_count.info.*` schema and computes compact percent from compact-threshold semantics.
3. Claude parser aggregates assistant usage with message-id dedupe and computes compact percent with 95% rule.
4. `ParsedSessionMeta` and `CodingCliSession` both carry `tokenUsage` (and related git metadata) explicitly.
5. `terminal.meta.list` and `terminal.meta.updated` WS messages work end-to-end.
6. `terminal.exit` handling in `App.tsx` preserves existing idle-warning cleanup and removes terminal metadata.
7. Pane title bar is always visible, including when a tab has only one pane.
8. Pane header shows right-aligned metadata text in format `<subdir> (<branch><*>)  <percent>%` before icons.
9. Non-coding-cli panes do not show this metadata string.
10. Active tab background matches pane title-bar background; inactive tabs are white.
11. Codex and Claude pane title bars have parity in rendering behavior except for provider-specific threshold math.
12. `npm run lint` and `npm test` are green.

---

## Rollout notes

- Metadata rendering is intentionally runtime-only and non-persisted.
- When branch/dirty cannot be resolved, render available components (e.g., subdir only).
- If compact-threshold denominator is unknown, omit `%` rather than showing misleading values.
- Provider-specific compact-percent rules currently implemented for Codex and Claude only; other providers remain extensible.
