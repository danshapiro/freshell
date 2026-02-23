# Bug Bash Issues 4, 5, 6 Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three operator-facing tmux-ergonomics bugs together: control-key translation in `send-keys`, single-axis `resize-pane` semantics, and screenshot API availability/timeouts when no capture-capable UI is present.

**Architecture:** Keep behavior changes at protocol/command boundaries so existing UI state shape remains stable. Add explicit WebSocket screenshot capability negotiation and route-level error mapping so screenshot failures are immediate and actionable instead of timing out. For resize semantics, preserve unspecified split axis from current layout state (or derive safe default) so single-axis updates do what operators expect.

**Tech Stack:** TypeScript, Node/Express, WebSocket (`ws`), React WS client handshake, Vitest + supertest + e2e CLI tests.

---

## File Structure Map

- Modify: `server/cli/keys.ts`
- Modify: `server/agent-api/router.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `server/ws-handler.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `test/unit/cli/keys.test.ts`
- Modify: `test/server/agent-screenshot-api.test.ts`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Create: `test/server/agent-resize-pane.test.ts`
- Modify: `test/e2e/agent-cli-flow.test.ts`

## Chunk 1: Issue #4 `send-keys` control-key ergonomics

### Task 1: Add failing control-key translation coverage

**Files:**
- Modify: `test/unit/cli/keys.test.ts`

- [ ] **Step 1: Write failing tests for common control keys**

```ts
it('translates C-u to line-kill control byte', () => {
  expect(translateKeys(['C-u'])).toBe('\x15')
})

it('translates generic C-<letter> chords case-insensitively', () => {
  expect(translateKeys(['c-w', 'C-a', 'C-e'])).toBe('\x17\x01\x05')
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/cli/keys.test.ts`
Expected: FAIL on missing `C-u`/generic ctrl mappings.

- [ ] **Step 3: Implement minimal translation logic**

**Files:**
- Modify: `server/cli/keys.ts`

```ts
function translateCtrlChord(token: string): string | undefined {
  const m = /^C-([A-Za-z])$/.exec(token)
  if (!m) return undefined
  return String.fromCharCode(m[1].toUpperCase().charCodeAt(0) - 64)
}

export function translateKeys(keys: string[]) {
  return keys.map((key) => {
    const upper = key.toUpperCase()
    const mapped = KEYMAP[upper]
    if (mapped) return mapped
    return translateCtrlChord(upper) ?? key
  }).join('')
}
```

- [ ] **Step 4: Re-run tests**

Run: `npx vitest run test/unit/cli/keys.test.ts test/unit/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit chunk changes**

```bash
git add test/unit/cli/keys.test.ts server/cli/keys.ts
git commit -m "fix(cli): translate common ctrl chords for send-keys"
```

## Chunk 2: Issue #5 `resize-pane` single-axis semantics

### Task 2: Add failing server API regression tests for single-axis resize

**Files:**
- Create: `test/server/agent-resize-pane.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('preserves existing x when only y is provided', async () => {
  // setup split sizes [70, 30], call POST /api/panes/<pane>/resize { y: 33 }
  // expect resize to apply [70, 33]
})

it('derives missing axis from complement when existing sizes unavailable', async () => {
  // mock store without getSplitSizes, call with { y: 33 }
  // expect resizePane called with [67, 33]
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/server/agent-resize-pane.test.ts --config vitest.server.config.ts`
Expected: FAIL (current behavior injects default `50`).

### Task 3: Implement safe single-axis normalization/preservation

**Files:**
- Modify: `server/agent-api/router.ts`
- Modify: `server/agent-api/layout-store.ts`

- [ ] **Step 3: Add split-size lookup helper on layout store**

```ts
getSplitSizes(tabId: string | undefined, splitId: string): [number, number] | undefined {
  // locate split in target tab or inferred tab, return tuple if found
}
```

- [ ] **Step 4: Refactor resize route to resolve target split first, then normalize sizes**

```ts
const explicitX = parseNumber(req.body?.x)
const explicitY = parseNumber(req.body?.y)
const current = layoutStore.getSplitSizes?.(resolvedTabId, splitId)

const nextX = Number.isFinite(explicitX)
  ? explicitX
  : Number.isFinite(explicitY)
    ? (Number.isFinite(current?.[0]) ? current![0] : 100 - explicitY)
    : Number.isFinite(current?.[0]) ? current![0] : 50

const nextY = Number.isFinite(explicitY)
  ? explicitY
  : Number.isFinite(explicitX)
    ? (Number.isFinite(current?.[1]) ? current![1] : 100 - explicitX)
    : Number.isFinite(current?.[1]) ? current![1] : 50
```

- [ ] **Step 5: Add CLI flow coverage for `resize-pane --y`**

**Files:**
- Modify: `test/e2e/agent-cli-flow.test.ts`

```ts
it('resize-pane preserves unspecified axis', async () => {
  // mock store returns current sizes [72, 28]
  // run CLI resize-pane -t pane_1 --y 33
  // expect store.resizePane(..., [72, 33])
})
```

- [ ] **Step 6: Re-run tests**

Run:
- `npx vitest run test/server/agent-resize-pane.test.ts --config vitest.server.config.ts`
- `npx vitest run test/e2e/agent-cli-flow.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit chunk changes**

```bash
git add server/agent-api/router.ts server/agent-api/layout-store.ts test/server/agent-resize-pane.test.ts test/e2e/agent-cli-flow.test.ts
git commit -m "fix(api): make resize-pane single-axis updates preserve other axis"
```

## Chunk 3: Issue #6 screenshot API availability and timeout ergonomics

### Task 4: Add failing protocol + API tests for screenshot capability selection and error mapping

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/agent-screenshot-api.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`

- [ ] **Step 1: Write failing WS protocol tests**

```ts
it('rejects screenshot request immediately when no screenshot-capable client is connected', async () => {
  // hello without uiScreenshotV1 capability
  // expect requestUiScreenshot rejection with capability error
})

it('dispatches screenshot.capture only to uiScreenshotV1-capable client', async () => {
  // connect non-capable + capable clients, ensure capable receives command
})
```

- [ ] **Step 2: Write failing screenshot API tests**

```ts
it('returns 503 when no screenshot-capable UI client is available', async () => {
  wsHandler.requestUiScreenshot.mockRejectedValue(new Error('No screenshot-capable UI client connected'))
  // expect HTTP 503 with actionable message
})

it('returns 504 when ui screenshot request times out', async () => {
  wsHandler.requestUiScreenshot.mockRejectedValue(new Error('Timed out waiting for UI screenshot response'))
  // expect HTTP 504 with actionable retry guidance
})
```

- [ ] **Step 3: Update client hello test expectation**

```ts
expect(hello.capabilities).toEqual({ sessionsPatchV1: true, uiScreenshotV1: true })
```

- [ ] **Step 4: Run tests to verify failure**

Run:
- `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
- `npx vitest run test/server/agent-screenshot-api.test.ts --config vitest.server.config.ts`
- `npx vitest run test/unit/client/lib/ws-client.test.ts`
Expected: FAIL before implementation.

### Task 5: Implement screenshot capability handshake and error mapping

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/agent-api/router.ts`

- [ ] **Step 5: Add `capabilities.uiScreenshotV1` to shared hello schema**

- [ ] **Step 6: Send `uiScreenshotV1: true` from browser WS client hello**

- [ ] **Step 7: Track screenshot capability in WS server client state and target selection**

```ts
type ClientState = {
  supportsUiScreenshotV1: boolean
}

state.supportsUiScreenshotV1 = !!m.capabilities?.uiScreenshotV1

const targetWs = this.findTargetUiSocket(preferredConnectionId, {
  requireScreenshotCapability: true,
})
if (!targetWs) throw screenshotError('NO_SCREENSHOT_CLIENT', 'No screenshot-capable UI client connected')
```

- [ ] **Step 8: Return clearer status codes in screenshot API route**

```ts
if (err.code === 'NO_SCREENSHOT_CLIENT') return res.status(503).json(fail(err.message))
if (err.code === 'SCREENSHOT_TIMEOUT') return res.status(504).json(fail('Timed out waiting for UI screenshot response; ensure a browser UI tab is connected and retry.'))
```

- [ ] **Step 9: Re-run targeted tests**

Run:
- `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
- `npx vitest run test/server/agent-screenshot-api.test.ts --config vitest.server.config.ts`
- `npx vitest run test/unit/client/lib/ws-client.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit chunk changes**

```bash
git add shared/ws-protocol.ts src/lib/ws-client.ts server/ws-handler.ts server/agent-api/router.ts test/server/ws-protocol.test.ts test/server/agent-screenshot-api.test.ts test/unit/client/lib/ws-client.test.ts
git commit -m "fix(screenshot): fail fast without capture-capable ui client"
```

## Chunk 4: End-to-end verification, manual validation, and review gates

### Task 6: Full automated regression and manual checks

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Run focused e2e smoke for CLI automation path**

Run: `npx vitest run test/e2e/agent-cli-screenshot-smoke.test.ts`
Expected: PASS.

- [ ] **Step 2: Run complete test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Manual validation against live server**

Run in terminal A:
- `PORT=3344 npm run dev:server`

Run in terminal B:
- `FRESHELL_URL=http://127.0.0.1:3344 FRESHELL_TOKEN=<token> node node_modules/tsx/dist/cli.mjs server/cli/index.ts send-keys <paneId> C-U`
- `FRESHELL_URL=http://127.0.0.1:3344 FRESHELL_TOKEN=<token> node node_modules/tsx/dist/cli.mjs server/cli/index.ts resize-pane -t <paneId> --y 33`
- `FRESHELL_URL=http://127.0.0.1:3344 FRESHELL_TOKEN=<token> node node_modules/tsx/dist/cli.mjs server/cli/index.ts screenshot-view --name manual-no-ui-check`

Expected:
- `send-keys C-U` clears current shell line (no literal `C-U` in pane).
- single-axis resize preserves/derives other axis predictably (no implicit `50` reset).
- screenshot command returns immediate clear availability error if no capture-capable UI tab.

- [ ] **Step 4: Run independent review on final code commit (@fresheyes)**

Run:
- `bash /home/user/code/fresheyes/skills/fresheyes/fresheyes.sh --claude "Review the changes between main and this branch using git diff main...HEAD."`

Expected: No unresolved findings; fix and re-run until clean.

- [ ] **Step 5: Final commit for any post-review fixes (if needed)**

```bash
git add <files>
git commit -m "fix: address fresheyes review findings"
```

