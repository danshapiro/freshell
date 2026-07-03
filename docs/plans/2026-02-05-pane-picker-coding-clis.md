# Pane Picker: Coding CLI Buttons

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Claude and Codex as first-class options in the pane picker, with per-CLI starting directory settings and server-side CLI availability detection.

**Architecture:** The pane picker gains coding CLI buttons (using existing SVGs) whose visibility is gated by: (1) the provider being enabled in settings and (2) the CLI binary being detected on the server. The server exposes CLI availability via `GET /api/platform`. Each provider gets a `cwd` setting in the Settings UI. Option order: Claude, Codex, Editor, Browser, then shell(s). Keyboard shortcuts are scoped to only fire when the picker pane is focused.

**Tech Stack:** React, Redux Toolkit, Vitest, Testing Library, Express, node-pty

---

## Context for the implementer

### Key files you'll touch
- `src/components/panes/PanePicker.tsx` — the picker UI
- `src/components/panes/PaneContainer.tsx` — `PickerWrapper` maps picker selections to `PaneContent`
- `src/components/SettingsView.tsx` — settings UI (add per-provider cwd)
- `src/store/types.ts` — `CodingCliSettings` type (add `cwd` to provider settings)
- `src/store/connectionSlice.ts` — store CLI availability from server
- `src/lib/coding-cli-utils.ts` — provider config (add `iconPath`)
- `server/platform.ts` — detect CLI availability
- `server/index.ts` — augment `/api/platform` response

### How the picker currently works
1. `PanePicker` renders options based on platform (shell vs cmd/ps/wsl) plus Browser/Editor
2. User clicks or presses shortcut key -> `onSelect(type)` fires
3. `PickerWrapper` in `PaneContainer.tsx` maps the type string to a `PaneContent` object and dispatches `updatePaneContent`
4. For terminals: content has `{ kind: 'terminal', mode, shell, createRequestId, status: 'creating' }`

### How platform detection works
- Server: `GET /api/platform` calls `detectPlatform()` returning `{ platform: 'win32' | 'wsl' | 'linux' | 'darwin' }`
- Client: `App.tsx` fetches on mount, dispatches `setPlatform(platform)` to `connectionSlice`
- `PanePicker` reads `useAppSelector(s => s.connection.platform)` to decide which shell options to show

### How settings work
- `AppSettings.codingCli.providers` is `Partial<Record<CodingCliProviderName, { model?, sandbox?, permissionMode?, maxTurns? }>>`
- `SettingsView` iterates `CODING_CLI_PROVIDER_CONFIGS` to render enable/disable toggles and per-provider fields
- Changes dispatch `updateSettingsLocal` then `scheduleSave` (debounced PATCH to `/api/settings`)

### Test patterns
- Unit tests use `vitest`, `@testing-library/react`, `configureStore` with preloaded state
- Mock `@/lib/ws-client`, `lucide-react`, `@/components/TerminalView`, `@/lib/api`
- See `test/unit/client/components/SettingsView.panes.test.tsx` and `test/unit/client/components/panes/PaneContainer.test.tsx`

---

## Task 1: Server-side CLI availability detection

Add CLI detection to `server/platform.ts` and augment the `/api/platform` response.

**Files:**
- Modify: `server/platform.ts`
- Modify: `server/index.ts:207-210`
- Test: `test/unit/server/platform.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/server/platform.test.ts`:

```typescript
import { detectAvailableClis } from '../../server/platform.js' // will need the .js for NodeNext

describe('detectAvailableClis', () => {
  it('returns an object with boolean values for each CLI', async () => {
    const result = await detectAvailableClis()
    expect(typeof result.claude).toBe('boolean')
    expect(typeof result.codex).toBe('boolean')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/server/platform.test.ts`
Expected: FAIL — `detectAvailableClis` is not exported

**Step 3: Implement `detectAvailableClis` in `server/platform.ts`**

```typescript
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Check if a CLI command is available on PATH.
 * Uses `which` on Unix/WSL, `where.exe` on native Windows.
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    await execFileAsync(finder, [command], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export type AvailableClis = Record<string, boolean>

/**
 * Detect which coding CLI tools are available on the system.
 * Checks the env-var-overridden command or the default command name.
 */
export async function detectAvailableClis(): Promise<AvailableClis> {
  const clis = [
    { name: 'claude', envVar: 'CLAUDE_CMD', defaultCmd: 'claude' },
    { name: 'codex', envVar: 'CODEX_CMD', defaultCmd: 'codex' },
    { name: 'opencode', envVar: 'OPENCODE_CMD', defaultCmd: 'opencode' },
    { name: 'gemini', envVar: 'GEMINI_CMD', defaultCmd: 'gemini' },
    { name: 'kimi', envVar: 'KIMI_CMD', defaultCmd: 'kimi' },
  ]

  const results = await Promise.all(
    clis.map(async (cli) => {
      const cmd = process.env[cli.envVar] || cli.defaultCmd
      const available = await isCommandAvailable(cmd)
      return [cli.name, available] as const
    })
  )

  return Object.fromEntries(results)
}
```

**Step 4: Augment `/api/platform` in `server/index.ts`**

Change the handler at line 207-210:

```typescript
app.get('/api/platform', async (_req, res) => {
  const [platform, availableClis] = await Promise.all([
    detectPlatform(),
    detectAvailableClis(),
  ])
  res.json({ platform, availableClis })
})
```

Import `detectAvailableClis` from `./platform.js`.

**Step 5: Run test to verify it passes**

Run: `npm test -- test/unit/server/platform.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add server/platform.ts server/index.ts test/unit/server/platform.test.ts
git commit -m "feat: detect CLI availability on server, include in /api/platform response"
```

---

## Task 2: Store CLI availability in client Redux

**Files:**
- Modify: `src/store/connectionSlice.ts`
- Modify: `src/App.tsx` (where `/api/platform` is fetched, ~line 192)
- Test: `test/unit/client/store/connectionSlice.test.ts` (create if needed, or add to existing)

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import connectionReducer, { setPlatform, setAvailableClis } from '@/store/connectionSlice'

describe('connectionSlice', () => {
  it('stores availableClis via setAvailableClis', () => {
    const state = connectionReducer(undefined, setAvailableClis({ claude: true, codex: false }))
    expect(state.availableClis).toEqual({ claude: true, codex: false })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/client/store/connectionSlice.test.ts`
Expected: FAIL — `setAvailableClis` not exported

**Step 3: Add `availableClis` to `ConnectionState`**

In `src/store/connectionSlice.ts`:

```typescript
export interface ConnectionState {
  status: ConnectionStatus
  lastError?: string
  lastReadyAt?: number
  platform: string | null
  availableClis: Record<string, boolean>
}

const initialState: ConnectionState = {
  status: 'disconnected',
  platform: null,
  availableClis: {},
}
```

Add the reducer:

```typescript
setAvailableClis: (state, action: PayloadAction<Record<string, boolean>>) => {
  state.availableClis = action.payload
},
```

Export it from the actions destructure.

**Step 4: Update `App.tsx` to dispatch `setAvailableClis`**

At ~line 192 where platform is fetched:

```typescript
const platformInfo = await api.get<{ platform: string; availableClis?: Record<string, boolean> }>('/api/platform')
if (!cancelled) {
  dispatch(setPlatform(platformInfo.platform))
  if (platformInfo.availableClis) {
    dispatch(setAvailableClis(platformInfo.availableClis))
  }
}
```

Import `setAvailableClis` from `@/store/connectionSlice`.

**Step 5: Run test to verify it passes**

Run: `npm test -- test/unit/client/store/connectionSlice.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/store/connectionSlice.ts src/App.tsx test/unit/client/store/connectionSlice.test.ts
git commit -m "feat: store CLI availability in Redux from /api/platform response"
```

---

## Task 3: Add `cwd` to per-provider settings type

**Files:**
- Modify: `src/store/types.ts:103-111` (`CodingCliSettings.providers` value type)
- Test: Type-level — no runtime test needed; verify by building

**Step 1: Add `cwd` to the provider settings type**

In `src/store/types.ts`, change the `providers` value type:

```typescript
export interface CodingCliSettings {
  enabledProviders: CodingCliProviderName[]
  providers: Partial<Record<CodingCliProviderName, {
    model?: string
    sandbox?: CodexSandboxMode
    permissionMode?: ClaudePermissionMode
    maxTurns?: number
    cwd?: string  // <-- add this
  }>>
}
```

**Step 2: Verify it builds**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/store/types.ts
git commit -m "feat: add cwd field to per-provider coding CLI settings type"
```

---

## Task 4: Add per-provider starting directory to Settings UI

**Files:**
- Modify: `src/components/SettingsView.tsx` (~line 658-735, Coding CLIs section)
- Test: `test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx` (new)

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer from '@/store/settingsSlice'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ valid: true }),
  },
}))

function createTestStore() {
  return configureStore({
    reducer: { settings: settingsReducer },
    preloadedState: {
      settings: {
        settings: {
          theme: 'system',
          uiScale: 1,
          terminal: { fontSize: 14, fontFamily: 'monospace', lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: 'auto' },
          safety: { autoKillIdleMinutes: 180, warnBeforeKillMinutes: 5 },
          sidebar: { sortMode: 'activity', showProjectBadges: true, width: 288, collapsed: false },
          panes: { defaultNewPane: 'ask' },
          codingCli: { enabledProviders: ['claude', 'codex'], providers: {} },
          logging: { debug: false },
        },
        loaded: true,
        lastSavedAt: Date.now(),
      },
    },
  })
}

describe('SettingsView coding CLI cwd', () => {
  afterEach(cleanup)

  it('renders starting directory inputs for configured providers', () => {
    const store = createTestStore()
    render(<Provider store={store}><SettingsView /></Provider>)
    expect(screen.getByLabelText(/Claude starting directory/i)).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx`
Expected: FAIL — no element with label "Claude starting directory"

**Step 3: Add starting directory inputs to SettingsView**

In the Coding CLIs section of `SettingsView.tsx`, inside the provider config loop (after the existing model/sandbox/permissionMode fields), add a `cwd` text input for each provider that has `CODING_CLI_PROVIDER_CONFIGS` entry. Use the same validation pattern as the existing "Default working directory" field (debounced `POST /api/files/validate-dir`).

For each provider in `CODING_CLI_PROVIDER_CONFIGS`:

```tsx
<SettingsRow label={`${provider.label} starting directory`}>
  <div className="relative w-full max-w-xs">
    <input
      type="text"
      aria-label={`${provider.label} starting directory`}
      value={providerCwdInputs[provider.name] ?? providerSettings.cwd ?? ''}
      placeholder="e.g. ~/projects/my-app"
      onChange={(e) => handleProviderCwdChange(provider.name, e.target.value)}
      className="w-full h-8 px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border"
    />
  </div>
</SettingsRow>
```

You'll need local state for the inputs (`providerCwdInputs`) and a debounced validation handler similar to `scheduleDefaultCwdValidation`. Use the same `POST /api/files/validate-dir` endpoint. On valid: save via `scheduleSave({ codingCli: { providers: { [name]: { cwd: value } } } })`. On empty: clear the cwd (`cwd: undefined`).

**Step 4: Run test to verify it passes**

Run: `npm test -- test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx
git commit -m "feat: add per-provider starting directory setting in Coding CLIs settings"
```

---

## Task 5: Add icon paths to provider config

**Files:**
- Modify: `src/lib/coding-cli-utils.ts`

**Step 1: Add `iconPath` to `CodingCliProviderConfig`**

```typescript
export type CodingCliProviderConfig = {
  name: CodingCliProviderName
  label: string
  iconPath?: string  // Path to SVG in assets/icons/
  supportsModel?: boolean
  supportsSandbox?: boolean
  supportsPermissionMode?: boolean
}
```

Update the configs:

```typescript
export const CODING_CLI_PROVIDER_CONFIGS: CodingCliProviderConfig[] = [
  {
    name: 'claude',
    label: CODING_CLI_PROVIDER_LABELS.claude,
    iconPath: '/icons/claude-code.svg',
    supportsPermissionMode: true,
  },
  {
    name: 'codex',
    label: CODING_CLI_PROVIDER_LABELS.codex,
    iconPath: '/icons/codex_openai.svg',
    supportsModel: true,
    supportsSandbox: true,
  },
]
```

Note: The SVGs are in `assets/icons/` which Vite serves. Check the actual public path — it may be `/assets/icons/` or just `/icons/` depending on Vite config. Verify by checking `config/vite/vite.config.ts` for `publicDir` or an alias.

**Step 2: Verify it builds**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/lib/coding-cli-utils.ts
git commit -m "feat: add iconPath to coding CLI provider configs"
```

---

## Task 6: Rewrite PanePicker with coding CLI options and scoped shortcuts

This is the main UI task. The picker order changes to: Claude, Codex, Editor, Browser, Shell(s).

**Files:**
- Modify: `src/components/panes/PanePicker.tsx` (full rewrite of options logic)
- Test: `test/unit/client/components/panes/PanePicker.test.tsx` (new)

**Step 1: Write the failing tests**

Create `test/unit/client/components/panes/PanePicker.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PanePicker from '@/components/panes/PanePicker'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'

vi.mock('lucide-react', () => ({
  Terminal: (props: any) => <svg data-testid="terminal-icon" {...props} />,
  Globe: (props: any) => <svg data-testid="globe-icon" {...props} />,
  FileText: (props: any) => <svg data-testid="file-text-icon" {...props} />,
}))

function createStore(overrides?: {
  platform?: string
  availableClis?: Record<string, boolean>
  enabledProviders?: string[]
}) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      connection: {
        status: 'ready' as const,
        platform: overrides?.platform ?? 'linux',
        availableClis: overrides?.availableClis ?? { claude: true, codex: true },
      },
      settings: {
        settings: {
          theme: 'system',
          uiScale: 1,
          terminal: { fontSize: 14, fontFamily: 'monospace', lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: 'auto' },
          safety: { autoKillIdleMinutes: 180, warnBeforeKillMinutes: 5 },
          sidebar: { sortMode: 'activity', showProjectBadges: true, width: 288, collapsed: false },
          panes: { defaultNewPane: 'ask' },
          codingCli: {
            enabledProviders: (overrides?.enabledProviders ?? ['claude', 'codex']) as any[],
            providers: {},
          },
          logging: { debug: false },
        },
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

describe('PanePicker', () => {
  afterEach(cleanup)

  it('shows Claude and Codex buttons when available and enabled', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <PanePicker onSelect={vi.fn()} onCancel={vi.fn()} isOnlyPane={false} />
      </Provider>
    )
    expect(screen.getByRole('button', { name: /claude/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /codex/i })).toBeInTheDocument()
  })

  it('hides Claude when not available on system', () => {
    const store = createStore({ availableClis: { claude: false, codex: true } })
    render(
      <Provider store={store}>
        <PanePicker onSelect={vi.fn()} onCancel={vi.fn()} isOnlyPane={false} />
      </Provider>
    )
    expect(screen.queryByRole('button', { name: /claude/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /codex/i })).toBeInTheDocument()
  })

  it('hides Codex when disabled in settings', () => {
    const store = createStore({ enabledProviders: ['claude'] })
    render(
      <Provider store={store}>
        <PanePicker onSelect={vi.fn()} onCancel={vi.fn()} isOnlyPane={false} />
      </Provider>
    )
    expect(screen.getByRole('button', { name: /claude/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /codex/i })).not.toBeInTheDocument()
  })

  it('renders options in correct order: Claude, Codex, Editor, Browser, Shell', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <PanePicker onSelect={vi.fn()} onCancel={vi.fn()} isOnlyPane={false} />
      </Provider>
    )
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map(b => b.textContent?.trim().replace(/\s+/g, ' '))
    // Expect: Claude, Codex, Editor, Browser, Shell (labels contain the name)
    expect(labels[0]).toMatch(/Claude/)
    expect(labels[1]).toMatch(/Codex/)
    expect(labels[2]).toMatch(/Editor/)
    expect(labels[3]).toMatch(/Browser/)
    expect(labels[4]).toMatch(/Shell/)
  })

  it('on Windows shows CMD/PowerShell/WSL instead of Shell', () => {
    const store = createStore({ platform: 'win32' })
    render(
      <Provider store={store}>
        <PanePicker onSelect={vi.fn()} onCancel={vi.fn()} isOnlyPane={false} />
      </Provider>
    )
    expect(screen.queryByRole('button', { name: /^Shell/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /CMD/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /PowerShell/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /WSL/i })).toBeInTheDocument()
  })

  it('calls onSelect with "claude" when Claude button is clicked', () => {
    const onSelect = vi.fn()
    const store = createStore()
    render(
      <Provider store={store}>
        <PanePicker onSelect={onSelect} onCancel={vi.fn()} isOnlyPane={false} />
      </Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: /claude/i }))
    // onSelect fires after fade animation, so we check pending selection logic
    // For unit test, fire transitionEnd to trigger
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/client/components/panes/PanePicker.test.tsx`
Expected: FAIL

**Step 3: Rewrite PanePicker**

Key changes:
1. **PaneType union** expands: add `'claude' | 'codex'` (and potentially other CLI names)
2. **PickerOption** `icon` field becomes `icon: typeof Terminal | string` — string for SVG path, component for Lucide
3. **Options are built dynamically:**
   - Read `enabledProviders` from `useAppSelector(s => s.settings.settings?.codingCli?.enabledProviders ?? [])`
   - Read `availableClis` from `useAppSelector(s => s.connection.availableClis)`
   - For each provider in `CODING_CLI_PROVIDER_CONFIGS` that is both enabled AND available, add an option
   - Then add Editor, Browser, then shell options (platform-dependent)
4. **Shortcut keys scoped:** Replace `document.addEventListener('keydown', ...)` with an `onKeyDown` handler on the picker container `<div>`, and add `tabIndex={0}` + `autoFocus` via a `useEffect` ref focus. This ensures shortcuts only fire when the picker div has focus. If focus moves to another pane (e.g., a terminal in a split), the shortcuts stop firing.
5. **Icon rendering:** For string `icon` values, render `<img src={icon} className="..." alt={label} />`. For component values, render `<option.icon className="..." />`.

**Shortcut assignments:**
- Claude: `L` (C conflicts with CMD on Windows; L for cLaude is unambiguous)
- Codex: `X`
- Editor: `E`
- Browser: `B`
- Shell: `S` / CMD: `C` / PowerShell: `P` / WSL: `W`

**Step 4: Run tests to verify they pass**

Run: `npm test -- test/unit/client/components/panes/PanePicker.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PanePicker.tsx test/unit/client/components/panes/PanePicker.test.tsx
git commit -m "feat: add coding CLI options to pane picker with scoped shortcuts"
```

---

## Task 7: Update PickerWrapper to handle CLI selections

When the user picks `'claude'` or `'codex'`, `PickerWrapper` must create terminal content with `mode: '<provider>'`, the configured shell (from settings on Windows, `'system'` otherwise), and the provider's `cwd` if set.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx:126-212` (`PickerWrapper`)
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx` (add cases)

**Step 1: Write the failing test**

Add to the existing `PaneContainer.test.tsx`:

```typescript
it('creates claude terminal pane when picker selects claude', () => {
  // Render a picker pane, simulate selection, verify dispatched content
  // has kind: 'terminal', mode: 'claude', shell: 'system'
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/client/components/panes/PaneContainer.test.tsx`
Expected: FAIL

**Step 3: Add CLI cases to PickerWrapper**

In `PickerWrapper.handleSelect`, the type parameter needs to accept CLI names. For any type that matches a `CodingCliProviderName`:

```typescript
import { isCodingCliProviderName } from '@/lib/coding-cli-utils'

// Inside handleSelect:
if (isCodingCliProviderName(type)) {
  const providerCwd = settings?.codingCli?.providers?.[type]?.cwd
  newContent = {
    kind: 'terminal',
    mode: type,
    shell: 'system',  // server resolves based on platform + WINDOWS_SHELL env
    createRequestId: nanoid(),
    status: 'creating',
    initialCwd: providerCwd || undefined,
  }
} else {
  // existing switch for shell/cmd/powershell/wsl/browser/editor
}
```

Read settings from Redux: `const settings = useAppSelector(s => s.settings.settings)`.

The `PaneType` type in `PanePicker.tsx` must be updated to include CLI provider names — or use a string union. Update the `onSelect` prop type to `(type: string) => void` and validate in the handler. Or better: define a shared type.

**Step 4: Run tests to verify they pass**

Run: `npm test -- test/unit/client/components/panes/PaneContainer.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "feat: PickerWrapper creates CLI terminal panes with provider cwd"
```

---

## Task 8: Pass provider cwd through terminal creation

When a CLI terminal is created with `initialCwd`, the server must use it. This already works — `TerminalPaneContent` has `initialCwd` and `ws-handler.ts` passes `cwd` to `registry.create()`. Verify the flow works end-to-end by checking ws-handler's `terminal.create` handling.

**Files:**
- Verify: `server/ws-handler.ts` (the terminal.create handler)
- Test: `test/unit/server/terminal-registry.test.ts` (verify cwd is used when creating CLI terminals)

**Step 1: Read ws-handler terminal.create to confirm cwd passthrough**

Look at ws-handler.ts around line 696+ where `terminal.create` is handled. Confirm it reads `m.cwd` and passes it to `registry.create({ cwd: m.cwd })`. If it does, this task is just verification. If not, add the passthrough.

**Step 2: Write a test if needed**

If the cwd field already flows through, add a quick smoke test confirming a CLI terminal created with a specific cwd uses it:

```typescript
it('uses provided cwd for CLI terminal creation', () => {
  const term = registry.create({ mode: 'claude', cwd: '/tmp/test-project', shell: 'system' })
  expect(term.cwd).toBe('/tmp/test-project')
})
```

**Step 3: Run tests**

Run: `npm test -- test/unit/server/terminal-registry.test.ts`
Expected: PASS

**Step 4: Commit (if any changes)**

```bash
git add server/ws-handler.ts test/unit/server/terminal-registry.test.ts
git commit -m "test: verify provider cwd flows through terminal creation"
```

---

## Task 9: Verify SVG icon serving

Make sure the SVG files at `assets/icons/claude-code.svg` and `assets/icons/codex_openai.svg` are accessible from the browser at the paths used in Task 5's `iconPath`.

**Files:**
- Check: `config/vite/vite.config.ts` for `publicDir` setting
- Check: `server/index.ts` for static file serving in production

**Step 1: Investigate**

Read `config/vite/vite.config.ts` and check if `assets/` or `assets/icons/` is included in the public dir or served statically. In dev mode Vite serves `public/` by default. The icons are in `assets/icons/` — if that's not the public dir, they won't be served.

Options:
- Move the SVGs to `public/icons/`
- Or add a Vite alias / static serving route
- Or import the SVGs as modules in the component (Vite handles SVG imports)

The cleanest approach: **import SVGs as URLs** in `coding-cli-utils.ts`:

```typescript
import claudeIcon from '../../assets/icons/claude-code.svg'
import codexIcon from '../../assets/icons/codex_openai.svg'
```

Then use the imported URL string as `iconPath`. Vite resolves these to hashed URLs in production builds.

Alternatively, if `coding-cli-utils.ts` is shared between client and server, use `public/icons/` instead. Check if the file is imported server-side anywhere.

**Step 2: Implement the chosen approach**

If client-only: use Vite SVG imports in PanePicker directly.
If shared: copy SVGs to `public/icons/` and reference as `/icons/claude-code.svg`.

**Step 3: Verify in dev mode**

Run: `npm run dev:client`
Open browser, navigate to the icon URL, confirm it renders.

**Step 4: Commit**

```bash
git add <moved/modified files>
git commit -m "feat: ensure CLI icons are served and accessible to PanePicker"
```

---

## Task 10: Fix existing shortcut scoping bug

The current PanePicker shortcuts (`S`, `B`, `E`, `C`, `P`, `W`) use `document.addEventListener` and fire even when typing in a terminal in another pane. This was noted during brainstorming. Fix it.

This is already handled in Task 6 (replacing `document.addEventListener` with `onKeyDown` on the picker container), but verify the fix doesn't break existing tests.

**Files:**
- Already modified in Task 6: `src/components/panes/PanePicker.tsx`
- Test: verify in `test/unit/client/components/panes/PanePicker.test.tsx`

**Step 1: Write the test**

```typescript
it('does not fire shortcuts when picker is not focused', () => {
  const onSelect = vi.fn()
  const store = createStore()
  render(
    <Provider store={store}>
      <div>
        <PanePicker onSelect={onSelect} onCancel={vi.fn()} isOnlyPane={false} />
        <input data-testid="other-input" />
      </div>
    </Provider>
  )
  // Focus the other input, then press 'S'
  const otherInput = screen.getByTestId('other-input')
  otherInput.focus()
  fireEvent.keyDown(otherInput, { key: 's' })
  // Picker should NOT have fired
  expect(onSelect).not.toHaveBeenCalled()
})
```

**Step 2: Run test**

Run: `npm test -- test/unit/client/components/panes/PanePicker.test.tsx`
Expected: PASS (since Task 6 already scoped shortcuts)

**Step 3: Commit (if separate)**

This should already be committed as part of Task 6. If not:

```bash
git add src/components/panes/PanePicker.tsx test/unit/client/components/panes/PanePicker.test.tsx
git commit -m "fix: scope pane picker keyboard shortcuts to picker focus"
```

---

## Task 11: Integration test — full flow

**Files:**
- Test: `test/integration/pane-picker-cli.test.ts` (new)

**Step 1: Write integration test**

Test that:
1. `/api/platform` returns `availableClis` object
2. A `terminal.create` message with `mode: 'claude'` successfully creates a terminal (or fails gracefully if Claude isn't installed — mock the spawn)

Use the existing integration test patterns from `test/integration/`.

**Step 2: Run test**

Run: `npm test -- test/integration/pane-picker-cli.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/integration/pane-picker-cli.test.ts
git commit -m "test: integration test for CLI options in pane picker"
```

---

## Task 12: Run full test suite and fix regressions

**Step 1: Run all tests**

Run: `npm test`

**Step 2: Fix any failures**

Likely areas: existing tests that assert exact option counts in PanePicker or exact order, settings tests that don't include the new `codingCli` state shape.

**Step 3: Run lint**

Run: `npm run lint`

Fix any a11y violations (e.g., `img` tags for SVG icons need `alt` text, buttons need labels).

**Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: address test regressions and lint issues from pane picker CLI feature"
```
