# Terminal v6 Rollout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate Freshell terminal rendering to xterm v6 packages and deliver one combined rollout with terminal search (`Ctrl+F`), OSC52 clipboard handling (`Ask/Always/Never` policy), and automatic WebGL renderer enablement with fallback.

**Architecture:** Introduce a thin terminal runtime layer around xterm/addons so `TerminalView` stays focused on app behavior and websocket flow. Migrate package/import surface to the scoped v6 modules (`@xterm/*`) while intentionally adopting v6 defaults for keyboard and scroll/viewport behavior. Add OSC52 handling as an output-stage concern (parsed from PTY output before display) with a global policy setting and explicit user prompt in `Ask` mode.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vite, xterm v6 (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-webgl`), Vitest + Testing Library + e2e-in-repo tests.

---

## Constraints and Decisions (locked)

- Combined rollout (single feature delivery), not staged release toggles.
- Keep v6 keyboard defaults (including new Alt+Arrow semantics).
- Keep v6 scroll/viewport defaults.
- Add all user-facing upgrades in same rollout: search, OSC52 clipboard, WebGL path.
- Search shortcut: override `Ctrl+F` while terminal is focused.
- OSC52 policy UX:
  - First OSC52 in `Ask` mode opens modal: `Yes / No / Always / Never`.
  - `Always`/`Never` immediately set global setting.
  - Ask even for background terminals.
  - No prompt throttling.
  - Clipboard write failures are silent.
  - No payload size cap.

---

### Task 1: Migrate dependency and import surface to scoped v6 packages

**Files:**
- Modify: `package.json`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-themes.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.visibility.test.tsx`
- Modify: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Modify: `test/unit/client/components/TerminalView.linkWarning.test.tsx`
- Modify: `test/unit/client/components/TerminalView.keyboard.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lastInputAt.test.tsx`
- Modify: `test/unit/client/components/TerminalView.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/panes/PaneLayout.test.tsx`
- Modify: `test/integration/client/editor-pane.test.tsx`
- Modify: `test/e2e/tab-focus-behavior.test.tsx`
- Modify: `test/e2e/terminal-paste-single-ingress.test.tsx`
- Modify: `test/e2e/turn-complete-notification-flow.test.tsx`

**Step 1: Write failing compile check**

Run:
```bash
npm run typecheck:client
```

Expected: current baseline passes before changing imports.

**Step 2: Implement package/import migration**

Resolve real package versions from npm first (do not guess addon versions):
```bash
npm view @xterm/xterm version
npm view @xterm/addon-fit version
npm view @xterm/addon-search version
npm view @xterm/addon-webgl version
```

Update runtime deps:
```json
{
  "dependencies": {
    "@xterm/xterm": "^<npm-view-version>",
    "@xterm/addon-fit": "^<npm-view-version>",
    "@xterm/addon-search": "^<npm-view-version>",
    "@xterm/addon-webgl": "^<npm-view-version>"
  }
}
```

Remove legacy deps in the same edit:
- delete `"xterm": "^5.3.0"`
- delete `"xterm-addon-fit": "^0.8.0"`

Update imports:
```ts
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
```

Update all test mocks from `'xterm'` / `'xterm-addon-fit'` / `'xterm/css/xterm.css'` to scoped module ids, and verify the CSS path exists after install.

**Step 3: Run dependency install + typecheck**

Run:
```bash
npm install
npm run typecheck:client
test -f node_modules/@xterm/xterm/css/xterm.css
rg -n "\"xterm\":|\"xterm-addon-fit\":" package.json
rg -n "from ['\\\"]xterm['\\\"]|from ['\\\"]xterm-addon-fit['\\\"]|['\\\"]xterm/css/xterm.css['\\\"]|vi\\.mock\\(['\\\"]xterm['\\\"]|vi\\.mock\\(['\\\"]xterm-addon-fit['\\\"]" src test
```

Expected: typecheck passes, CSS file path exists, and both `rg` commands return no matches.
Also verify `npm install` completes without peer dependency conflicts between `@xterm/xterm` and `@xterm/addon-*`.

**Step 4: Commit**

```bash
git add package.json package-lock.json src/components/TerminalView.tsx src/lib/terminal-themes.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.linkWarning.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx test/unit/client/components/TerminalView.lastInputAt.test.tsx test/unit/client/components/TerminalView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/integration/client/editor-pane.test.tsx test/e2e/tab-focus-behavior.test.tsx test/e2e/terminal-paste-single-ingress.test.tsx test/e2e/turn-complete-notification-flow.test.tsx

git commit -m "chore(terminal): migrate to scoped @xterm v6 packages and update test mocks"
```

---

### Task 2: Add terminal runtime adapter for add-on lifecycle (fit/search/webgl)

**Files:**
- Create: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/components/TerminalView.tsx`
- Create: `test/unit/client/components/terminal/terminal-runtime.test.ts`

**Step 1: Write failing runtime tests**

Create tests for:
- `createTerminalRuntime` loads `FitAddon` and `SearchAddon` always.
- WebGL addon is attempted and fallback path does not throw.
- WebGL context loss event marks runtime as non-WebGL and terminal remains usable.

Example test skeleton:
```ts
it('attempts webgl and continues when addon throws', () => {
  const runtime = createTerminalRuntime({ terminal: mockTerm, enableWebgl: true })
  expect(() => runtime.attachAddons()).not.toThrow()
})
```

**Step 2: Run targeted test to confirm fail**

Run:
```bash
npx vitest run test/unit/client/components/terminal/terminal-runtime.test.ts
```

Expected: FAIL (`createTerminalRuntime` missing).

**Step 3: Implement adapter**

Implement a small interface:
```ts
export type TerminalRuntime = {
  fit: () => void
  findNext: (term: string, opts?: SearchOptions) => boolean
  findPrevious: (term: string, opts?: SearchOptions) => boolean
  dispose: () => void
  webglActive: () => boolean
}
```

`attachAddons()` behavior:
- always load fit + search
- if webgl enabled, `try { terminal.loadAddon(new WebglAddon()) } catch {}`
- register `webglAddon.onContextLoss(...)`; on loss, mark WebGL inactive and dispose addon without throwing
- if webgl init fails or context is lost later, keep terminal functional (silent fallback)

**Step 4: Integrate runtime into `TerminalView`**

Replace direct `FitAddon` reference fields completely. Remove `fitRef` from `TerminalView` and migrate all fit call sites to runtime methods:
- initial mount fit after `term.open(...)`
- `ResizeObserver` callback fit + resize send
- settings-change fit (when visible)
- hidden->visible fit + resize send

**Step 5: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/terminal/terminal-runtime.test.ts
npm run test:client -- TerminalView
```

Expected: pass.

**Step 6: Commit**

```bash
git add src/components/terminal/terminal-runtime.ts src/components/TerminalView.tsx test/unit/client/components/terminal/terminal-runtime.test.ts

git commit -m "refactor(terminal): introduce runtime adapter for fit/search/webgl addon lifecycle"
```

---

### Task 3: Add new terminal settings for OSC52 policy and renderer mode

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `server/config-store.ts`
- Modify: `test/unit/client/store/settingsSlice.test.ts`
- Modify: `test/integration/server/settings-api.test.ts`

**Step 1: Write failing tests for new setting defaults + merges**

Add assertions that default terminal settings include:
```ts
osc52Clipboard: 'ask'
renderer: 'auto'
```

And that partial patch preserves existing terminal keys.

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/unit/client/store/settingsSlice.test.ts
npx vitest run test/integration/server/settings-api.test.ts
```

Expected: FAIL on missing fields.

**Step 3: Implement setting types/defaults/merge**

Client/server setting shape:
```ts
terminal: {
  // existing fields...
  osc52Clipboard: 'ask' | 'always' | 'never'
  renderer: 'auto' | 'webgl' | 'canvas'
}
```

Decision mapping:
- UI default remains `ask`
- Renderer policy selected by user decision `3b` is implemented by defaulting to `'auto'` and enabling WebGL where supported.
- Renderer is persisted in settings but intentionally not exposed in Settings UI in this rollout (policy stays internal with `'auto'` default).

Critical server details:
- Update duplicated server `AppSettings` type in `server/config-store.ts` (it is not shared with client type definitions).
- Extend `mergeSettings` terminal allowlist in `server/config-store.ts` to include:
```ts
osc52Clipboard: terminalPatch.osc52Clipboard,
renderer: terminalPatch.renderer,
```
Without this, API patch calls silently drop the new fields.

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/store/settingsSlice.test.ts
npx vitest run test/integration/server/settings-api.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/store/types.ts src/store/settingsSlice.ts server/config-store.ts test/unit/client/store/settingsSlice.test.ts test/integration/server/settings-api.test.ts

git commit -m "feat(settings): add terminal osc52 clipboard policy and renderer mode fields"
```

---

### Task 4: Add Advanced (collapsed) Terminal settings UI for OSC52 policy

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Create: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`

**Step 1: Write failing UI tests**

Test expectations:
- Advanced section is collapsed by default.
- Expanding reveals `OSC52 clipboard access` segmented/select control (`Ask/Always/Never`).
- Selecting `Always` or `Never` persists via `scheduleSave` path.

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/unit/client/components/SettingsView.terminal-advanced.test.tsx
```

Expected: FAIL (UI not present).

**Step 3: Implement Advanced section**

Add terminal subsection:
```tsx
const advancedId = useId()
<button aria-expanded={advancedOpen} aria-controls={advancedId}>Advanced</button>
<div id={advancedId} hidden={!advancedOpen}>...</div>
```

Inside advanced:
- `OSC52 clipboard access` control with values `ask|always|never`.

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/component-edge-cases.test.tsx
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx test/unit/client/components/component-edge-cases.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx

git commit -m "feat(settings): add collapsed terminal advanced section with OSC52 policy control"
```

---

### Task 5: Implement OSC52 parser utility and policy decision unit tests

**Files:**
- Create: `src/lib/terminal-osc52.ts`
- Create: `test/unit/client/lib/terminal-osc52.test.ts`

**Step 1: Write failing parser tests**

Cover:
- Extract OSC52 clipboard frames from output stream.
- Preserve non-OSC52 output.
- Handle chunked/incomplete sequences.
- Decode base64 payload.
- Support both BEL (`\u0007`) and ST (`\u001b\\` / `\u009c`) OSC terminators.

Example:
```ts
it('extracts OSC52 payload and returns cleaned output', () => {
  const input = "hello\u001b]52;c;Y29weQ==\u0007world"
  const result = extractOsc52Events(input, createOsc52ParserState())
  expect(result.cleaned).toBe('helloworld')
  expect(result.events[0].text).toBe('copy')
})
```

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/unit/client/lib/terminal-osc52.test.ts
```

Expected: FAIL (module missing).

**Step 3: Implement parser state machine**

Export:
```ts
export type Osc52Policy = 'ask' | 'always' | 'never'
export function createOsc52ParserState(): Osc52ParserState
export function extractOsc52Events(data: string, state: Osc52ParserState): { cleaned: string; events: Osc52Event[] }
```

Behavior:
- strip OSC52 control sequences from terminal output
- produce decoded text events for policy handling
- handle both BEL and ST terminators in stream-safe fashion

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/lib/terminal-osc52.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/lib/terminal-osc52.ts test/unit/client/lib/terminal-osc52.test.ts

git commit -m "feat(terminal): add OSC52 parser and stream-safe extraction utility"
```

---

### Task 6: Wire OSC52 handling into TerminalView with Ask modal and global policy updates

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Create: `src/components/terminal/Osc52PromptModal.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Create: `test/unit/client/components/TerminalView.osc52.test.tsx`

**Step 1: Write failing behavior tests**

Add tests for:
- `always`: copy attempted silently, no prompt.
- `never`: no copy, no prompt.
- `ask + Yes`: copy once, keep ask.
- `ask + No`: no copy, keep ask.
- `ask + Always`: copy + dispatch settings update to always.
- `ask + Never`: no copy + dispatch settings update to never.
- clipboard write rejection does not surface UI error.
- `terminal.snapshot` replay sanitizes OSC52 and preserves `term.clear()` behavior.
- `terminal.created` non-chunked snapshot replay sanitizes OSC52 and preserves `term.clear()` behavior.
- `terminal.attached` snapshot replay sanitizes OSC52 and preserves `term.clear()` behavior.
- snapshot replay does not trigger turn-complete notifications/actions.

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/unit/client/components/TerminalView.osc52.test.tsx
```

Expected: FAIL.

**Step 3: Implement output vs snapshot ingestion paths**

Apply stream transforms in this exact order to preserve existing turn-complete behavior:
1. `raw` -> `extractOsc52Events` (strip OSC52, collect clipboard events)
2. resulting text -> `extractTurnCompleteSignals`
3. write final cleaned text to terminal
4. process emitted OSC52 clipboard events

Use dedicated handlers so snapshot replay has no turn-complete side effects:
```ts
function handleTerminalOutput(raw: string) {
  const osc = extractOsc52Events(raw, osc52ParserRef.current)
  const turn = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)
  if (turn.cleaned) term.write(turn.cleaned)
  for (const event of osc.events) handleOsc52Event(event)
}

function handleTerminalSnapshot(snapshot: string) {
  // snapshot is historical buffer replay: sanitize OSC52, but do not emit turn-complete events
  const osc = extractOsc52Events(snapshot, createOsc52ParserState())
  term.clear()
  if (osc.cleaned) term.write(osc.cleaned)
  for (const event of osc.events) handleOsc52Event(event)
}
```

Call `handleTerminalOutput(msg.data)` in `terminal.output`.
Call `handleTerminalSnapshot(msg.snapshot)` in both snapshot write sites:
- `terminal.snapshot`
- `terminal.created` when `msg.snapshot && !isSnapshotChunked`
- `terminal.attached`
This closes OSC52 bypasses while preserving existing `term.clear()` semantics and preventing snapshot-triggered turn-complete notifications.

Policy handler:
- read `settings.terminal.osc52Clipboard`
- apply prompt flow in Ask mode using `Osc52PromptModal`
- on Always/Never button, dispatch+save setting update
- clipboard write errors swallowed (`catch(() => {})`)

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/TerminalView.osc52.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/Osc52PromptModal.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx

git commit -m "feat(terminal): add OSC52 clipboard prompt flow and global Ask/Always/Never policy"
```

---

### Task 7: Add terminal search UI and Ctrl+F override in terminal focus

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Create: `src/components/terminal/TerminalSearchBar.tsx`
- Create: `test/unit/client/components/TerminalView.search.test.tsx`
- Modify: `test/unit/client/components/TerminalView.keyboard.test.tsx`

**Step 1: Write failing tests for search UX**

Cover:
- `Ctrl+F` returns false in terminal key handler and opens search UI.
- typing a term performs find-next.
- `Enter` = next, `Shift+Enter` = previous.
- `Escape` closes search UI and refocuses terminal.

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx
```

Expected: FAIL.

**Step 3: Implement search addon integration**

Use runtime wrapper methods:
```ts
runtime.findNext(query, { caseSensitive: false, incremental: true })
runtime.findPrevious(query, { caseSensitive: false, incremental: true })
```

Keyboard interception:
```ts
if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'f') {
  setSearchOpen(true)
  return false
}
```

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/TerminalSearchBar.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx

git commit -m "feat(terminal): add in-pane search with Ctrl+F override and next/previous navigation"
```

---

### Task 8: Enable WebGL renderer auto path with fallback behavior

**Files:**
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/components/TerminalView.tsx`
- Create: `test/unit/client/components/TerminalView.renderer.test.tsx`

**Step 1: Write failing renderer tests**

Cover:
- when renderer mode is `auto`, runtime attempts WebGL.
- if addon load or activation fails, terminal still opens and works.
- when renderer mode forced `canvas`, WebGL is not attempted.
- when WebGL context loss is emitted after attach, runtime flips to non-WebGL state and terminal remains functional.

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/unit/client/components/TerminalView.renderer.test.tsx
```

Expected: FAIL.

**Step 3: Implement renderer mode resolution**

Resolution:
- `'auto'` => attempt WebGL once per terminal instance
- `'webgl'` => force attempt
- `'canvas'` => skip attempt
- register `WebglAddon.onContextLoss` to dispose the addon and mark `webglActive()` false

No user-facing error surface on fallback.

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/TerminalView.renderer.test.tsx
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/components/terminal/terminal-runtime.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.renderer.test.tsx

git commit -m "feat(terminal): auto-enable WebGL renderer with silent fallback to canvas"
```

---

### Task 9: Add end-to-end coverage for search + OSC52 + renderer bootstrap

**Files:**
- Create: `test/e2e/terminal-search-flow.test.tsx`
- Create: `test/e2e/terminal-osc52-policy-flow.test.tsx`
- Modify: `test/e2e/tab-focus-behavior.test.tsx` (if needed for ctrl+f overlap)

**Step 1: Write failing e2e tests**

Scenarios:
- Search: open terminal, hit `Ctrl+F`, find controls visible, navigate next/prev.
- OSC52 Ask: receive terminal output with OSC52, modal appears, `Always` updates store setting.
- OSC52 Never: no modal, no clipboard writes.

**Step 2: Run tests to verify fail**

Run:
```bash
npx vitest run test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: FAIL.

**Step 3: Implement any missing wiring discovered by e2e**

Patch `TerminalView`/settings wiring until e2e scenarios pass without adding test-only hooks.

**Step 4: Re-run e2e tests**

Run:
```bash
npx vitest run test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: pass.

**Step 5: Commit**

```bash
git add test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx test/e2e/tab-focus-behavior.test.tsx

git commit -m "test(e2e): cover terminal search flow and OSC52 Ask/Always/Never policy behavior"
```

---

### Task 10: Update docs mock and run full verification gate

**Files:**
- Modify: `docs/index.html`
- Modify: `docs/plans/2026-02-14-terminal-v6-rollout.md` (checklist completion notes)

**Step 1: Update docs mock for visible terminal changes**

Document:
- terminal search affordance
- terminal advanced settings section (`OSC52 clipboard access`)

**Step 2: Run full validation**

Run:
```bash
npm run lint
npm run test
npm run verify
```

Expected: all pass.

**Step 3: Create integration summary commit**

```bash
git add docs/index.html docs/plans/2026-02-14-terminal-v6-rollout.md

git commit -m "docs(terminal): reflect v6 search and advanced OSC52 settings; finalize rollout verification"
```

---

## Final Verification Checklist

- [x] `@xterm/*` v6 modules used everywhere (no legacy `xterm` package imports).
- [x] v6 default keyboard behavior preserved (no legacy Alt-arrow compatibility shim added).
- [x] v6 viewport/scroll defaults preserved.
- [x] Search (`Ctrl+F`) works in focused terminal and does not break tab shortcuts.
- [x] OSC52 Ask/Always/Never works exactly as specified.
- [x] `Always`/`Never` buttons in prompt update global setting immediately.
- [x] Clipboard write failures are silent.
- [x] WebGL attempted automatically with robust fallback.
- [x] Unit + e2e coverage added for all new behaviors.
- [x] `npm run test` and `npm run verify` pass.

## Completion Notes (2026-02-14)

- Tasks 1-9 completed and committed on `feature/terminal-v6-rollout` through `c47293f`.
- Task 10 docs updates completed:
  - `docs/index.html` now calls out in-pane terminal search (`Ctrl+F`) and advanced OSC52 clipboard policy controls.
  - This plan checklist has been updated with completion status.
- Validation gate status:
  - `npm run lint` passes (warnings only; no errors).
  - `npm run test` executes suites but does not terminate cleanly in this environment; after suites complete, the process loops with repeated WebSocket hello-timeout logs (`code: 4002`) every ~30s.
  - `npm run verify` build stage passes (`typecheck`, `build:client`, `build:server`), then enters the same non-terminating `vitest` behavior during its `npm test` phase.

## Completion Notes (2026-02-15)

- Resolved the non-terminating Vitest loop by fixing `test/unit/server/ws-handler-sdk.test.ts`:
  - test fixture now sets a deterministic `AUTH_TOKEN` for each test and restores prior env state.
  - `connectAndAuth()` now rejects on close/timeout instead of hanging forever when handshake/ready does not complete.
- Hardened client test cleanup and reconnection teardown:
  - `src/lib/ws-client.ts` now clears reconnect/ready timers during connect/disconnect transitions and exposes `resetWsClientForTests()`.
  - `test/setup/dom.ts` calls `resetWsClientForTests()` in global `afterEach`.
  - Added regression coverage in `test/unit/client/lib/ws-client.test.ts` for reconnect timer cleanup.
- Updated `test/unit/client/store/state-edge-cases.test.ts` to assert merged defaults with new terminal setting fields.
- Stabilized `test/unit/client/components/BackgroundSessions.test.tsx` by triggering explicit refresh before asserting `Attach` button presence.
- Final validation gate:
  - `npm run lint` passes (warnings only; no errors).
  - `npm run test` passes and exits cleanly.
  - `npm run verify` passes and exits cleanly.
