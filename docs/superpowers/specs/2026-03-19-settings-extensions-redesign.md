# Settings & Extensions Redesign

## Goal

Restructure the settings page and extensions management to reduce complexity, unify the presentation of providers and extensions, and prepare for an eventual full unification — without breaking existing config or APIs.

## Context

Freshell currently has multiple extensibility concepts: extensions (filesystem-discovered pane types with `freshell.json` manifests), coding CLI providers (session indexers with both server-side code and extension manifests), agent chat providers, and agent chat plugins. The settings page is a 1832-line monolith with 13+ vertically stacked sections and no sidebar navigation. Provider config (model, sandbox, permissions) lives in settings, separate from the extension management page.

Importantly, the built-in CLI providers (Claude, Codex, OpenCode) already exist as filesystem extensions with `freshell.json` manifests — they're discovered by `ExtensionManager` and appear in the extension registry. They also have hardcoded server-side `CodingCliProvider` implementations for session discovery and parsing. From the UI's perspective, they are already extensions.

Users are actively using these systems. Breaking changes to `~/.freshell/config.json` or the REST API are not acceptable in this work.

## Approach

UI reshuffling with internal alignment. Introduce a `ManagedItem` view-layer abstraction that all extensions (including CLI providers) conform to, enabling unified card-based management. The underlying storage remains unchanged.

## Design

### 1. ManagedItem Abstraction

A shared interface for the UI to treat all extensions uniformly, regardless of their underlying config storage.

```typescript
interface ManagedItem {
  id: string                          // extension name from registry (e.g. "claude-code", "my-server-ext")
  name: string                        // display label
  description?: string
  version?: string
  iconUrl?: string

  kind: 'cli' | 'server' | 'client'  // extension category
  enabled: boolean                    // unified enable/disable state

  status?: {                          // runtime state
    running?: boolean
    port?: number
    error?: string
  }

  config: ManagedItemConfig[]         // expandable config fields
  picker?: {                          // pane picker metadata
    shortcut?: string
    group?: string
  }
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
- All items come from the extension registry (`extensionsSlice`). CLI providers are already in this registry.
- `enabled` is derived differently by kind:
  - `kind: 'cli'` — enabled if in `codingCli.enabledProviders` AND not in `extensions.disabled`
  - `kind: 'server' | 'client'` — enabled if not in `extensions.disabled`
- Config fields for CLI extensions are constructed from the provider's capabilities (read from `cli.supportsModel`, `cli.supportsPermissionMode`, `cli.supportsSandbox` on the `ClientExtensionEntry`). Option lists (e.g., permission mode values) come from the existing constants in `shared/settings.ts` (`CLAUDE_PERMISSION_MODE_VALUES`, `CODEX_SANDBOX_MODE_VALUES`). Current values are read from `codingCli.providers[name]`.
- Config fields for non-CLI extensions with `contentSchema` map `ContentSchemaField` types to `ManagedItemConfig` types: `'string'` → `'text'`, `'boolean'` → `'toggle'`, `'number'` → `'text'`.
- A Redux selector `selectManagedItems()` builds the list from `extensionsSlice` state + `settingsSlice` state. No new data sources.
- Toggle handler determines patch shape from `kind`: CLI items write to both `codingCli.enabledProviders` and `extensions.disabled`; others write only to `extensions.disabled`.

### 2. Settings Page Restructuring

Break the `SettingsView.tsx` monolith into a sidebar-navigated layout with 4 sections.

**Layout:**
- Fixed left sidebar (~200px) with section links
- Scrollable content area on the right
- "Manage Extensions" button prominent at the top of the content area (above first section, as it is today)
- "Extensions ↗" link at bottom of sidebar (like Chrome)

**Sections with complete setting mapping:**

| Section | Settings included |
|---------|-------------------|
| **Appearance** | Theme (system/light/dark), UI scale, terminal preview, terminal color scheme, font family, font size, line height, cursor blink |
| **Workspace** | Sidebar: sort mode, project badges, show subagents, ignore Codex subagents, show non-interactive sessions, hide empty sessions, hide by first chat, first chat must start. Panes: default new pane type, snap distance, icons on tabs, tab attention style, dismiss attention on. Notifications: sound on completion. Editor: external editor choice, custom editor command. Keyboard shortcuts display. |
| **Safety** | Auto-kill idle timeout, default working directory, remote access toggle, firewall status/fix, device management (rename/delete aliases), dev-mode warning |
| **Advanced** | Terminal scrollback buffer, OSC52 clipboard, warn external links, debug logging |

**Component structure:** Each section becomes its own component file extracted from the monolith:
- `AppearanceSettings.tsx`
- `WorkspaceSettings.tsx`
- `SafetySettings.tsx`
- `AdvancedSettings.tsx`

`SettingsView.tsx` becomes a thin shell — sidebar nav + section components.

**Navigation:** Scroll-based (like Chrome settings) — clicking a sidebar item scrolls to that section. Use `id` attributes on section containers and `scrollIntoView()`. Active sidebar item highlighted via IntersectionObserver on section headings.

**Removed:** The Coding CLIs section is dropped entirely. All provider config moves to extension cards on the Extensions page.

### 3. Extensions Page Enrichment

The existing Extensions page keeps its current shape and card layout. It gains expandable config on cards, and CLI providers (already in the registry) get their config fields surfaced here instead of in Settings.

**Grouping:** By kind — "CLI Agents", "Server Extensions", "Client Extensions" (same as current).

**Card (collapsed):** Same as current — icon, name, version, description (2-line clamp), category badge, running status badge (server extensions), keyboard shortcut, enable/disable toggle. Add an expand chevron or "Details" button.

**Card (expanded):** Config fields rendered from `ManagedItemConfig[]`:
- CLI extensions: model selector, permission mode dropdown, sandbox mode, starting directory path input — fields shown conditionally based on `cli.supportsModel`, `cli.supportsPermissionMode`, `cli.supportsSandbox`
- Server/client extensions with `contentSchema`: fields rendered from schema
- Save on change, debounced, dispatching `saveServerSettingsPatch` with appropriate patch shapes
- CLI config writes to `codingCli.providers[name].*`
- Extension `contentSchema` defaults write to extension-specific storage

**Enable/disable wiring:**
- CLI extensions: toggle writes to `codingCli.enabledProviders` (allowlist). Also respects `extensions.disabled` (denylist). Both gates must pass.
- Non-CLI extensions: toggle writes to `extensions.disabled`
- The `selectManagedItems()` selector normalizes both into `enabled: boolean`
- Future migration will converge to a single mechanism, but not in this work.

### 4. Network Quick-Access

Network access is promoted from a settings section to a quick-action in the main UI.

**Placement:** Icon button in the sidebar trough, right side, opposite the logo. Share/network/globe icon.

**Click behavior:** Opens a popover showing:
- Remote access toggle (on/off)
- Current access URL with copy button
- Connection status indicator

**Right-click:** Copy link with auth token (fast sharing path).

**What stays in Settings > Safety:** The full network/device management section remains in Safety for detailed configuration — firewall repair flow, privileged disable confirmation, dev-mode warnings, device alias editing. The popover is a quick-access surface for the most common actions, not a replacement for the full settings section.

### 5. Internal Wiring & Backward Compatibility

**Redux:**
- New `selectManagedItems()` selector in a shared file — builds `ManagedItem[]` from `extensionsSlice.registry` + `settingsSlice` provider configs
- Existing selectors and slice actions remain unchanged — the new selector is additive
- Card config changes dispatch to existing `saveServerSettingsPatch` with the same patch shapes

**Config file (`~/.freshell/config.json`):**
- No schema changes
- `codingCli.enabledProviders`, `codingCli.providers`, `extensions.disabled` all stay as-is

**REST API:**
- No endpoint changes
- `PATCH /api/settings` accepts the same patches
- `/api/extensions` returns the same registry

**Migration path (future, not this work):**
- Converge CLI enable/disable to use only `extensions.disabled` (denylist), deprecate `codingCli.enabledProviders`
- Move per-provider config from `codingCli.providers` into extension manifest or extension-scoped storage
- The UI components already work against `ManagedItem`, so they won't need changes

## Verification Requirements

All feature implementation must be verified using Chrome browser automation:
- Start the dev server in the worktree on a unique port
- Launch the page in Chrome and navigate to settings / extensions views
- Verify that UI renders correctly, interactions work, and state persists
- Do not claim something works without running it and checking the result

## Testing Strategy

- Extract settings section components with unit tests for each
- Existing `SettingsView` tests must be migrated/split to cover the new component structure — no test coverage lost
- Test `selectManagedItems()` selector with combined provider + extension state
- Test extension card expand/collapse and config field rendering
- Test enable/disable toggle writes correct patch shape for CLI vs non-CLI items
- Integration tests for settings save/load round-trip through the API
- E2E browser verification for the settings sidebar navigation and extension card interactions

## Follow-on Projects (Out of Scope)

- **Agent text chat feature** — A classic text chat pane type, managed as its own extension category separate from coding agents. The existing `agentChat.defaultPlugins` and `agentChat.providers` settings would be revisited as part of that effort. This is a missing feature in Freshell that should be added.
- **Full extension unification** — Converging the storage model so all enable/disable and per-item config uses one mechanism instead of the current split between `codingCli.*` and `extensions.*`.
