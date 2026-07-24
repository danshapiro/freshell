# Spec: Editor pane font size follows the terminal Font size setting

- **Date**: 2026-07-08
- **Branch**: `feat/editor-font-setting` (worktree `.worktrees/editor-font`, based on `origin/main` @ `b5daeea4`)
- **Status**: Ready for implementation (Red-Green-Refactor TDD)
- **Scope guard**: consume `settings.terminal.fontSize` in the editor pane only. Do NOT add a
  separate editor font setting. Do NOT touch font family, line height, minimap, or any other
  Monaco option. No server, schema, or settings-UI changes.

## 1. Problem

The Monaco-based editor pane hard-codes its font size:

- `src/components/panes/EditorPane.tsx:1033` — `fontSize: 14,` inside the inline `options`
  literal passed to `<Editor>` (`src/components/panes/EditorPane.tsx:1024-1041`).

Every other text surface follows the local terminal Font size setting
(`settings.terminal.fontSize`, clamped 12–64, default 16):

- xterm initial: `src/components/TerminalView.tsx:1727` (`fontSize: settings.terminal.fontSize`)
- xterm live: `src/components/TerminalView.tsx:2638` (`term.options.fontSize = settings.terminal.fontSize`)
- fresh-agent transcript: `src/components/fresh-agent/FreshAgentView.tsx:512-514` (selector) feeding
  an inline CSS var
- UI chrome: `src/hooks/useTheme.ts:8-12` — `--ui-scale = (terminalFontSize / 16) * uiScale`

Monaco sizes in raw px and does not inherit the rem-based `--ui-scale`, so the editor is the one
pane that ignores the setting entirely (this is the gap left by PR #511 / #509).

## 2. Verified facts (worktree @ b5daeea4)

| Fact | Evidence |
|---|---|
| Hard-coded editor font | `src/components/panes/EditorPane.tsx:1033` |
| Options passed as **inline literal**, new identity every render | `src/components/panes/EditorPane.tsx:1031-1040` |
| Editor instance held in ref via `onMount` | `editorRef` at `src/components/panes/EditorPane.tsx:175`; `handleEditorMount` at `:294-297`; `onMount={handleEditorMount}` at `:1029` |
| EditorPane already subscribes to settings | `useMonacoTheme` at `src/components/panes/EditorPane.tsx:21-26` uses `useAppSelector((s) => s.settings.settings.theme)` |
| `@monaco-editor/react` `^4.6.0` applies `options` changes live | `package.json`; installed dist (`node_modules/@monaco-editor/react/dist/index.mjs`) contains a post-ready update effect equivalent to `useUpdate(() => editor.updateOptions(options), [options], isEditorReady)`, and the mount path spreads options into `editor.create(..., { model, automaticLayout: true, ...options })` |
| Precedent selector shape (exact) | `src/components/fresh-agent/FreshAgentView.tsx:512-514`: `useAppSelector((state) => state.settings.settings.terminal?.fontSize) ?? 16` — plain primitive selector, **no** memoization/`shallowEqual` (correct for a primitive) |
| Clamp/normalize is shared and local-only | `shared/settings.ts:44-45` (`TERMINAL_FONT_SIZE_MIN = 12`, `TERMINAL_FONT_SIZE_MAX = 64`, module-private), `:504-511` (`normalizeRoundedClampedNumber`), `:854` (default `fontSize: 16`); local-only persistence at `src/store/browserPreferencesPersistence.ts:94` |
| Store action the slider dispatches | `src/components/settings/AppearanceSettings.tsx:360-369` → `applyLocalSetting({ terminal: { fontSize: v } })` → `updateSettingsLocal` (`src/store/settingsSlice.ts:117-122`), which re-normalizes through the shared clamp path — dispatching an out-of-range value lands clamped in `state.settings.settings.terminal.fontSize` |
| Default slice state already resolves to 16 | `src/store/settingsSlice.ts:85-90` (`initialState.settings = resolveSettings(defaults, ...)`) |
| No test pins the editor's 14 | `grep 'fontSize:\s*14'` hits: `EditorPane.tsx:1033` (the source), plus terminal-settings *fixtures* in `test/unit/client/components/panes/PaneContainer.test.tsx:1687,2109`, `test/unit/client/components/panes/PanePicker.test.tsx:86`, `test/e2e/directory-picker-flow.test.tsx:144,237` — all preloaded `settings.terminal` state, none assert Monaco options. No change needed to any of them. |
| Existing Monaco mocks ignore `options` | e.g. `test/unit/client/components/panes/EditorPane.test.tsx:23-36` and `EditorPane.connectivity.test.tsx:23-28` render a `<textarea data-testid="monaco-mock">` exposing only `value`/`onChange`/`theme`. Each test file declares its own mock, so a new options-aware mock in a new file collides with nothing. |
| Docs mock irrelevant | `docs/index.html` contains no Monaco/editor-pane rendering (only the pane-picker "Editor" label at `:708` and the *external* editor settings section at `:1043-1048`). Per `AGENTS.md:26` only major UI changes need the mock updated — this is not one. No change. |

## 3. Design

### 3.1 Mapping: direct (`editor fontSize = settings.terminal.fontSize`)

Chosen: **direct 1:1**, no scaling factor.

- Consistency: xterm uses the value directly (`TerminalView.tsx:1727`), and `--ui-scale`
  already equates UI text with terminal text at 100% scale (`useTheme.ts:10-12`). A scaled
  mapping (e.g. `× 14/16`) would preserve the old default but create a permanent, inexplicable
  offset between the editor and every other pane, plus a magic constant to maintain.
- Monaco derives `lineHeight` from `fontSize` when `lineHeight` is unset (it is unset in
  `EditorPane.tsx:1031-1040`), so no companion option needs touching. The minimap is disabled
  (`minimap: { enabled: false }` at `:1032`), so there is no minimap-font interaction.
- Consequence: the default editor font grows from 14 → 16px. Accepted — it *aligns* the editor
  with the terminal default rather than changing it arbitrarily.

### 3.2 Wiring: selector into the existing options literal — no effect, no ref plumbing

`@monaco-editor/react` v4 already does the live-update work: its internal effect calls
`editor.updateOptions(options)` whenever the `options` prop identity changes (verified in the
installed dist, §2). EditorPane passes an inline literal, so every re-render produces a new
identity. Therefore the entire implementation is:

1. Subscribe: `useAppSelector` on the fontSize primitive → any settings change re-renders
   EditorPane.
2. Feed the value into the existing literal → the wrapper calls `updateOptions` (live, no
   remount) and spreads it into `editor.create` for editors mounted later.

A `useEffect` + `editorRef.current?.updateOptions(...)` would duplicate what the wrapper
already does — rejected (abstraction with no justification). No memoized selector: it returns
a primitive, matching FreshAgentView (`:512-514`) and useTheme (`:8`).

### 3.3 Exact changes — `src/components/panes/EditorPane.tsx` (only file changed in `src/`)

**(a)** Inside the `EditorPane` component body, next to the other selectors/refs (e.g. adjacent
to `const dispatch = ...` / near `:175`), add:

```tsx
const editorFontSize = useAppSelector((s) => s.settings.settings.terminal?.fontSize) ?? 16
```

(`useAppSelector` is already imported at `:4`.)

**(b)** At `:1033`, replace:

```tsx
              fontSize: 14,
```

with:

```tsx
              fontSize: editorFontSize,
```

All other options at `:1031-1040` stay byte-identical. Nothing else changes: `handleEditorMount`
(`:294-297`), `editorRef` (`:175`), preview mode, and word wrap are untouched. When a pane is in
preview mode `<Editor>` is not mounted; toggling back to source mounts it with the then-current
value via the `editor.create` spread — no special handling needed.

## 4. TDD plan (Red → Green → Refactor)

### 4.1 RED — new test file

**Create** `test/unit/client/components/panes/EditorPane.fontSize.test.tsx`.

Follow the structure of `EditorPane.connectivity.test.tsx` (real reducers, no preloaded state)
but with an **options-aware** Monaco mock:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange, options }: any) => (
    <textarea
      data-testid="monaco-mock"
      data-font-size={String(options?.fontSize)}
      data-minimap-enabled={String(options?.minimap?.enabled)}
      data-tab-size={String(options?.tabSize)}
      value={value}
      onChange={(e: any) => onChange?.(e.target.value)}
    />
  )
  return { default: MonacoMock, Editor: MonacoMock }
})

import EditorPane from '@/components/panes/EditorPane'
```

Store helper: `configureStore({ reducer: { panes, settings, connection } })` with **no**
`preloadedState` (slice default resolves `terminal.fontSize` to 16, §2), then
`store.dispatch(setStatus('ready'))`. Stub `fetch` as in `EditorPane.test.tsx:116-118` (a
routed no-op resolver) so mount-time API calls don't reject. Render EditorPane with the standard
props (`paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript"
readOnly={false} content="const x = 1" viewMode="source"`).

Tests, in order — **all four must fail against current code** (mock reports
`data-font-size="14"`):

1. **default follows setting (16, not 14)**
   Render with the default store. Assert
   `screen.getByTestId('monaco-mock').getAttribute('data-font-size')` is `'16'`.
2. **non-default value at mount (editor opened after the setting changed)**
   `store.dispatch(updateSettingsLocal({ terminal: { fontSize: 20 } }))` *before* `render`.
   Assert `data-font-size === '20'`. (Dispatching through the real reducer exercises the shared
   normalize path instead of hand-rolling preloaded state.)
3. **live update without remount (slider drag)**
   Render with default; capture the mock node. Then
   `act(() => { store.dispatch(updateSettingsLocal({ terminal: { fontSize: 24 } })) })`.
   Assert the *same* node (identity-compare with the captured element to prove no remount) now
   has `data-font-size === '24'`.
4. **clamped value flows through (selector must not bypass normalization)**
   `act(() => { store.dispatch(updateSettingsLocal({ terminal: { fontSize: 999 } })) })` after
   render. Assert `store.getState().settings.settings.terminal.fontSize === 64` and
   `data-font-size === '64'`. (Min-side, 1 → 12, is already covered by
   `test/unit/shared/settings.test.ts`; one boundary here is enough to pin the wiring.)

Regression guard inside test 1: also assert `data-minimap-enabled === 'false'` and
`data-tab-size === '2'` so the builder cannot satisfy the suite by replacing the options object
wholesale.

**Multi-editor edge (covered by construction, not a test):** each EditorPane instance runs its
own `useAppSelector`, so N open editors each re-render on one dispatch. Test 3 proves the
mechanism for one instance; a two-instance test would only re-test React-Redux. Omitted
deliberately.

Run (client vitest config):

```
npx vitest run --config config/vitest/vitest.config.ts test/unit/client/components/panes/EditorPane.fontSize.test.tsx
```

Confirm: 4 failures, each reporting actual `'14'`.

### 4.2 GREEN — implementation

Apply §3.3 (a) and (b) to `src/components/panes/EditorPane.tsx`. Re-run the file above → 4 pass.

### 4.3 REFACTOR / full verification

- No extraction: a one-line primitive selector does not justify a shared hook or constant.
  (If a reviewer wants the `?? 16` fallback centralized later, that refactor belongs with the
  three existing duplicates at `FreshAgentView.tsx:514` and `useTheme.ts:8` — out of scope.)
- Confirm no stragglers: `grep -rn 'fontSize: 14' src/` → zero hits.
- Existing suites that render EditorPane with Monaco mocked must pass **unchanged** (their mocks
  ignore `options`; their fixtures already contain `terminal.fontSize`, and the `?.`/`?? 16`
  fallback covers any store without it):
  - `test/unit/client/components/panes/EditorPane.test.tsx`
  - `test/unit/client/components/panes/EditorPane.connectivity.test.tsx`
  - `test/unit/client/components/panes/EditorPane.autosave.test.tsx`
  - `test/unit/client/components/panes/EditorPane.openInEditor.test.tsx`
  - `test/unit/client/components/panes/PaneContainer.test.tsx`, `PaneContainer.createContent.test.tsx`
  - `test/integration/client/editor-pane.test.tsx`
  - `test/e2e/terminal-file-link-same-tab.test.tsx`, `test/e2e/terminal-font-settings.test.tsx`
- Gates: `npm run typecheck:client` and the standard suite (`npm run test:balanced`, or minimally
  `npm run test:client:standard`).

## 5. Files touched (complete list)

| File | Change |
|---|---|
| `src/components/panes/EditorPane.tsx` | Add 1 selector line; replace literal at `:1033` |
| `test/unit/client/components/panes/EditorPane.fontSize.test.tsx` | New file, 4 tests (§4.1) |
| `docs/plans/2026-07-08-editor-font-follows-setting-spec.md` | This spec |

Explicitly **not** touched: `shared/settings.ts`, `src/store/*`, `AppearanceSettings.tsx`,
`docs/index.html`, any e2e-browser spec, font family / line height / minimap options.

## 6. Success criteria

1. Editor pane text renders at `settings.terminal.fontSize` px on mount (default 16).
2. Dragging the Font size slider updates open editor panes live — no remount, no reload — via
   the `options` prop → `editor.updateOptions` path.
3. Editors opened after a change pick up the current value; multiple simultaneous editors all
   track it.
4. Out-of-range values can never reach Monaco (store state is clamped 12–64 before the selector
   reads it; test 4 pins this).
5. `grep -rn 'fontSize: 14' src/` returns nothing; no new setting, prop, hook, or effect exists.
6. New test file: 4/4 green; all pre-existing suites green; client typecheck green.
