# CLI Extensions Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Create an `extensions/` folder in the repo where dropping a folder with a `freshell.json` manifest adds a new CLI pane type. Refactor the existing hardcoded CLI registrations (Claude Code, Codex CLI, OpenCode, Gemini, Kimi) out of the source code and into extension manifests as the **single source of truth**.

**Architecture:** The extension system infrastructure (ExtensionManager, manifests, routes, ExtensionPane) already exists. CLI registrations are currently scattered across 5+ files as hardcoded lists: `CODING_CLI_COMMANDS` in `server/terminal-registry.ts`, `CLI_COMMANDS` in `server/platform.ts`, `CodingCliProviderSchema` in `shared/ws-protocol.ts` (and a duplicate in `server/ws-schemas.ts`), `CODING_CLI_PROVIDER_CONFIGS` in `src/lib/coding-cli-utils.ts`, and `CODING_CLI_PROVIDER_LABELS` ibid.

This refactoring creates extension folders (e.g., `extensions/claude-code/freshell.json`) for each CLI, then **removes** the hardcoded registrations and replaces them with dynamic derivation from the extension registry. After this refactoring:
- `CODING_CLI_COMMANDS` becomes a `Map<string, CodingCliCommandSpec>` built from extension manifests at startup
- `CLI_COMMANDS` in `platform.ts` is replaced by a function parameter from the extension registry
- `CodingCliProviderSchema` in `shared/ws-protocol.ts` widens to `z.string().min(1)` (one-line change); `WsHandler` adds dynamic `refine()` validation for the two messages that spawn processes
- `CODING_CLI_PROVIDER_CONFIGS` and `CODING_CLI_PROVIDER_LABELS` on the frontend are derived from the extension entries in Redux
- Adding a new CLI (e.g., Aider) means dropping a folder in `extensions/` -- zero code changes

**Tech Stack:** TypeScript, Zod (manifest validation), Node.js (server), React/Redux (client), Vitest (testing)

**Testing strategy:** No unit tests only. Full E2E validation through the live UI on port :5173 -- open Chrome, create Claude and Codex panes, exchange messages, close and reopen them, and verify the full UX works correctly.

---

## Analysis: What Changes and What Stays

### The central file: `server/terminal-registry.ts`

**`server/terminal-registry.ts`** is the authoritative location for PTY lifecycle management and spawn logic. It contains:

- `TerminalMode` type (line 33): `'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'`
- `CodingCliCommandSpec` type (line 36): includes `label`, `envVar`, `defaultCommand`, `resumeArgs`, and `supportsPermissionMode`
- `CODING_CLI_COMMANDS` record (line 44): `Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec>` -- maps mode names to spawn specs
- `resolveCodingCliCommand()` (line 205): accepts `mode`, `resumeSessionId`, `target`, and `providerSettings` params
- `buildSpawnSpec()` (line 622): constructs PTY spawn arguments from mode, cwd, shell, etc.
- `TerminalRegistry` class (line 792): manages PTY processes, constructed with `(settings?, maxTerminals?, maxExitedTerminals?)`
- `modeSupportsResume()` (line 79): checks if a mode has `resumeArgs`
- `getModeLabel()` (line 233): returns display label for a mode

**Note:** `server/spawn-spec.ts` exists but is dead code -- it is never imported by any production or test file. All references in this plan target `server/terminal-registry.ts`.

### Single source of truth: extension manifests replace hardcoded lists

The user explicitly said "In the refactoring, you'll move those there" -- meaning the hardcoded CLI registrations in source code must be **replaced** by extension manifests, not supplemented. After this refactoring:

1. **`CODING_CLI_COMMANDS`** in `server/terminal-registry.ts` changes from a hardcoded `Record` to a dynamic `Map<string, CodingCliCommandSpec>` built at server startup from the extension registry
2. **`CLI_COMMANDS`** in `server/platform.ts` is removed; `detectAvailableClis()` derives its CLI list from an argument populated by the extension registry
3. `CodingCliProviderSchema` in `shared/ws-protocol.ts` widens from `z.enum([...])` to `z.string().min(1)` -- a single-line change. All schemas that embed it automatically accept any provider string. `WsHandler` still validates `terminal.create` and `codingcli.create` dynamically (via `z.string().refine()`) against registered extensions
4. **`CODING_CLI_PROVIDER_CONFIGS`**, **`CODING_CLI_PROVIDER_LABELS`**, and **`CODING_CLI_PROVIDERS`** in `src/lib/coding-cli-utils.ts` are replaced by derivation from the Redux `extensions.entries` state

### Type strategy: `TerminalMode` becomes `'shell' | string`

Since `CODING_CLI_COMMANDS` will be a dynamic `Map<string, CodingCliCommandSpec>` (not a static `Record<Exclude<TerminalMode, 'shell'>, ...>`), there is no static record type to protect. `TerminalMode` widens to `'shell' | string`. No dual-type system (`TerminalModeOrExtension`) is needed.

On the frontend, `TabMode` (currently `'shell' | CodingCliProviderName`) also widens to `'shell' | string`. `CodingCliProviderName` becomes `string` -- both from the shared module (where `z.string().min(1)` infers to `string`) and from the frontend's own redefinition in `coding-cli-types.ts`.

### WS protocol validation: widen `CodingCliProviderSchema` to `z.string().min(1)`

The `shared/ws-protocol.ts` module is imported by both server and client. The client uses `import type` exclusively (verified: `src/lib/coding-cli-types.ts`, `src/lib/ws-client.ts`, `src/store/types.ts`, `src/store/paneTypes.ts` all use `import type`). The server imports runtime Zod schemas.

**Problem:** `CodingCliProviderSchema` is embedded in many schemas that are used at runtime on the server -- not just `TerminalCreateSchema` and `CodingCliCreateSchema`. The full list of schemas that embed it:

1. `SessionLocatorSchema` (line 40): `provider: CodingCliProviderSchema` -- imported by `sessions-router.ts` and `server/agent-api/layout-schema.ts`
2. `TerminalMetaRecordSchema` (line 63): `provider: CodingCliProviderSchema.optional()`
3. `TerminalMetaListResponseSchema` (line 79): captures `TerminalMetaRecordSchema` at module load
4. `TerminalMetaUpdatedSchema` (line 85): captures `TerminalMetaRecordSchema` at module load
5. `UiLayoutSyncSchema` (line 221): uses `SessionLocatorSchema` via `fallbackSessionRef`
6. `TerminalCreateSchema` (line 167): `mode` field
7. `CodingCliCreateSchema` (line 249): `provider` field

Rebuilding all 7 schemas dynamically in `WsHandler` would be fragile -- any new schema that uses `CodingCliProviderSchema` would silently break. And some of these schemas are used outside `WsHandler` (e.g., `sessions-router.ts` imports `CodingCliProviderSchema` directly, `layout-schema.ts` imports `SessionLocatorSchema`).

**Solution:** Widen `CodingCliProviderSchema` to `z.string().min(1)` in `shared/ws-protocol.ts`. This is a single-line change that eliminates the entire cascade. `CodingCliProviderName` widens to `string` (inferred from `z.string().min(1)`), which is already what the plan does on the frontend (Task 7). The client only uses `import type` so there is no bundle impact. All schemas that embed `CodingCliProviderSchema` automatically accept any non-empty string.

Server-side validation for the two security-sensitive messages (`terminal.create` mode and `codingcli.create` provider) is still done dynamically in the `WsHandler` constructor via `z.string().refine()` against the extension-derived set. This is the right level of strictness: structural schemas accept any provider string (so metadata, session locators, and layout sync work for any extension), while the two messages that actually spawn processes validate against registered extensions.

```typescript
// shared/ws-protocol.ts -- the ONLY change to this file:
// BEFORE:
export const CodingCliProviderSchema = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])
// AFTER:
export const CodingCliProviderSchema = z.string().min(1)
```

`CodingCliProviderName` is still `z.infer<typeof CodingCliProviderSchema>`, which now infers to `string`. This is consistent with the frontend widening in Task 7.

### `server/ws-schemas.ts` is dead code -- verified and deleted

Verified: `server/ws-schemas.ts` is not imported by any production or test file. Grep for `from.*ws-schemas` across the entire repo returns zero matches. It is a stale copy of the ws-handler schemas with its own `CodingCliProviderSchema`, `TerminalCreateSchema`, and `ClientMessageSchema`. It is deleted in Task 6.

### PanePicker routing: bare names, not `ext:` prefix

CLI extensions use **bare provider names** (e.g., `'claude'`, `'codex'`) as their `PanePickerType`, not the `ext:` prefix. The existing PanePicker flow already handles bare names:
1. PanePicker builds `cliOptions` using bare names as `type`
2. PaneContainer's `handleSelect` calls `isCodingCliProviderName(type)` and routes to the directory picker
3. PaneContainer's `createContentForType` creates `TerminalPaneContent` with `mode: type`

After the refactor, `isCodingCliProviderName` checks against extension entries instead of a hardcoded list, so the same bare-name flow works for new CLI extensions. The `ext:` prefix remains exclusively for non-CLI extensions (category `'client'` or `'server'`).

**Critically, the `extensionOptions` builder in PanePicker must filter out `category === 'cli'` entries.** Otherwise, CLI extensions appear twice: once in `cliOptions` (bare name) and once in `extensionOptions` (`ext:name`).

### Key insight: CLI extensions create terminal panes, not extension panes

When the user selects a CLI extension from the picker, it should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`, NOT an `ExtensionPaneContent` (kind: 'extension'). CLI extensions use the existing terminal infrastructure (xterm.js, PTY, scrollback buffer). This is already how Claude/Codex work -- they're terminal panes with `mode: 'claude'` or `mode: 'codex'`.

### What stays unchanged (session indexing, providers)

The `server/coding-cli/` directory (session-indexer.ts, session-manager.ts, providers/claude.ts, providers/codex.ts, types.ts, utils.ts) handles session file parsing, JSONL indexing, and streaming JSON output. This is **orthogonal** to the extension system -- it's about understanding session history, not about spawning or picking CLI panes. These files stay as-is.

### Extension manifest schema: new CLI fields

The existing `CliConfigSchema` in `server/extension-manifest.ts` has `{ command, args?, env? }`. For the migration to be complete, we need additional fields that currently live in `CodingCliCommandSpec` and `CodingCliProviderConfig`:
- `envVar`: environment variable that overrides the command (e.g., `CLAUDE_CMD`)
- `resumeArgs`: template for session resume arguments (e.g., `["--resume", "{{sessionId}}"]`)
- `supportsPermissionMode`: whether the CLI accepts `--permission-mode` (currently only Claude)
- `supportsModel`: whether the CLI accepts a model override (currently only Codex)
- `supportsSandbox`: whether the CLI accepts a sandbox mode (currently only Codex)
- `label` is already on the top-level manifest

These will be added as optional fields on the `CliConfigSchema`.

### `CODING_CLI_PROVIDER_CONFIGS` visibility: preserving current behavior

Currently, `CODING_CLI_PROVIDER_CONFIGS` only includes Claude and Codex (2 entries). OpenCode, Gemini, and Kimi are in `CODING_CLI_PROVIDERS` and `CODING_CLI_PROVIDER_LABELS` but NOT in `CODING_CLI_PROVIDER_CONFIGS`. `CODING_CLI_PROVIDER_CONFIGS` is what PanePicker and SettingsView iterate. So OpenCode, Gemini, and Kimi do NOT appear in PanePicker or SettingsView today -- they only appear in the sidebar session list.

After the refactor, all 5 CLI extensions will have manifests. The `getCliProviderConfigs()` function derives from ALL extensions with `category === 'cli'`. But the `enabledProviders` gate in PanePicker prevents them from appearing. Currently `enabledProviders` defaults to `['claude', 'codex']`. After migration, the `knownProviders` logic (Task 9) seeds ALL 5 names into `knownProviders` without adding new ones to `enabledProviders`. Result: **no behavior change** -- only Claude and Codex appear in PanePicker after migration, same as before.

OpenCode, Gemini, and Kimi DO appear in SettingsView as enable/disable toggles (since SettingsView iterates all `getCliProviderConfigs()` results). This is actually an improvement -- users can now discover and enable them from Settings.

### Enable-by-default for new CLI extensions

Currently, `enabledProviders` in settings determines which CLI options appear in PanePicker (line 100-106 of PanePicker.tsx). The default in `settingsSlice.ts` is `['claude', 'codex']`. Additionally, there is a hardcoded allowlist filter in `mergeSettings()` (line 136-138 of settingsSlice.ts) that strips any provider not literally `'claude'`, `'codex'`, or `'opencode'`:

```typescript
enabledProviders: (merged.codingCli.enabledProviders ?? []).filter(
  (provider): provider is CodingCliProviderName => provider === 'claude' || provider === 'codex' || provider === 'opencode',
),
```

This is a triple gate: a new CLI extension must be (1) available on the system, (2) in `enabledProviders` settings, and (3) survive the hardcoded allowlist filter. This breaks the "zero code changes" promise for new extensions.

**Solution:** The hardcoded filter in `mergeSettings()` must be removed. A `knownProviders` field in settings tracks which CLI extension names the server has seen before. At server startup, if a CLI extension name is not in `knownProviders`, it's new -- add it to both `knownProviders` and `enabledProviders`. If it IS in `knownProviders` but NOT in `enabledProviders`, the user explicitly disabled it -- don't re-enable.

**Migration for existing users:** On first run after refactor, existing users' config has `enabledProviders: ['claude', 'codex']` and no `knownProviders`. If we naively treated missing `knownProviders` as `[]`, all 5 CLI extensions would look "new" and get force-added to `enabledProviders`, including opencode/gemini/kimi which weren't shown before. Fix: when `knownProviders` is absent (first run), seed it with ALL currently registered CLI extension names. This marks everything as "already known" and preserves the user's existing `enabledProviders` as-is. Only extensions added AFTER the migration (by dropping a new folder) will be auto-enabled.

```typescript
// Server startup (after extension scan):
const allCliNames = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli')
  .map(e => e.manifest.name)

const currentSettings = await configStore.getSettings()
const hasKnownProviders = currentSettings.codingCli?.knownProviders !== undefined
const knownProviders: string[] = currentSettings.codingCli?.knownProviders ?? []
const enabledProviders: string[] = currentSettings.codingCli?.enabledProviders ?? []

if (!hasKnownProviders) {
  // MIGRATION: First run after refactor. Seed knownProviders with ALL registered CLIs.
  // This prevents existing CLIs from being treated as "new" and force-enabled.
  // The user's existing enabledProviders (e.g., ['claude', 'codex']) is preserved as-is.
  await configStore.patchSettings({
    codingCli: { knownProviders: allCliNames },
  })
} else {
  // NORMAL: Subsequent runs. Auto-enable truly new extensions (added after migration).
  const newProviders = allCliNames.filter(name => !knownProviders.includes(name))
  if (newProviders.length > 0) {
    await configStore.patchSettings({
      codingCli: {
        knownProviders: [...knownProviders, ...newProviders],
        enabledProviders: [...enabledProviders, ...newProviders],
      },
    })
  }
}
```

---

### Task 1: Extend the extension manifest schema for CLI spawn fields

The existing `CliConfigSchema` only has `{ command, args?, env? }`. To fully replace `CodingCliCommandSpec` and `CodingCliProviderConfig`, we need additional fields.

**Files:**
- Modify: `server/extension-manifest.ts`
- Modify: `shared/extension-types.ts`
- Modify: `server/extension-manager.ts`

**Step 1: Add fields to `CliConfigSchema` in `server/extension-manifest.ts`**

```typescript
const CliConfigSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  envVar: z.string().optional(),              // env var to override command (e.g., 'CLAUDE_CMD')
  resumeArgs: z.array(z.string()).optional(), // template with {{sessionId}} placeholder
  supportsPermissionMode: z.boolean().optional(),
  supportsModel: z.boolean().optional(),      // shows model field in SettingsView
  supportsSandbox: z.boolean().optional(),    // shows sandbox selector in SettingsView
})
```

**Step 2: Add `cli` fields to `ClientExtensionEntry` in `shared/extension-types.ts`**

```typescript
export interface ClientExtensionEntry {
  // ... existing fields ...
  cli?: {
    supportsPermissionMode?: boolean
    supportsModel?: boolean
    supportsSandbox?: boolean
    supportsResume?: boolean
    resumeCommandTemplate?: string[]  // e.g., ["claude", "--resume", "{{sessionId}}"]
  }
}
```

The `resumeCommandTemplate` field gives the frontend enough information to build resume commands without hardcoded `if/else` branches. It is the manifest's `cli.command` followed by `cli.resumeArgs`, with `{{sessionId}}` as a placeholder. This is populated by `toClientRegistry()`.

**Step 3: Update `toClientRegistry()` in `server/extension-manager.ts` to populate `cli` field**

```typescript
if (manifest.category === 'cli' && manifest.cli) {
  const resumeCommandTemplate = manifest.cli.resumeArgs
    ? [manifest.cli.command, ...manifest.cli.resumeArgs]
    : undefined
  clientEntry.cli = {
    supportsPermissionMode: manifest.cli.supportsPermissionMode,
    supportsModel: manifest.cli.supportsModel,
    supportsSandbox: manifest.cli.supportsSandbox,
    supportsResume: !!manifest.cli.resumeArgs,
    resumeCommandTemplate,
  }
}
```

**Step 4: Commit**

```bash
git add server/extension-manifest.ts shared/extension-types.ts server/extension-manager.ts
git commit -m "feat: extend CLI extension manifest with spawn fields (envVar, resumeArgs, supportsPermissionMode, supportsModel, supportsSandbox)"
```

---

### Task 2: Create extension manifest files for all existing CLIs

**Files:**
- Create: `extensions/claude-code/freshell.json`
- Create: `extensions/codex-cli/freshell.json`
- Create: `extensions/opencode/freshell.json`
- Create: `extensions/gemini/freshell.json`
- Create: `extensions/kimi/freshell.json`

**Step 1: Create Claude Code extension manifest**

Create `extensions/claude-code/freshell.json`:
```json
{
  "name": "claude",
  "version": "1.0.0",
  "label": "Claude CLI",
  "description": "Anthropic's Claude Code CLI agent",
  "category": "cli",
  "cli": {
    "command": "claude",
    "envVar": "CLAUDE_CMD",
    "resumeArgs": ["--resume", "{{sessionId}}"],
    "supportsPermissionMode": true
  },
  "picker": {
    "shortcut": "L",
    "group": "agents"
  }
}
```

**Step 2: Create Codex CLI extension manifest**

Create `extensions/codex-cli/freshell.json`:
```json
{
  "name": "codex",
  "version": "1.0.0",
  "label": "Codex CLI",
  "description": "OpenAI's Codex CLI agent",
  "category": "cli",
  "cli": {
    "command": "codex",
    "envVar": "CODEX_CMD",
    "resumeArgs": ["resume", "{{sessionId}}"],
    "supportsModel": true,
    "supportsSandbox": true
  },
  "picker": {
    "shortcut": "X",
    "group": "agents"
  }
}
```

**Step 3: Create OpenCode extension manifest**

Create `extensions/opencode/freshell.json`:
```json
{
  "name": "opencode",
  "version": "1.0.0",
  "label": "OpenCode",
  "description": "OpenCode CLI agent",
  "category": "cli",
  "cli": {
    "command": "opencode",
    "envVar": "OPENCODE_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

**Step 4: Create Gemini extension manifest**

Create `extensions/gemini/freshell.json`:
```json
{
  "name": "gemini",
  "version": "1.0.0",
  "label": "Gemini",
  "description": "Google's Gemini CLI agent",
  "category": "cli",
  "cli": {
    "command": "gemini",
    "envVar": "GEMINI_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

**Step 5: Create Kimi extension manifest**

Create `extensions/kimi/freshell.json`:
```json
{
  "name": "kimi",
  "version": "1.0.0",
  "label": "Kimi",
  "description": "Kimi CLI agent",
  "category": "cli",
  "cli": {
    "command": "kimi",
    "envVar": "KIMI_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

**Step 6: Verify manifests are valid**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import fs from 'fs';
import { ExtensionManifestSchema } from './server/extension-manifest.js';
for (const dir of ['extensions/claude-code', 'extensions/codex-cli', 'extensions/opencode', 'extensions/gemini', 'extensions/kimi']) {
  const raw = JSON.parse(fs.readFileSync(dir + '/freshell.json', 'utf-8'));
  const result = ExtensionManifestSchema.safeParse(raw);
  console.log(dir, result.success ? 'VALID' : result.error.format());
}
"
```

**Step 7: Commit**

```bash
git add extensions/
git commit -m "feat: add CLI extension manifests for all existing CLI agents"
```

---

### Task 3: Add repo-local extensions directory to scan path

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

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import { ExtensionManager } from './server/extension-manager.js';
const mgr = new ExtensionManager();
mgr.scan(['./extensions']);
console.log('Found:', mgr.getAll().map(e => e.manifest.name));
"
```

Expected output: `Found: [ 'claude', 'codex', 'opencode', 'gemini', 'kimi' ]`

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: scan repo extensions/ directory for built-in CLI extensions"
```

---

### Task 4: Remove hardcoded CLI registrations from `terminal-registry.ts` and derive from extensions

This is the core task. We remove `CODING_CLI_COMMANDS` as a hardcoded `Record` and replace it with a `Map<string, CodingCliCommandSpec>` built from extension data. `TerminalMode` widens to `'shell' | string`.

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/index.ts`

**Step 1: Widen `TerminalMode` and convert `CODING_CLI_COMMANDS` to a dynamic Map**

In `server/terminal-registry.ts`:

```typescript
// TerminalMode is now a wider type -- any string is valid as a mode name.
// 'shell' is the only built-in; all CLI modes come from registered extensions.
export type TerminalMode = 'shell' | (string & {})
export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

export type CodingCliCommandSpec = {
  label: string
  envVar: string
  defaultCommand: string
  resumeArgs?: (sessionId: string) => string[]
  supportsPermissionMode?: boolean
}

// Mutable map, populated at startup from extension registry.
// No longer a hardcoded Record -- extensions are the single source of truth.
let codingCliCommands: Map<string, CodingCliCommandSpec> = new Map()

/**
 * Populate the CLI commands map from extension data.
 * Called once at server startup after extensions are scanned.
 */
export function registerCodingCliCommands(specs: Map<string, CodingCliCommandSpec>): void {
  codingCliCommands = specs
}
```

**IMPORTANT:** The `providerNotificationArgs()` function (line 168) has Claude-specific bell/hook args and Codex-specific skill args. These are provider-specific behaviors that cannot be generalized to arbitrary extensions. Keep this function as-is -- it returns `[]` for unknown modes, which is correct for new extensions.

**Step 2: Update all functions that referenced the hardcoded Record**

`modeSupportsResume`:
```typescript
export function modeSupportsResume(mode: TerminalMode): boolean {
  if (mode === 'shell') return false
  return !!codingCliCommands.get(mode)?.resumeArgs
}
```

`resolveCodingCliCommand`:
```typescript
function resolveCodingCliCommand(mode: TerminalMode, resumeSessionId?: string, target: ProviderTarget = 'unix', providerSettings?: ProviderSettings) {
  if (mode === 'shell') return null
  const spec = codingCliCommands.get(mode)
  if (!spec) return null
  const command = process.env[spec.envVar] || spec.defaultCommand
  const providerArgs = providerNotificationArgs(mode, target)
  // ... rest unchanged
}
```

`getModeLabel`:
```typescript
function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = codingCliCommands.get(mode)?.label
  return label || mode.charAt(0).toUpperCase() + mode.slice(1)
}
```

`normalizeResumeSessionId` -- param type is already `TerminalMode` which is now `'shell' | string`:
```typescript
function normalizeResumeSessionId(mode: TerminalMode, resumeSessionId?: string): string | undefined {
  // unchanged body
}
```

The `TerminalRecord` type already uses `mode: TerminalMode` which is now `'shell' | string`, so no change needed.

**Step 3: Build CLI commands map in `server/index.ts`**

After `extensionManager.scan(...)` and before `new TerminalRegistry(...)`:

```typescript
import { registerCodingCliCommands, type CodingCliCommandSpec } from './terminal-registry.js'

// Build CLI commands from extension manifests
const cliCommandsMap = new Map<string, CodingCliCommandSpec>()
for (const ext of extensionManager.getAll()) {
  if (ext.manifest.category !== 'cli' || !ext.manifest.cli) continue
  const cli = ext.manifest.cli
  const spec: CodingCliCommandSpec = {
    label: ext.manifest.label,
    envVar: cli.envVar || '',
    defaultCommand: cli.command,
    supportsPermissionMode: cli.supportsPermissionMode,
  }
  if (cli.resumeArgs) {
    const template = cli.resumeArgs
    spec.resumeArgs = (sessionId: string) =>
      template.map(arg => arg.replace('{{sessionId}}', sessionId))
  }
  cliCommandsMap.set(ext.manifest.name, spec)
}
registerCodingCliCommands(cliCommandsMap)
```

**Step 4: Commit**

```bash
git add server/terminal-registry.ts server/index.ts
git commit -m "feat: derive CODING_CLI_COMMANDS from extension manifests (single source of truth)"
```

---

### Task 5: Remove hardcoded `CLI_COMMANDS` from `platform.ts` and derive from extensions

**Files:**
- Modify: `server/platform.ts`
- Modify: `server/index.ts`

**Step 1: Remove `CLI_COMMANDS` constant and change `detectAvailableClis` to accept the CLI list as a parameter**

In `server/platform.ts`, remove the `CLI_COMMANDS` constant and change `detectAvailableClis`:

```typescript
// Remove this:
// const CLI_COMMANDS = [
//   { name: 'claude', envVar: 'CLAUDE_CMD', defaultCmd: 'claude' },
//   ...
// ] as const

export type CliDetectionSpec = { name: string; envVar: string; defaultCmd: string }

export async function detectAvailableClis(
  cliSpecs: CliDetectionSpec[],
): Promise<AvailableClis> {
  const results = await Promise.all(
    cliSpecs.map(async (cli) => {
      const cmd = cli.envVar ? (process.env[cli.envVar] || cli.defaultCmd) : cli.defaultCmd
      const available = await isCommandAvailable(cmd)
      return [cli.name, available] as const
    })
  )
  return Object.fromEntries(results)
}
```

**Step 2: Build CLI specs from extension registry in `server/index.ts`**

```typescript
// Build CLI detection specs from extension manifests
const cliDetectionSpecs: CliDetectionSpec[] = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli' && e.manifest.cli)
  .map(e => ({
    name: e.manifest.name,
    envVar: e.manifest.cli!.envVar || '',
    defaultCmd: e.manifest.cli!.command,
  }))
```

**Step 3: Pass CLI specs to `createPlatformRouter`**

In `server/index.ts`, change the platform router deps:
```typescript
app.use('/api', createPlatformRouter({
  detectPlatform,
  detectAvailableClis: () => detectAvailableClis(cliDetectionSpecs),
  detectHostName,
  checkForUpdate,
  appVersion: APP_VERSION,
}))
```

The `PlatformRouterDeps` interface already expects `detectAvailableClis: () => Promise<Record<string, boolean>>`, so no change needed there.

**Step 4: Commit**

```bash
git add server/platform.ts server/index.ts
git commit -m "feat: derive CLI availability detection from extension registry"
```

---

### Task 6: Widen `CodingCliProviderSchema`, build dynamic `terminal.create`/`codingcli.create` validation, and delete `ws-schemas.ts`

`CodingCliProviderSchema` is embedded in 7 schemas used at runtime on the server. Widening it to `z.string().min(1)` in `shared/ws-protocol.ts` is a single-line change that eliminates the entire cascade. The two messages that actually spawn processes (`terminal.create` and `codingcli.create`) still get dynamic validation in `WsHandler` via `z.string().refine()`.

**Files:**
- Modify: `shared/ws-protocol.ts` -- widen `CodingCliProviderSchema` to `z.string().min(1)` (one-line change)
- Modify: `server/ws-handler.ts` -- build dynamic `terminal.create` and `codingcli.create` schemas in constructor
- Delete: `server/ws-schemas.ts` -- dead code (verified: zero imports across the repo)

**Step 1: Widen `CodingCliProviderSchema` in `shared/ws-protocol.ts`**

```typescript
// BEFORE (line 36):
export const CodingCliProviderSchema = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])

// AFTER:
export const CodingCliProviderSchema = z.string().min(1)
```

This single change fixes all 7 schemas that embed `CodingCliProviderSchema`:
1. `SessionLocatorSchema` (line 40) -- used by `sessions-router.ts` and `server/agent-api/layout-schema.ts`
2. `TerminalMetaRecordSchema` (line 63)
3. `TerminalMetaListResponseSchema` (line 79) -- captures `TerminalMetaRecordSchema`
4. `TerminalMetaUpdatedSchema` (line 85) -- captures `TerminalMetaRecordSchema`
5. `UiLayoutSyncSchema` (line 221) -- uses `SessionLocatorSchema` via `fallbackSessionRef`
6. `TerminalCreateSchema` (line 167) -- `mode` field (still gets additional `refine()` in WsHandler)
7. `CodingCliCreateSchema` (line 249) -- `provider` field (still gets additional `refine()` in WsHandler)

`CodingCliProviderName` remains `z.infer<typeof CodingCliProviderSchema>`, which now infers to `string`. This is consistent with the frontend widening in Task 7. The client only uses `import type` from this module, so there is no bundle impact.

**Step 2: Delete `server/ws-schemas.ts`**

```bash
git rm server/ws-schemas.ts
```

This file is dead code. Verified by grepping for `from.*ws-schemas` across the entire repo -- zero matches.

**Step 3: In `server/ws-handler.ts`, build dynamic `terminal.create` and `codingcli.create` schemas in the constructor**

The static `TerminalCreateSchema` and `CodingCliCreateSchema` from `shared/ws-protocol.ts` now accept any non-empty string for mode/provider (because `CodingCliProviderSchema` was widened). But we still want the server to reject unknown modes/providers when spawning processes. Build dynamic replacements in the `WsHandler` constructor with `z.string().refine()`:

```typescript
class WsHandler {
  private clientMessageSchema: z.ZodDiscriminatedUnion<'type', z.ZodObject<any>[]>
  private codingCliProviderSet: Set<string>

  constructor(
    server: http.Server,
    registry: TerminalRegistry,
    codingCliSessionManager: CodingCliSessionManager,
    sdkBridge: SdkBridge,
    sessionRepairService: SessionRepairService,
    getReadyPayload: () => Promise<any>,
    getTerminalMeta: () => TerminalMeta[],
    tabsRegistryStore: TabsRegistryStore,
    serverInstanceId: string,
    layoutStore: LayoutStore,
    extensionManager?: ExtensionManager,
  ) {
    // ... existing init ...

    // Build the set of valid CLI provider/mode names from extensions
    const extensionModes = extensionManager
      ? extensionManager.getAll()
          .filter(e => e.manifest.category === 'cli')
          .map(e => e.manifest.name)
      : []
    const allModes = new Set(['shell', ...extensionModes])
    this.codingCliProviderSet = new Set(extensionModes)

    // Build dynamic schemas for the two process-spawning messages.
    // All other schemas (SessionLocatorSchema, TerminalMetaRecordSchema, etc.)
    // already accept any string via the widened CodingCliProviderSchema.
    const dynamicTerminalCreateSchema = z.object({
      type: z.literal('terminal.create'),
      requestId: z.string().min(1),
      mode: z.string().default('shell').refine(
        (val) => allModes.has(val),
        (val) => ({ message: `Invalid terminal mode: '${val}'. Valid: ${[...allModes].join(', ')}` }),
      ),
      shell: ShellSchema.default('system'),
      cwd: z.string().optional(),
      resumeSessionId: z.string().optional(),
      restore: z.boolean().optional(),
      tabId: z.string().min(1).optional(),
      paneId: z.string().min(1).optional(),
    })

    const dynamicProviderSchema = z.string().min(1).refine(
      (val) => this.codingCliProviderSet.has(val),
      (val) => ({ message: `Unknown CLI provider: '${val}'` }),
    )

    const dynamicCodingCliCreateSchema = z.object({
      type: z.literal('codingcli.create'),
      requestId: z.string().min(1),
      provider: dynamicProviderSchema,
      prompt: z.string().min(1),
      cwd: z.string().optional(),
      resumeSessionId: z.string().optional(),
      model: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
      permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
      sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    })

    this.clientMessageSchema = z.discriminatedUnion('type', [
      HelloSchema,
      PingSchema,
      dynamicTerminalCreateSchema,  // replaces static TerminalCreateSchema
      TerminalAttachSchema,
      TerminalDetachSchema,
      TerminalInputSchema,
      TerminalResizeSchema,
      TerminalKillSchema,
      TerminalListSchema,
      TerminalMetaListSchema,
      UiLayoutSyncSchema,           // already accepts any string via widened CodingCliProviderSchema
      dynamicCodingCliCreateSchema,  // replaces static CodingCliCreateSchema
      CodingCliInputSchema,
      CodingCliKillSchema,
      SdkCreateSchema,
      SdkSendSchema,
      SdkPermissionRespondSchema,
      SdkQuestionRespondSchema,
      SdkInterruptSchema,
      SdkKillSchema,
      SdkAttachSchema,
      SdkSetModelSchema,
      SdkSetPermissionModeSchema,
      UiScreenshotResultSchema,
      SessionsFetchSchema,
    ])
  }
```

Note that `UiLayoutSyncSchema` uses `SessionLocatorSchema`, which uses the widened `CodingCliProviderSchema`. It stays in the discriminated union as-is -- no dynamic replacement needed. Same for all other schemas that embed `CodingCliProviderSchema`.

**Step 4: Replace `CodingCliProviderSchema.safeParse()` calls with the widened schema**

The ws-handler uses `CodingCliProviderSchema.safeParse()` at lines 135 and 164 (in `normalizeUiSessionLocator` and `extractSessionLocatorsFromUiContent`). Since `CodingCliProviderSchema` is now `z.string().min(1)`, these calls will accept any non-empty string, which is correct -- session locators and metadata should work for any registered provider, not just the 5 hardcoded ones. No code change needed for these calls; they continue to work as-is.

However, these functions also serve a validation role (rejecting obviously invalid data). The widened schema still validates that the value is a non-empty string, which is sufficient. If stricter validation is desired (only accept registered providers), the functions can use `this.codingCliProviderSet.has()` instead:

```typescript
// Optional: If we want session locator normalization to reject unknown providers,
// convert to instance methods. Otherwise, the widened CodingCliProviderSchema
// (z.string().min(1)) is sufficient -- it validates structure, not registration.
// The recommendation is to keep these as-is since session locators may reference
// providers from other server instances.
```

**Step 5: Update the parse call**

Change line 1086 from `ClientMessageSchema.safeParse(msg)` to `this.clientMessageSchema.safeParse(msg)`.

Remove `TerminalCreateSchema` and `CodingCliCreateSchema` from the imports at line 27-60 since they're replaced by dynamic versions. Keep `CodingCliProviderSchema` import if it's still used (for `safeParse` calls in session locator functions). Keep all other static schema imports as they don't need dynamic behavior.

**Step 6: Commit**

```bash
git rm server/ws-schemas.ts
git add shared/ws-protocol.ts server/ws-handler.ts
git commit -m "feat: widen CodingCliProviderSchema to z.string().min(1), build dynamic spawn validation in WsHandler, delete dead ws-schemas.ts"
```

---

### Task 7: Remove hardcoded CLI configs from frontend `coding-cli-utils.ts`

Currently, `src/lib/coding-cli-utils.ts` has hardcoded `CODING_CLI_PROVIDERS`, `CODING_CLI_PROVIDER_LABELS`, and `CODING_CLI_PROVIDER_CONFIGS`. These must be derived from the extension entries in Redux state.

**Files:**
- Modify: `src/lib/coding-cli-utils.ts`
- Modify: `src/lib/coding-cli-types.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/paneTypes.ts`

**Step 1: Widen `CodingCliProviderName` type**

In `src/lib/coding-cli-types.ts`, change from re-exporting the narrow union to a wide type:
```typescript
// BEFORE:
// import type { CodingCliProviderName } from '@shared/ws-protocol'
// AFTER:
export type CodingCliProviderName = string
```

This avoids depending on the shared module's narrow union type. In `src/store/types.ts`, `TabMode` becomes effectively `string`.

**Step 2: Remove hardcoded arrays and records from `coding-cli-utils.ts`**

Replace the hardcoded arrays with functions that take extension entries as input:

```typescript
import type { CodingCliProviderName } from './coding-cli-types'
import type { ClientExtensionEntry } from '@shared/extension-types'

// REMOVED: CODING_CLI_PROVIDERS, CODING_CLI_PROVIDER_LABELS, CODING_CLI_PROVIDER_CONFIGS
// These are now derived from extension entries in Redux state.

export type CodingCliProviderConfig = {
  name: CodingCliProviderName
  label: string
  supportsModel?: boolean
  supportsSandbox?: boolean
  supportsPermissionMode?: boolean
}

export function getCliProviderConfigs(extensions: ClientExtensionEntry[]): CodingCliProviderConfig[] {
  return extensions
    .filter(e => e.category === 'cli')
    .map(e => ({
      name: e.name,
      label: e.label,
      supportsPermissionMode: e.cli?.supportsPermissionMode,
      supportsModel: e.cli?.supportsModel,
      supportsSandbox: e.cli?.supportsSandbox,
    }))
}

export function getCliProviders(extensions: ClientExtensionEntry[]): CodingCliProviderName[] {
  return extensions
    .filter(e => e.category === 'cli')
    .map(e => e.name)
}

export function getProviderLabel(provider?: string, extensions?: ClientExtensionEntry[]): string {
  if (!provider) return 'CLI'
  const ext = extensions?.find(e => e.name === provider && e.category === 'cli')
  if (ext) return ext.label
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function isCodingCliProviderName(value?: string, extensions?: ClientExtensionEntry[]): value is CodingCliProviderName {
  if (!value) return false
  if (!extensions) return false
  return extensions.some(e => e.category === 'cli' && e.name === value)
}

export function isCodingCliMode(mode?: string, extensions?: ClientExtensionEntry[]): boolean {
  if (!mode || mode === 'shell') return false
  return isCodingCliProviderName(mode, extensions)
}

export type ResumeCommandProvider = string

export function isResumeCommandProvider(value?: string, extensions?: ClientExtensionEntry[]): value is ResumeCommandProvider {
  if (!value) return false
  const ext = extensions?.find(e => e.name === value && e.category === 'cli')
  return !!ext?.cli?.supportsResume
}

/**
 * Build a resume command string from extension manifest data.
 * Uses the resumeCommandTemplate from the extension's cli config,
 * replacing {{sessionId}} with the actual session ID.
 * Returns null if the provider doesn't support resume or isn't found.
 */
export function buildResumeCommand(
  provider?: string,
  sessionId?: string,
  extensions?: ClientExtensionEntry[],
): string | null {
  if (!sessionId || !provider) return null
  const ext = extensions?.find(e => e.name === provider && e.category === 'cli')
  if (!ext?.cli?.resumeCommandTemplate) return null
  return ext.cli.resumeCommandTemplate
    .map(arg => arg.replace('{{sessionId}}', sessionId))
    .join(' ')
}
```

**Step 3: Update all callers of the removed constants and changed function signatures**

Every file that imports `CODING_CLI_PROVIDERS`, `CODING_CLI_PROVIDER_LABELS`, `CODING_CLI_PROVIDER_CONFIGS`, or calls `buildResumeCommand`, `isCodingCliProviderName`, `isCodingCliMode`, `isResumeCommandProvider`, or `getProviderLabel` must be updated to pass extension entries.

Key callers to update:
- `src/components/panes/PanePicker.tsx` -- uses `CODING_CLI_PROVIDER_CONFIGS` to build picker options; change to `getCliProviderConfigs(extensionEntries)`
- `src/components/panes/PaneContainer.tsx` -- uses `isCodingCliProviderName(type)` for content creation; change to `isCodingCliProviderName(type, extensionEntries)`
- `src/components/SettingsView.tsx` -- uses `CODING_CLI_PROVIDER_CONFIGS` to render enable toggles and provider settings; change to `getCliProviderConfigs(extensionEntries)`. The `supportsModel` and `supportsSandbox` flags are now read from extension manifest data via `ClientExtensionEntry.cli`, so Codex retains its model/sandbox settings UI.
- `src/lib/derivePaneTitle.ts` -- uses `getProviderLabel` for titles
- `src/lib/deriveTabName.ts` -- uses `isCodingCliMode`
- `src/lib/session-utils.ts` -- uses `isCodingCliProviderName`
- `src/lib/session-type-utils.ts` -- uses `CODING_CLI_PROVIDER_LABELS`, `isCodingCliMode`
- `src/components/context-menu/menu-defs.ts` -- uses `buildResumeCommand`, `isResumeCommandProvider`
- `src/components/context-menu/ContextMenuProvider.tsx` -- uses `buildResumeCommand`
- `src/components/icons/PaneIcon.tsx` -- uses `isCodingCliMode`

For pure functions that don't have access to Redux (like `derivePaneTitle`, `deriveTabName`), add an `extensions` parameter. For React components, get extension entries from `useAppSelector`.

**Step 4: Commit**

```bash
git add src/lib/coding-cli-utils.ts src/lib/coding-cli-types.ts src/store/types.ts src/store/paneTypes.ts
git commit -m "feat: derive CLI provider configs from extension entries instead of hardcoded lists"
```

---

### Task 8: Update PanePicker to use extension-derived CLI options and filter extension list

This task replaces the hardcoded `CODING_CLI_PROVIDER_CONFIGS` in PanePicker with extension-derived data, and fixes the duplicate-entry problem by filtering CLI extensions out of the generic extension options list.

**The routing decision:** CLI extensions use **bare provider names** as their `PanePickerType` (e.g., `'claude'`, not `'ext:claude'`). The existing flow -- `handleSelect` checks `isCodingCliProviderName(type)` and routes to directory picker, `createContentForType` creates `TerminalPaneContent` with `mode: type` -- already handles this correctly once `isCodingCliProviderName` checks extension entries.

The `ext:` prefix is exclusively for non-CLI extensions (category `'client'` or `'server'`). The `extensionOptions` builder in PanePicker currently includes ALL extensions without filtering by category. This means every CLI extension would appear twice: once in `cliOptions` (bare name) and once in `extensionOptions` (`ext:name`). Fix by adding a `category !== 'cli'` filter.

**Files:**
- Modify: `src/components/panes/PanePicker.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: In PanePicker.tsx, derive `cliOptions` from extension entries and filter `extensionOptions`**

Replace the `CODING_CLI_PROVIDER_CONFIGS` import and usage:

```typescript
// BEFORE:
// import { CODING_CLI_PROVIDER_CONFIGS, type CodingCliProviderConfig } from '@/lib/coding-cli-utils'
// ...
// const cliOptions = CODING_CLI_PROVIDER_CONFIGS
//   .filter((config) => availableClis[config.name] && enabledProviders.includes(config.name))
//   .map(cliConfigToOption)

// AFTER:
import { getCliProviderConfigs } from '@/lib/coding-cli-utils'
// ...
const cliConfigs = getCliProviderConfigs(extensionEntries)
const cliOptions = cliConfigs
  .filter((config) => availableClis[config.name] && enabledProviders.includes(config.name))
  .map((config) => cliConfigToOption(config, extensionEntries.find(e => e.name === config.name)))
```

Update `cliConfigToOption` to use extension picker config for shortcuts:

```typescript
function cliConfigToOption(config: CodingCliProviderConfig, ext?: ClientExtensionEntry): PickerOption {
  return {
    type: config.name,
    label: config.label,
    icon: null,
    providerName: config.name,
    shortcut: ext?.picker?.shortcut ?? config.name[0].toUpperCase(),
  }
}
```

Remove the hardcoded `CLI_SHORTCUTS` constant -- shortcuts now come from extension manifests.

Filter `extensionOptions` to exclude CLI extensions:

```typescript
// BEFORE:
// const extensionOptions: PickerOption[] = extensionEntries.map(...)

// AFTER:
const extensionOptions: PickerOption[] = extensionEntries
  .filter((ext) => ext.category !== 'cli')  // CLI extensions are in cliOptions, not here
  .map((ext) => ({
    type: `ext:${ext.name}` as PanePickerType,
    label: ext.label,
    icon: LayoutGrid,
    shortcut: ext.picker?.shortcut ?? '',
  }))
```

**Step 2: In PaneContainer.tsx, update `isCodingCliProviderName` calls to pass extensions**

```typescript
const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? [])

// In handleSelect:
if (isCodingCliProviderName(type, extensionEntries)) {
  setStep({ step: 'directory', providerType: type })
  return
}

// In createContentForType:
if (isCodingCliProviderName(type, extensionEntries)) {
  return {
    kind: 'terminal',
    mode: type,
    shell: 'system',
    createRequestId: nanoid(),
    status: 'creating',
    ...(cwd ? { initialCwd: cwd } : {}),
  }
}
```

No `ext:` prefix routing is needed for CLI extensions since they use bare names.

**Step 3: Commit**

```bash
git add src/components/panes/PanePicker.tsx src/components/panes/PaneContainer.tsx
git commit -m "feat: derive PanePicker CLI options from extensions, filter CLI from extension list"
```

---

### Task 9: Enable-by-default for new CLI extensions

Currently, a new CLI extension won't appear in PanePicker unless the user's `enabledProviders` setting includes it.

**Files:**
- Modify: `src/store/settingsSlice.ts`
- Modify: `server/index.ts`
- Modify: `src/store/types.ts`

**Step 1: Remove the hardcoded allowlist filter in `mergeSettings()`**

In `src/store/settingsSlice.ts`, the `mergeSettings` function filters `enabledProviders`:

```typescript
// BEFORE (line 134-138):
codingCli: {
  ...merged.codingCli,
  enabledProviders: (merged.codingCli.enabledProviders ?? []).filter(
    (provider): provider is CodingCliProviderName => provider === 'claude' || provider === 'codex' || provider === 'opencode',
  ),
},

// AFTER: no filtering -- accept any provider name from settings
codingCli: {
  ...merged.codingCli,
  enabledProviders: merged.codingCli.enabledProviders ?? [],
},
```

**Step 2: Add `knownProviders` to settings types**

In `src/store/types.ts`, add to `CodingCliSettings`:
```typescript
export interface CodingCliSettings {
  enabledProviders: CodingCliProviderName[]
  knownProviders?: string[]  // tracks which CLI extensions the server has seen
  providers: Partial<Record<CodingCliProviderName, { ... }>>
}
```

**Step 3: Auto-enable newly-discovered CLI extensions at server startup with migration safety**

In `server/index.ts`, after extension scan:

```typescript
// Auto-enable newly-discovered CLI extensions
const allCliNames = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli')
  .map(e => e.manifest.name)

const currentSettings = await configStore.getSettings()
const hasKnownProviders = currentSettings.codingCli?.knownProviders !== undefined
const knownProviders: string[] = currentSettings.codingCli?.knownProviders ?? []
const enabledProviders: string[] = currentSettings.codingCli?.enabledProviders ?? []

if (!hasKnownProviders) {
  // MIGRATION: First run after refactor. Existing users' config has no knownProviders.
  // Seed knownProviders with ALL registered CLI names so nothing is treated as "new".
  // The user's existing enabledProviders (e.g., ['claude', 'codex']) is preserved as-is.
  // This prevents opencode/gemini/kimi from being force-enabled during migration.
  await configStore.patchSettings({
    codingCli: { knownProviders: allCliNames },
  })
} else {
  // NORMAL: Subsequent runs. Auto-enable truly new extensions (added after migration).
  const newProviders = allCliNames.filter(name => !knownProviders.includes(name))
  if (newProviders.length > 0) {
    await configStore.patchSettings({
      codingCli: {
        knownProviders: [...knownProviders, ...newProviders],
        enabledProviders: [...enabledProviders, ...newProviders],
      },
    })
  }
}
```

**Step 4: Commit**

```bash
git add src/store/settingsSlice.ts src/store/types.ts server/index.ts
git commit -m "feat: auto-enable newly-discovered CLI extensions with knownProviders tracking"
```

---

### Task 10: Update `settings-router.ts` hardcoded provider names

The `settings-router.ts` has its own hardcoded `CODING_CLI_PROVIDER_NAMES` constant (line 8) and uses it in schema validation for `codingCli.enabledProviders` and `codingCli.providers`. This needs to accept extension-registered providers.

**Files:**
- Modify: `server/settings-router.ts`
- Modify: `server/index.ts`

**Step 1: Make `SettingsPatchSchema` accept dynamic provider names**

Change `createSettingsRouter` to accept extension manager data and build the schema dynamically:

```typescript
export interface SettingsRouterDeps {
  // ... existing fields ...
  validProviderNames: string[]  // NEW: from extension registry
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const { configStore, registry, wsHandler, codingCliIndexer, perfConfig, applyDebugLogging, validProviderNames } = deps

  const providerNameSet = new Set(validProviderNames)

  // Build SettingsPatchSchema dynamically -- remove module-level CODING_CLI_PROVIDER_NAMES
  const settingsPatchSchema = z.object({
    // ... existing fields unchanged ...
    codingCli: z.object({
      enabledProviders: z.array(
        z.string().refine(v => providerNameSet.has(v), { message: 'Unknown provider name' })
      ).optional(),
      knownProviders: z.array(z.string()).optional(),
      providers: z.record(z.string(), CodingCliProviderConfigSchema)
        .refine(
          (obj) => Object.keys(obj).every((k) => providerNameSet.has(k)),
          { message: 'Unknown provider name' },
        )
        .optional(),
    }).strict().optional(),
    // ... rest unchanged ...
  }).strict()

  // Use settingsPatchSchema instead of the module-level SettingsPatchSchema
```

**Step 2: Pass `validProviderNames` in `server/index.ts`**

```typescript
app.use('/api/settings', createSettingsRouter({
  configStore,
  registry,
  wsHandler,
  codingCliIndexer,
  perfConfig,
  applyDebugLogging,
  validProviderNames: allCliNames,  // from extension scan
}))
```

**Step 3: Commit**

```bash
git add server/settings-router.ts server/index.ts
git commit -m "feat: settings schema accepts dynamically-registered CLI provider names"
```

---

### Task 11: End-to-end smoke test via live UI

**Testing approach:** Since the user specified "No unit tests only. You should actually make sure this works", we validate through the live UI on port :5173.

**Step 1: Start the dev server in the worktree**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

**Step 2: Verify extension scan in logs**

```bash
grep "Extension scan" /tmp/freshell-3344.log
# Should show: Extension scan complete { count: 5+, names: ['claude', 'codex', 'opencode', 'gemini', 'kimi'] }
```

**Step 3: Verify API endpoint**

```bash
curl http://localhost:3344/api/extensions | jq '.[].name'
# Should include "claude", "codex", "opencode", "gemini", "kimi"

curl http://localhost:3344/api/platform | jq '.availableClis'
# Should include entries for all registered CLI extensions
```

**Step 4: Open Chrome and test via the live UI**

Using browser automation or manual testing on port :5173:

1. Open pane picker (click +, or Ctrl+N)
2. Verify Claude and Codex appear in the picker -- each appears ONCE, not twice
3. Verify opencode/gemini/kimi do NOT appear (they're not in default `enabledProviders`)
4. Click Claude -- verify directory picker appears
5. Select a directory -- verify terminal pane opens with Claude Code
6. Type a message and verify Claude responds
7. Close the tab
8. Reopen Claude from picker -- verify it works again
9. Repeat steps 4-8 for Codex
10. Open Claude and Codex side by side -- verify both work independently
11. Verify no CLI extensions appear with `ext:` prefix in the picker
12. Right-click a Claude session in sidebar -- verify "Copy resume command" works and produces the correct command string
13. Open Settings -- verify Codex has model and sandbox settings (supportsModel, supportsSandbox in manifest)
14. In Settings, verify all 5 CLI extensions appear as enable/disable toggles
15. Enable "opencode" in Settings -- verify it appears in PanePicker after enabling

**Step 5: Test new-extension discovery**

1. Create a dummy extension: `mkdir extensions/test-cli && echo '{"name":"testcli","version":"1.0.0","label":"Test CLI","description":"Test","category":"cli","cli":{"command":"echo"}}' > extensions/test-cli/freshell.json`
2. Restart the dev server
3. Verify "testcli" appears in the pane picker (auto-enabled because it's a new knownProvider)
4. Go to Settings, disable it, restart -- verify it stays disabled
5. Clean up: `rm -rf extensions/test-cli`

**Step 6: Verify existing tests still pass**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 7: Clean up test server**

```bash
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

**Step 8: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix: address issues found during E2E testing of CLI extensions"
```

---

### Task 12: Run full test suite and fix any regressions

**Step 1: Run all tests**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 2: Fix any failures**

The most likely failures will be:
- Tests that construct `TerminalRegistry` -- the constructor signature is unchanged, but tests that use `TerminalMode` as a narrow type may need updating
- Tests that check `availableClis` detection -- `detectAvailableClis` now requires a parameter
- Tests that import `CODING_CLI_PROVIDERS` or `CODING_CLI_PROVIDER_LABELS` -- these are removed
- Tests that call `buildResumeCommand` without extension entries -- signature changed
- Tests in `ws-handler` that depend on the module-level `ClientMessageSchema` -- now an instance field

For test files that need `registerCodingCliCommands`, add a setup that builds the map from test fixtures.

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

1. **Extension manifests are the single source of truth.** The hardcoded `CODING_CLI_COMMANDS`, `CLI_COMMANDS`, `CODING_CLI_PROVIDERS`, `CODING_CLI_PROVIDER_LABELS`, and `CODING_CLI_PROVIDER_CONFIGS` are all removed. CLI registration is defined solely in extension manifest files, and all runtime data structures are built from those manifests at server startup.

2. **`TerminalMode` becomes `'shell' | string`.** Since `CODING_CLI_COMMANDS` is now a dynamic `Map`, there is no static `Record` type to protect. No dual-type system (`TerminalModeOrExtension`) is needed. On the frontend, `TabMode` and `CodingCliProviderName` also widen to `string`.

3. **`CodingCliProviderSchema` widens to `z.string().min(1)`.** This is a single-line change in `shared/ws-protocol.ts` that eliminates the entire cascade of dynamic schema rebuilding. All 7 schemas that embed `CodingCliProviderSchema` (including `SessionLocatorSchema`, `TerminalMetaRecordSchema`, `UiLayoutSyncSchema`, etc.) automatically accept any non-empty string. `CodingCliProviderName` infers to `string`, consistent with frontend widening. The two messages that spawn processes (`terminal.create` and `codingcli.create`) still get dynamic `refine()` validation in `WsHandler` against registered extensions.

4. **`server/ws-schemas.ts` is dead code and is deleted.** Verified: zero imports across the entire repo. It was a stale copy of ws-handler schemas with its own hardcoded `CodingCliProviderSchema` and `ClientMessageSchema`.

5. **Provider-specific notification logic stays in `terminal-registry.ts`.** The `providerNotificationArgs()` function has Claude-specific hook/bell args and Codex-specific skill args. These are inherently provider-specific behaviors that return `[]` for unknown modes, which is correct for new extensions.

6. **Settings schema validation is dynamic.** `SettingsPatchSchema` in `server/settings-router.ts` accepts extension-registered provider names for `codingCli.enabledProviders` and `codingCli.providers`.

7. **CLI extensions use bare provider names in PanePicker, not `ext:` prefix.** The existing PanePicker flow uses bare names (`'claude'`, `'codex'`) for CLI options, routes them through the directory picker, and creates `TerminalPaneContent`. The `ext:` prefix is exclusively for non-CLI extensions. The `extensionOptions` list filters out `category === 'cli'` to prevent duplicates.

8. **`buildResumeCommand` derives from extension manifest data.** Uses `resumeCommandTemplate` (built from `cli.command` + `cli.resumeArgs`) from `ClientExtensionEntry.cli`. New CLI extensions with `resumeArgs` get working resume commands with zero code changes.

9. **New CLI extensions are enabled by default with migration safety.** A `knownProviders` field tracks which CLI extension names the server has seen. On first run after refactor (migration), `knownProviders` is seeded with ALL registered CLI names, so nothing appears "new" and existing `enabledProviders` is preserved. On subsequent runs, any CLI extension name not in `knownProviders` is truly new and gets auto-enabled. The hardcoded allowlist filter in `settingsSlice.ts`'s `mergeSettings()` is removed.

10. **`supportsModel` and `supportsSandbox` are extension manifest fields.** The Codex manifest has `"supportsModel": true, "supportsSandbox": true`. The `CliConfigSchema` in `server/extension-manifest.ts` validates these. The `ClientExtensionEntry.cli` object carries them to the frontend. `getCliProviderConfigs()` maps them into `CodingCliProviderConfig`. SettingsView reads them to conditionally render model and sandbox settings. No functionality is lost.

11. **PanePicker visibility preserves current behavior.** Currently only Claude and Codex appear in PanePicker (via `CODING_CLI_PROVIDER_CONFIGS` with 2 entries gated by `enabledProviders: ['claude', 'codex']`). After refactor, `getCliProviderConfigs()` returns all 5 CLIs but PanePicker still filters by `enabledProviders`, which migration logic preserves as-is. OpenCode/Gemini/Kimi appear in SettingsView as enable/disable toggles but not in PanePicker until the user enables them.

12. **Session indexing is orthogonal.** The `server/coding-cli/providers/` directory handles session file parsing and is not part of the extension system.

13. **All changes target `server/terminal-registry.ts`, not `server/spawn-spec.ts`.** `spawn-spec.ts` is dead code.

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits
- The live server on main must never be broken
- Work in the worktree at `/home/user/code/freshell/.worktrees/extensions-system`
