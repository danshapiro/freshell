# Settings & Extensions Redesign

## Goal

Restructure the settings page and extensions management to reduce complexity, unify the presentation of providers and extensions, and prepare for an eventual full unification — without breaking existing config or APIs.

## Context

Freshell currently has four extensibility concepts: extensions (filesystem-discovered pane types), coding CLI providers (hardcoded session indexers), agent chat providers (per-provider defaults), and agent chat plugins (default tool sets). The settings page is a 1832-line monolith with 13+ vertically stacked sections and no sidebar navigation. Provider config (model, sandbox, permissions) lives in settings, separate from the extension management page.

Users are actively using these systems. Breaking changes to `~/.freshell/config.json` or the REST API are not acceptable in this work.

## Approach

UI reshuffling with internal alignment (Approach 1 from brainstorming). Introduce a `ManagedItem` view-layer abstraction that both built-in providers and filesystem extensions conform to. The UI treats them uniformly. The underlying storage remains unchanged.

## Design

### 1. ManagedItem Abstraction

A shared interface for the UI to treat providers and extensions uniformly.

```typescript
interface ManagedItem {
  id: string                          // unique key (e.g. "claude", "my-server-ext")
  name: string                        // display name
  description?: string
  version?: string
  iconUrl?: string

  kind: 'cli' | 'server' | 'client'  // maps to current extension categories
  source: 'builtin' | 'extension'    // origin — hardcoded provider vs filesystem extension

  enabled: boolean                    // unified enable/disable
  status?: {                          // runtime state
    running?: boolean
    port?: number
    error?: string
  }

  config?: ManagedItemConfig[]        // expandable config fields
}

interface ManagedItemConfig {
  key: string                         // e.g. "model", "permissionMode"
  label: string
  type: 'text' | 'select' | 'toggle' | 'path'
  value: unknown
  options?: { label: string; value: string }[]  // for select type
}
```

Key points:
- `source: 'builtin'` reads/writes through `codingCli.providers` and `codingCli.enabledProviders`
- `source: 'extension'` reads/writes through `extensions.disabled` and the manifest's `contentSchema`
- A Redux selector `selectManagedItems()` combines both sources into one list, sorted by kind
- The underlying storage does not change — this is purely a view-layer mapping

### 2. Settings Page Restructuring

Break the `SettingsView.tsx` monolith into a sidebar-navigated layout with 4 sections.

**Layout:**
- Fixed left sidebar (~200px) with section links
- Scrollable content area on the right
- "Manage Extensions" button prominent at the top of the content area
- "Extensions ↗" link in the sidebar

**Sections:**

| Section | Contents |
|---------|----------|
| **Appearance** | Theme, UI scale, terminal color scheme, font family, font size, line height, cursor blink, terminal preview |
| **Workspace** | Sidebar settings, pane defaults, notifications, editor choice, keyboard shortcuts |
| **Safety** | Auto-kill idle timeout, default working directory, remote access toggle + firewall status |
| **Advanced** | Scrollback buffer, OSC52 clipboard, debug logging |

**Component structure:** Each section becomes its own component file extracted from the monolith:
- `AppearanceSettings.tsx`
- `WorkspaceSettings.tsx`
- `SafetySettings.tsx`
- `AdvancedSettings.tsx`

`SettingsView.tsx` becomes a thin shell — sidebar nav + section routing.

**Navigation:** Scroll-based (like Chrome settings) — clicking a sidebar item scrolls to that section. Adjacent settings remain visible.

**Removed:** The Coding CLIs section is dropped entirely. All provider config moves to extension cards on the Extensions page.

### 3. Extensions Page Enrichment

The existing Extensions page gains the ability to manage built-in providers alongside filesystem extensions. The current card-based layout and general shape are preserved — this is enrichment, not a redesign.

**Content sources combined:**
- Built-in providers (Claude, Codex, OpenCode) — `source: 'builtin'`
- User-installed extensions from `~/.freshell/extensions/` — `source: 'extension'`

**Grouping:** By kind — "CLI Agents", "Server Extensions", "Client Extensions". Built-in providers appear in CLI Agents alongside CLI extensions with no visual distinction.

**Card (collapsed):** Same as current — icon, name, version, description, category badge, running status, keyboard shortcut, enable/disable toggle. Add an expand chevron.

**Card (expanded):** Config fields rendered from `ManagedItemConfig[]`:
- CLI providers: model selector, permission mode dropdown, sandbox mode, starting directory
- Extensions with `contentSchema`: fields from the schema
- Save on change, debounced, using existing `saveServerSettingsPatch` thunks

**Enable/disable wiring:**
- `source: 'builtin'` → writes to `codingCli.enabledProviders`
- `source: 'extension'` → writes to `extensions.disabled`
- `selectManagedItems()` normalizes both into `enabled: boolean`

### 4. Network Quick-Access

Network access is promoted from a settings section to a quick-action in the main UI.

**Placement:** Icon button in the sidebar trough, right side, opposite the logo. Share/network/globe icon.

**Click behavior:** Opens a popover showing:
- Remote access toggle
- Current access URL with copy button
- Firewall status / fix prompt
- Compact device list

**Right-click:** Copy link with auth token (fast sharing path).

**Settings > Safety** retains the remote access toggle for discoverability — both locations control the same setting.

### 5. Internal Wiring & Backward Compatibility

**Redux:**
- New `selectManagedItems()` selector combines `extensionsSlice` and provider configs from `settingsSlice`
- Existing selectors and slice actions remain unchanged
- Card config changes dispatch to existing `saveServerSettingsPatch` with the same patch shapes

**Config file (`~/.freshell/config.json`):**
- No schema changes
- `codingCli.enabledProviders`, `codingCli.providers`, `extensions.disabled` all stay

**REST API:**
- No endpoint changes
- `PATCH /api/settings` accepts the same patches
- `/api/extensions` returns the same registry

**Migration path (future, not this work):**
- Add `freshell.json` manifests for built-in providers
- Switch `source` from `'builtin'` to `'extension'`
- UI components already work against `ManagedItem`, no changes needed
- Deprecate `codingCli.enabledProviders` in favor of `extensions.disabled` with a settings migration

## Verification Requirements

All feature implementation must be verified using Chrome browser automation:
- Start the dev server in the worktree on a unique port
- Launch the page in Chrome and navigate to settings / extensions views
- Verify that UI renders correctly, interactions work, and state persists
- Do not claim something works without running it and checking the result

## Testing Strategy

- Extract settings section components with unit tests for each
- Test `selectManagedItems()` selector with combined provider + extension state
- Test extension card expand/collapse and config field rendering
- Integration tests for settings save/load round-trip through the API
- E2E browser verification for the settings sidebar navigation and extension card interactions

## Follow-on Projects (Out of Scope)

- **Agent text chat feature** — A classic text chat pane type, managed as its own extension category separate from coding agents. The existing `agentChat.defaultPlugins` and `agentChat.providers` settings would be revisited as part of that effort. This is a missing feature in Freshell that should be added.
- **Full extension unification** — Making built-in providers into actual filesystem extensions with manifests, converging the storage model to a single enable/disable mechanism.
