# CLI Extensions Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Create an `extensions/` folder in the repo where dropping a folder with a `freshell.json` manifest adds a new CLI pane type, and refactor Claude Code and Codex CLI to be the first two extensions using this system.

**Architecture:** The extension system infrastructure (ExtensionManager, manifests, routes, ExtensionPane) already exists. CLI extensions currently use a parallel hardcoded system: `TerminalMode` enum in `server/terminal-registry.ts`, `CodingCliProviderSchema` in `shared/ws-protocol.ts`, `CODING_CLI_PROVIDER_CONFIGS` in `src/lib/coding-cli-utils.ts`, `CLI_COMMANDS` in `server/platform.ts`, and `CODING_CLI_COMMANDS` in `server/terminal-registry.ts`. This refactoring creates `extensions/claude-code/` and `extensions/codex-cli/` folders with `freshell.json` manifests, then rewires the server to derive CLI availability, spawn commands, picker visibility, and terminal modes from the extension registry instead of hardcoded lists. The frontend PanePicker already renders extension entries; CLI extensions need to create terminal panes (kind: 'terminal') rather than extension panes (kind: 'extension'), which requires a small routing change.

**Tech Stack:** TypeScript, Zod (manifest validation), Node.js (server), React/Redux (client), Vitest (testing)

**Testing strategy:** No unit tests only. Full E2E validation through the live UI on port :5173 -- open Chrome, create Claude and Codex panes, exchange messages, close and reopen them, and verify the full UX works correctly.

---

## Analysis: What Changes and What Stays

### The central file: `server/terminal-registry.ts`

**`server/terminal-registry.ts`** is the authoritative location for PTY lifecycle management and spawn logic. It is imported by `server/ws-handler.ts` and is the only file used in production. It contains:

- `TerminalMode` type (line 33): `'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'`
- `CodingCliCommandSpec` type (line 36): includes `label`, `envVar`, `defaultCommand`, `resumeArgs`, and `supportsPermissionMode`
- `CODING_CLI_COMMANDS` record (line 44): `Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec>` -- maps mode names to spawn specs
- `resolveCodingCliCommand()` (line 205): accepts `mode`, `resumeSessionId`, `target`, and `providerSettings` params
- `buildSpawnSpec()` (line 622): constructs PTY spawn arguments from mode, cwd, shell, etc.
- `TerminalRegistry` class (line 792): manages PTY processes, constructed with `(settings?, maxTerminals?, maxExitedTerminals?)`
- `modeSupportsResume()` (line 79): checks if a mode has `resumeArgs`
- `getModeLabel()` (line 233): returns display label for a mode

**Note:** `server/spawn-spec.ts` exists but is dead code -- it is never imported by any production or test file. All references in this plan target `server/terminal-registry.ts`.

### Other hardcoded CLI registrations

1. **`server/platform.ts` - `CLI_COMMANDS` array** (line 95): detects which CLIs are available on the system (e.g., `which claude`). Feeds `availableClis` to the frontend.

2. **`shared/ws-protocol.ts` - `TerminalCreateSchema.mode`** (line 170): Zod enum `z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi'])` used for WS message validation.

3. **`src/lib/coding-cli-utils.ts` - `CODING_CLI_PROVIDER_CONFIGS`** -- frontend config for picker display.

### What stays unchanged (session indexing, providers)

The `server/coding-cli/` directory (session-indexer.ts, session-manager.ts, providers/claude.ts, providers/codex.ts, types.ts, utils.ts) handles session file parsing, JSONL indexing, and streaming JSON output. This is **orthogonal** to the extension system -- it's about understanding session history, not about spawning or picking CLI panes. These files stay as-is.

### Type strategy: preserving type safety

The `TerminalMode` type is a union of string literals that types the `CODING_CLI_COMMANDS` record via `Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec>`. Widening `TerminalMode` to `string` would break this record's type safety -- `Exclude<string, 'shell'>` is `string`, making the record accept arbitrary keys and lose compile-time exhaustiveness checking.

**Solution:** Keep `TerminalMode` as the hardcoded union for internal type safety. Introduce a separate wider type, `TerminalModeOrExtension` (= `TerminalMode | string`), for API boundaries where extension modes need to pass through. The functions that can handle extension modes (`resolveCodingCliCommand`, `buildSpawnSpec`, `modeSupportsResume`, `getModeLabel`, `TerminalRegistry.create`) accept the wider type but the `CODING_CLI_COMMANDS` record retains its strict typing.

### WS protocol validation strategy

The `TerminalCreateSchema.mode` field currently uses `z.enum(...)`, which rejects unknown modes at parse time. Changing to `z.string()` would silently accept typos and garbage. Instead, we dynamically build the set of valid modes from the hardcoded list plus registered CLI extensions, and use `z.string().refine()` to validate against it. The ws-handler already builds its own `ClientMessageSchema` at module level (line 238 of ws-handler.ts), so we move the schema construction to a factory that accepts the set of valid modes.

### Key insight: CLI extensions create terminal panes, not extension panes

When the user selects a CLI extension from the picker, it should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`, NOT an `ExtensionPaneContent` (kind: 'extension'). CLI extensions use the existing terminal infrastructure (xterm.js, PTY, scrollback buffer). This is already how Claude/Codex work -- they're terminal panes with `mode: 'claude'` or `mode: 'codex'`.

---

### Task 1: Create extension manifest files for Claude Code and Codex CLI

**Files:**
- Create: `extensions/claude-code/freshell.json`
- Create: `extensions/claude-code/icon.svg`
- Create: `extensions/codex-cli/freshell.json`
- Create: `extensions/codex-cli/icon.svg`

**Step 1: Create Claude Code extension manifest**

Create `extensions/claude-code/freshell.json`:
```json
{
  "name": "claude",
  "version": "1.0.0",
  "label": "Claude Code",
  "description": "Anthropic's Claude Code CLI agent",
  "category": "cli",
  "icon": "./icon.svg",
  "cli": {
    "command": "claude",
    "args": [],
    "env": {
      "CLAUDE_CMD": "claude"
    }
  },
  "picker": {
    "shortcut": "L",
    "group": "agents"
  }
}
```

Create `extensions/claude-code/icon.svg` with the Claude icon (the existing provider icon SVG).

**Step 2: Create Codex CLI extension manifest**

Create `extensions/codex-cli/freshell.json`:
```json
{
  "name": "codex",
  "version": "1.0.0",
  "label": "Codex CLI",
  "description": "OpenAI's Codex CLI agent",
  "category": "cli",
  "icon": "./icon.svg",
  "cli": {
    "command": "codex",
    "args": [],
    "env": {
      "CODEX_CMD": "codex"
    }
  },
  "picker": {
    "shortcut": "X",
    "group": "agents"
  }
}
```

Create `extensions/codex-cli/icon.svg` with the Codex icon.

**Step 3: Verify manifests are valid**

Run the existing extension manifest validation in a quick test:
```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import fs from 'fs';
import { ExtensionManifestSchema } from './server/extension-manifest.js';
for (const dir of ['extensions/claude-code', 'extensions/codex-cli']) {
  const raw = JSON.parse(fs.readFileSync(dir + '/freshell.json', 'utf-8'));
  const result = ExtensionManifestSchema.safeParse(raw);
  console.log(dir, result.success ? 'VALID' : result.error.format());
}
"
```

**Step 4: Commit**

```bash
git add extensions/
git commit -m "feat: add CLI extension manifests for Claude Code and Codex CLI"
```

---

### Task 2: Add repo-local extensions directory to scan path

**Files:**
- Modify: `server/index.ts` (lines ~146-148)

**Step 1: Add the repo extensions directory as a scan source**

In `server/index.ts`, the extension scan currently uses two directories:
```typescript
const userExtDir = path.join(os.homedir(), '.freshell', 'extensions')
const localExtDir = path.join(process.cwd(), '.freshell', 'extensions')
extensionManager.scan([userExtDir, localExtDir])
```

Add the repo `extensions/` directory as a third source, scanned first (lowest priority -- user overrides win):
```typescript
const userExtDir = path.join(os.homedir(), '.freshell', 'extensions')
const localExtDir = path.join(process.cwd(), '.freshell', 'extensions')
const builtinExtDir = path.join(process.cwd(), 'extensions')
extensionManager.scan([userExtDir, localExtDir, builtinExtDir])
```

**Step 2: Verify scan picks up the new extensions**

Start a dev server and check logs for "Extension scan complete" with claude and codex in the names list. Or run:
```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import { ExtensionManager } from './server/extension-manager.js';
const mgr = new ExtensionManager();
mgr.scan(['./extensions']);
console.log('Found:', mgr.getAll().map(e => e.manifest.name));
"
```

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: scan repo extensions/ directory for built-in CLI extensions"
```

---

### Task 3: Derive CLI availability from extension registry

Currently, `server/platform.ts` has a hardcoded `CLI_COMMANDS` array. After this task, CLI availability detection will also check registered CLI extensions from the ExtensionManager.

**Files:**
- Modify: `server/platform.ts` - `detectAvailableClis()` function
- Modify: `server/index.ts` - pass CLI extension data to platform detection

**Step 1: Modify `detectAvailableClis` to accept additional CLI specs**

The codebase uses dependency injection via function arguments (see `createPlatformRouter`, `createExtensionRouter`). Follow the same pattern: pass extra CLI specs as a parameter.

In `server/platform.ts`, modify `detectAvailableClis` to accept an optional parameter:

```typescript
export async function detectAvailableClis(
  extraClis?: Array<{ name: string; command: string }>
): Promise<AvailableClis> {
  const allClis: Array<{ name: string; envVar: string; defaultCmd: string }> = [
    ...CLI_COMMANDS,
    ...(extraClis ?? []).map(c => ({ name: c.name, envVar: '', defaultCmd: c.command })),
  ]
  // Deduplicate by name (hardcoded wins for existing entries)
  const seen = new Set<string>()
  const dedupedClis = allClis.filter(cli => {
    if (seen.has(cli.name)) return false
    seen.add(cli.name)
    return true
  })
  const results = await Promise.all(
    dedupedClis.map(async (cli) => {
      const cmd = cli.envVar ? (process.env[cli.envVar] || cli.defaultCmd) : cli.defaultCmd
      const available = await isCommandAvailable(cmd)
      return [cli.name, available] as const
    })
  )
  return Object.fromEntries(results)
}
```

**Step 2: In `server/index.ts`, build the extra CLIs list from the extension registry**

Where `detectAvailableClis` is passed to the platform router deps, extract CLI extension data and pass it:

```typescript
const cliExtensions = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli')
  .map(e => ({ name: e.manifest.name, command: e.manifest.cli!.command }))

// In the platform router deps:
detectAvailableClis: () => detectAvailableClis(cliExtensions),
```

Also do the same where `detectAvailableClis` is called in `server/routes/settings.ts` (line 75).

**Step 3: Commit**

```bash
git add server/platform.ts server/index.ts server/routes/settings.ts
git commit -m "feat: derive CLI availability from extension registry"
```

---

### Task 4: Introduce `TerminalModeOrExtension` type and add extension fallback to spawn resolution

The central file for spawn logic is **`server/terminal-registry.ts`** (not `spawn-spec.ts`, which is dead code). The `CODING_CLI_COMMANDS` record is typed as `Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec>`. We must **not** widen `TerminalMode` to `string` because that would make `Exclude<TerminalMode, 'shell'>` collapse to `string`, breaking the record's type safety.

Instead, introduce a wider type for API boundaries and pass the extension manager as a parameter (following the codebase's dependency injection pattern).

**Files:**
- Modify: `server/terminal-registry.ts` - add `TerminalModeOrExtension` type, modify `resolveCodingCliCommand`, `buildSpawnSpec`, `modeSupportsResume`, `getModeLabel`, and `TerminalRegistry.create` to accept extension CLIs via injected data

**Step 1: Add the wider type and CLI extension lookup interface**

At the top of `server/terminal-registry.ts`, after the existing `TerminalMode` type:

```typescript
// TerminalMode stays as the hardcoded union for type-safe CODING_CLI_COMMANDS indexing.
export type TerminalMode = 'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'

// Wider type for API boundaries where extension-provided modes pass through.
export type TerminalModeOrExtension = TerminalMode | (string & {})

/**
 * Minimal CLI extension data needed for spawn resolution.
 * Decouples terminal-registry from the full ExtensionManager type.
 */
export interface CliExtensionSpec {
  name: string
  label: string
  command: string
  args?: string[]
  env?: Record<string, string>
}
```

**Step 2: Modify `resolveCodingCliCommand` to accept extension fallback data**

Change the function signature to accept `TerminalModeOrExtension` and an optional `cliExtensions` array. Use `CODING_CLI_COMMANDS` for known modes, fall back to extensions for unknown modes:

```typescript
function resolveCodingCliCommand(
  mode: TerminalModeOrExtension,
  resumeSessionId?: string,
  target: ProviderTarget = 'unix',
  providerSettings?: ProviderSettings,
  cliExtensions?: CliExtensionSpec[],
) {
  if (mode === 'shell') return null

  // Check hardcoded specs first (type-safe indexing)
  const knownMode = mode as TerminalMode
  const spec = mode !== 'shell' ? CODING_CLI_COMMANDS[knownMode as Exclude<TerminalMode, 'shell'>] : undefined
  if (spec) {
    const command = process.env[spec.envVar] || spec.defaultCommand
    const providerArgs = providerNotificationArgs(knownMode, target)
    let resumeArgs: string[] = []
    if (resumeSessionId) {
      if (spec.resumeArgs) {
        resumeArgs = spec.resumeArgs(resumeSessionId)
      } else {
        logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
      }
    }
    const settingsArgs: string[] = []
    if (spec.supportsPermissionMode && providerSettings?.permissionMode && providerSettings.permissionMode !== 'default') {
      settingsArgs.push('--permission-mode', providerSettings.permissionMode)
    }
    return { command, args: [...providerArgs, ...settingsArgs, ...resumeArgs], label: spec.label }
  }

  // Fall back to CLI extension specs
  if (cliExtensions) {
    const ext = cliExtensions.find(e => e.name === mode)
    if (ext) {
      const envVarName = `${mode.toUpperCase()}_CMD`
      const command = process.env[envVarName] || ext.command
      return { command, args: ext.args || [], label: ext.label }
    }
  }

  return null
}
```

**Step 3: Modify `buildSpawnSpec` to accept and pass through extension data**

Change `buildSpawnSpec` signature to use `TerminalModeOrExtension` and accept `cliExtensions`:

```typescript
export function buildSpawnSpec(
  mode: TerminalModeOrExtension,
  cwd: string | undefined,
  shell: ShellType,
  resumeSessionId?: string,
  providerSettings?: ProviderSettings,
  envOverrides?: Record<string, string>,
  cliExtensions?: CliExtensionSpec[],
) {
  // ... existing body unchanged, except pass cliExtensions to resolveCodingCliCommand calls:
  // Change: resolveCodingCliCommand(mode, normalizedResume, 'unix', providerSettings)
  // To:     resolveCodingCliCommand(mode, normalizedResume, 'unix', providerSettings, cliExtensions)
  // (same for 'windows' calls)
}
```

**Step 4: Modify `modeSupportsResume` and `getModeLabel` to use the wider type**

```typescript
export function modeSupportsResume(mode: TerminalModeOrExtension): boolean {
  if (mode === 'shell') return false
  const spec = CODING_CLI_COMMANDS[mode as Exclude<TerminalMode, 'shell'>]
  return !!spec?.resumeArgs
}

function getModeLabel(mode: TerminalModeOrExtension, cliExtensions?: CliExtensionSpec[]): string {
  if (mode === 'shell') return 'Shell'
  const spec = CODING_CLI_COMMANDS[mode as Exclude<TerminalMode, 'shell'>]
  if (spec) return spec.label
  const ext = cliExtensions?.find(e => e.name === mode)
  if (ext) return ext.label
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}
```

**Step 5: Modify `TerminalRegistry` to accept CLI extension specs via constructor injection**

Add a `cliExtensions` field to `TerminalRegistry`, populated via the constructor:

```typescript
export class TerminalRegistry extends EventEmitter {
  // ... existing fields ...
  private cliExtensions: CliExtensionSpec[]

  constructor(settings?: AppSettings, maxTerminals?: number, maxExitedTerminals?: number, cliExtensions?: CliExtensionSpec[]) {
    super()
    // ... existing init ...
    this.cliExtensions = cliExtensions ?? []
  }
```

In the `create` method, pass `cliExtensions` to `buildSpawnSpec` and `getModeLabel`:

```typescript
  create(opts: {
    mode: TerminalModeOrExtension  // was TerminalMode
    // ... rest unchanged
  }): TerminalRecord {
    // ... existing code ...
    const { file, args, env, cwd: procCwd } = buildSpawnSpec(
      opts.mode,
      cwd,
      opts.shell || 'system',
      normalizedResume,
      opts.providerSettings,
      baseEnv,
      this.cliExtensions,  // NEW parameter
    )
    // ...
    const title = getModeLabel(opts.mode, this.cliExtensions)  // pass extensions
    // ...
  }
```

**Step 6: Update `server/index.ts` to pass CLI extensions to TerminalRegistry**

```typescript
const cliExtensions: CliExtensionSpec[] = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli')
  .map(e => ({
    name: e.manifest.name,
    label: e.manifest.label,
    command: e.manifest.cli!.command,
    args: e.manifest.cli!.args,
    env: e.manifest.cli!.env,
  }))

const registry = new TerminalRegistry(settings, undefined, undefined, cliExtensions)
```

**Step 7: Commit**

```bash
git add server/terminal-registry.ts server/index.ts
git commit -m "feat: resolve spawn commands from CLI extension manifests via DI"
```

---

### Task 5: Make TerminalCreateSchema accept dynamic CLI extension modes with validation

Currently, `TerminalCreateSchema.mode` is a hardcoded Zod enum: `z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi'])`. New CLI extensions added via the extensions folder won't pass validation. Changing to `z.string()` would silently accept typos and garbage.

**Solution:** Use a factory function that builds the `TerminalCreateSchema` with a dynamically-computed set of valid modes. The ws-handler already constructs its own `ClientMessageSchema` at module level; we move this to a factory that runs at `WsHandler` construction time, when the extension manager is available.

**Files:**
- Modify: `shared/ws-protocol.ts` - export a factory function for building `TerminalCreateSchema` with extra modes
- Modify: `server/ws-handler.ts` - build `ClientMessageSchema` at construction time using the factory

**Step 1: Add `createTerminalCreateSchema` factory to `shared/ws-protocol.ts`**

Keep the existing `TerminalCreateSchema` as-is for backward compatibility (tests, client code). Add a factory:

```typescript
/** Built-in terminal modes that are always valid. */
const BUILTIN_TERMINAL_MODES = ['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi'] as const

/**
 * Build a TerminalCreateSchema that accepts the built-in modes plus
 * any additional modes (e.g., from registered CLI extensions).
 *
 * The returned schema uses z.string().refine() to validate that the mode
 * is in the combined set, rejecting typos and garbage while allowing
 * dynamically-registered extension names.
 */
export function createTerminalCreateSchema(extraModes: string[] = []) {
  const allModes = new Set<string>([...BUILTIN_TERMINAL_MODES, ...extraModes])
  return z.object({
    type: z.literal('terminal.create'),
    requestId: z.string().min(1),
    mode: z.string().default('shell').refine(
      (val) => allModes.has(val),
      (val) => ({ message: `Invalid terminal mode: '${val}'. Valid modes: ${[...allModes].join(', ')}` }),
    ),
    shell: ShellSchema.default('system'),
    cwd: z.string().optional(),
    resumeSessionId: z.string().optional(),
    restore: z.boolean().optional(),
    tabId: z.string().min(1).optional(),
    paneId: z.string().min(1).optional(),
  })
}
```

**Step 2: In `server/ws-handler.ts`, build `ClientMessageSchema` dynamically**

Currently, `ClientMessageSchema` is a module-level `const` (line 238). Move it to a factory method or build it in the `WsHandler` constructor.

Change the module-level `ClientMessageSchema` to a function:

```typescript
function buildClientMessageSchema(extensionModes: string[]) {
  const terminalCreate = createTerminalCreateSchema(extensionModes)
  return z.discriminatedUnion('type', [
    HelloSchema,
    PingSchema,
    terminalCreate,
    TerminalAttachSchema,
    // ... rest of the schemas unchanged
  ])
}
```

In the `WsHandler` constructor (which already receives `extensionManager`), build the schema:

```typescript
class WsHandler {
  private clientMessageSchema: z.ZodDiscriminatedUnion<...>

  constructor(
    // ... existing params including extensionManager ...
  ) {
    // ...
    const extensionModes = extensionManager
      ? extensionManager.getAll()
          .filter(e => e.manifest.category === 'cli')
          .map(e => e.manifest.name)
      : []
    this.clientMessageSchema = buildClientMessageSchema(extensionModes)
  }
```

Then change the message parsing call (line ~1086) from `ClientMessageSchema.safeParse(msg)` to `this.clientMessageSchema.safeParse(msg)`.

**Step 3: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts
git commit -m "feat: dynamically validate terminal.create mode against registered CLI extensions"
```

---

### Task 6: Wire CLI extensions into PanePicker selection flow

Currently, when a CLI extension (`ext:name`) is selected from the PanePicker, it creates an `ExtensionPaneContent` (kind: 'extension'). But CLI extensions should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` - route CLI extensions to terminal pane creation
- Modify: `src/components/panes/PanePicker.tsx` - route CLI extensions through the directory picker

**Step 1: In PaneContainer.tsx, handle CLI extensions in createContentForType**

Before the generic `ext:` handler, add a check for CLI extensions. The `extensionEntries` selector is already used in PanePicker; add it to PaneContainer too:

```typescript
const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? [])
```

Then in `createContentForType`:

```typescript
const createContentForType = useCallback((type: PanePickerType, cwd?: string): PaneContent => {
  if (typeof type === 'string' && type.startsWith('ext:')) {
    const extensionName = type.slice(4)
    // Check if this is a CLI extension - if so, create a terminal pane
    const ext = extensionEntries.find(e => e.name === extensionName)
    if (ext?.category === 'cli') {
      return {
        kind: 'terminal' as const,
        mode: extensionName as TabMode,
        shell: 'system' as const,
        createRequestId: nanoid(),
        status: 'creating' as const,
        ...(cwd ? { initialCwd: cwd } : {}),
      }
    }
    return {
      kind: 'extension' as const,
      extensionName,
      props: {},
    }
  }
  // ... rest of existing cases unchanged
}, [extensionEntries, settings])
```

**Step 2: In PanePicker.tsx `handleSelect`, route CLI extensions through the directory picker**

Currently, extension options go straight to content creation. CLI extensions need to go through the directory picker (just like hardcoded CLI options do):

```typescript
const handleSelect = useCallback((type: PanePickerType) => {
  // ... existing agent-chat check ...
  // ... existing coding-cli check ...

  // CLI extensions also go through directory picker
  if (typeof type === 'string' && type.startsWith('ext:')) {
    const extensionName = type.slice(4)
    const ext = extensionEntries.find(e => e.name === extensionName)
    if (ext?.category === 'cli') {
      setStep({ step: 'directory', providerType: type })
      return
    }
  }

  const newContent = createContentForType(type)
  dispatch(updatePaneContent({ tabId, paneId, content: newContent }))
}, [createContentForType, dispatch, tabId, paneId, extensionEntries])
```

**Step 3: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/panes/PanePicker.tsx
git commit -m "feat: route CLI extensions through terminal pane creation with directory picker"
```

---

### Task 7: Update frontend type system for dynamic CLI modes

The frontend `TabMode` type is currently `'shell' | CodingCliProviderName` which is a fixed enum. For CLI extensions to work, the frontend needs a wider type at its API boundaries, but internal code should continue to benefit from the known union.

**Files:**
- Modify: `src/store/types.ts` - add `TabModeOrExtension` alongside existing `TabMode`
- Modify: `src/lib/coding-cli-utils.ts` - update `getProviderLabel` fallback

**Step 1: Add the wider type alongside TabMode**

In `src/store/types.ts`:
```typescript
// TabMode includes 'shell' for regular terminals, plus known coding CLI providers.
// This stays as a strict union for type safety in hardcoded provider checks.
export type TabMode = 'shell' | CodingCliProviderName

// Wider type for pane content and WS messages where extension-provided modes pass through.
export type TabModeOrExtension = TabMode | (string & {})
```

Update the `TerminalPaneContent` type in `src/store/paneTypes.ts` to use the wider type for its `mode` field:

```typescript
export type TerminalPaneContent = {
  kind: 'terminal'
  // ...
  mode: TabModeOrExtension  // was TabMode -- allows extension CLI modes
  // ...
}
```

The `Tab` interface in `src/store/types.ts` also has a `mode: TabMode` field; widen it to `TabModeOrExtension`.

**Step 2: Update `getProviderLabel` to gracefully handle extension modes**

In `src/lib/coding-cli-utils.ts`, `getProviderLabel` currently returns `provider.toUpperCase()` as fallback. Improve for extension modes:

```typescript
export function getProviderLabel(provider?: string, extensionLabel?: string): string {
  if (!provider) return 'CLI'
  const label = CODING_CLI_PROVIDER_LABELS[provider as CodingCliProviderName]
  if (label) return label
  if (extensionLabel) return extensionLabel
  // Capitalize first letter for unknown extensions (better than ALL CAPS)
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}
```

**Step 3: Commit**

```bash
git add src/store/types.ts src/store/paneTypes.ts src/lib/coding-cli-utils.ts
git commit -m "feat: add TabModeOrExtension type for dynamic CLI extension modes"
```

---

### Task 8: Update title derivation and icon rendering for CLI extensions

When a CLI extension pane is created, the title and icon should come from the extension manifest when available. The hardcoded `CODING_CLI_PROVIDER_LABELS` covers the known providers; for extension-provided CLIs, we fall back to the extension registry data.

**Files:**
- Modify: `src/lib/derivePaneTitle.ts` - use `getProviderLabel` with extension fallback
- No icon changes needed: PanePicker already renders extension icons from the registry, and ProviderIcon has a fallback for unknown providers.

**Step 1: Update derivePaneTitle to pass extension label**

In `src/lib/derivePaneTitle.ts`, find where terminal mode label is derived. The function uses `getProviderLabel(content.mode)`. Since `derivePaneTitle` is a pure function without Redux access, add an optional `extensionEntries` parameter so callers with extension data can pass it:

```typescript
import type { ClientExtensionEntry } from '@shared/extension-types'

export function derivePaneTitle(
  content: PaneContent,
  extensionEntries?: ClientExtensionEntry[],
): string {
  // ... existing code ...
  // In the terminal case:
  if (content.kind === 'terminal' && content.mode !== 'shell') {
    const ext = extensionEntries?.find(e => e.name === content.mode)
    return getProviderLabel(content.mode, ext?.label)
  }
  // ...
}
```

Update callers of `derivePaneTitle` in PaneContainer.tsx to pass extension entries.

**Step 2: Commit**

```bash
git add src/lib/derivePaneTitle.ts src/components/panes/PaneContainer.tsx
git commit -m "feat: support extension-provided labels for CLI pane titles"
```

---

### Task 9: End-to-end smoke test via live UI

**Testing approach:** Since the user specified "No unit tests only. You should actually make sure this works", we validate through the live UI on port :5173.

**Step 1: Start the dev server in the worktree**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

**Step 2: Verify extension scan in logs**

```bash
grep "Extension scan" /tmp/freshell-3344.log
# Should show: Extension scan complete { count: 2+, names: ['claude', 'codex', ...] }
```

**Step 3: Verify API endpoint**

```bash
curl http://localhost:3344/api/extensions | jq '.[].name'
# Should include "claude" and "codex"
```

**Step 4: Open Chrome and test via the live UI**

Using browser automation or manual testing on port :5173:

1. Open pane picker (click +, or Ctrl+N)
2. Verify Claude and Codex appear in the picker
3. Click Claude -- verify directory picker appears
4. Select a directory -- verify terminal pane opens with Claude Code
5. Type a message and verify Claude responds
6. Close the tab
7. Reopen Claude from picker -- verify it works again
8. Repeat steps 3-7 for Codex
9. Open Claude and Codex side by side -- verify both work independently

**Step 5: Verify existing tests still pass**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 6: Clean up test server**

```bash
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

**Step 7: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix: address issues found during E2E testing of CLI extensions"
```

---

### Task 10: Run full test suite and fix any regressions

**Step 1: Run all tests**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 2: Fix any failures**

The most likely failures will be:
- Tests that construct `TerminalRegistry` without the new `cliExtensions` parameter (it's optional, so these should still compile but verify)
- Tests that directly test `TerminalCreateSchema.mode` enum values (these use the original schema which is preserved)
- Tests that check `availableClis` detection (update to pass empty `extraClis`)

Fix each failure by updating the test expectations to match the new behavior.

**Step 3: Run typecheck**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsc --noEmit
```

Fix any type errors.

**Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: update tests for CLI extensions refactor"
```

---

## Key Design Decisions

1. **CLI extensions create terminal panes, not extension panes.** The `kind: 'terminal'` pane with xterm.js is the right renderer for CLI agents. Extension panes (kind: 'extension') use iframes, which is wrong for CLI tools.

2. **`TerminalMode` stays as a strict union; `TerminalModeOrExtension` is the wider type for API boundaries.** This preserves type safety on `CODING_CLI_COMMANDS` (which is `Record<Exclude<TerminalMode, 'shell'>, ...>`) while allowing extension modes to pass through `buildSpawnSpec`, `TerminalRegistry.create`, and pane content types. Same pattern on the frontend with `TabMode` vs `TabModeOrExtension`.

3. **WS protocol mode validation uses `z.string().refine()` against a dynamic set.** The `createTerminalCreateSchema(extraModes)` factory builds a schema that accepts the built-in modes plus registered CLI extensions, rejecting typos and garbage. The original `TerminalCreateSchema` export is preserved for backward compatibility in tests and client code.

4. **Extension data is passed via dependency injection, not module-level setters.** `TerminalRegistry` receives `cliExtensions` via its constructor. `resolveCodingCliCommand` and `buildSpawnSpec` receive it as a parameter. `detectAvailableClis` receives it as an argument. This follows the codebase's existing patterns (`createPlatformRouter`, `createExtensionRouter`, `WsHandler` constructor).

5. **All changes target `server/terminal-registry.ts`, not `server/spawn-spec.ts`.** `spawn-spec.ts` is dead code (never imported by production files). `terminal-registry.ts` is the authoritative location for `TerminalMode`, `CODING_CLI_COMMANDS`, `resolveCodingCliCommand`, `buildSpawnSpec`, and the `TerminalRegistry` class.

6. **Hardcoded CLI configs remain as defaults.** The `CODING_CLI_COMMANDS` in `terminal-registry.ts` and `CLI_COMMANDS` in `platform.ts` remain as fallbacks. Extension manifests provide additional modes beyond the hardcoded set. Existing installations without the `extensions/` folder continue to work unchanged.

7. **Session indexing is orthogonal.** The `server/coding-cli/providers/` directory handles session file parsing (JSONL, etc.) and is not part of the extension system. A future task could make session indexers discoverable via extensions, but that's a much larger change.

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits
- The live server on main must never be broken
- Work in the worktree at `/home/user/code/freshell/.worktrees/extensions-system`
