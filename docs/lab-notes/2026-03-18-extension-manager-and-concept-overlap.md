# Extension Manager & Concept Overlap — 2026-03-18

## What Was Built

- Extensions management page (Settings → Manage Extensions → dedicated view)
- Chrome-style card grid showing all discovered extensions by category
- Enable/disable toggles that persist to settings and filter the pane picker
- Iframe error detection for failed extension loads (P1 from prior session)

## The Concept Overlap Problem

Freshell has three overlapping concepts for "things you can add":

### 1. Extensions (`extensions/` directories, `freshell.json`)

**What they are:** Pane types. CLI wrappers, server apps, or static HTML that
render in the pane system.

**Config:** `settings.extensions.disabled` (blacklist)

**Discovery:** Scanned from `~/.freshell/extensions/`, `.freshell/extensions/`,
and `extensions/` on server startup.

**Enable/disable:** New toggle on the extensions management page. Disabled
extensions stay installed but don't appear in the pane picker.

### 2. Coding CLI Providers (`settings.codingCli`)

**What they are:** A subset of CLI extensions that get special treatment —
session history indexing, resume support, model/permission/sandbox args,
and per-provider config (default CWD, model, etc).

**Config:** `settings.codingCli.enabledProviders` (whitelist),
`settings.codingCli.providers` (per-provider defaults)

**Discovery:** Built from CLI extension manifests at startup
(`registerCodingCliCommands`).

**Enable/disable:** Whitelist in settings. Only whitelisted providers show in
the pane picker's CLI section.

**The overlap:** CLI extensions ARE extensions. They have `freshell.json`
manifests in `extensions/` and are discovered by the extension scanner. But
their enable/disable is controlled by `codingCli.enabledProviders`, NOT by
`extensions.disabled`. This means a CLI extension could be "enabled" in the
extension manager toggle but still hidden because it's not in
`enabledProviders`. Or vice versa.

### 3. Agent Chat Plugins (`settings.agentChat.defaultPlugins`)

**What they are:** Plugins for the Freshclaude agent chat system (the
built-in Claude API chat, not Claude Code CLI).

**Config:** `settings.agentChat.defaultPlugins` (list of plugin names)

**Discovery:** Hardcoded in the agent chat system.

**The overlap:** These are conceptually "extensions for the agent chat pane"
but use a completely separate config path. They don't show up in the
extensions management page at all.

## Where This Creates Confusion

1. **Two enable/disable mechanisms for CLI extensions.** A CLI extension can
   be disabled via `extensions.disabled` (our new toggle) OR by removing it
   from `codingCli.enabledProviders` (the existing settings page toggle).
   Both hide it from the pane picker, but through different code paths.
   Currently the PanePicker filters by BOTH — you need to pass both gates.

2. **Settings page has a separate CLI enable/disable section** that duplicates
   what the extensions page can do. The settings page shows per-provider
   toggles under "Coding CLIs" that control `enabledProviders`.

3. **Agent chat plugins are invisible.** The extensions page doesn't show
   them, and they can't be managed there.

## Recommendation

### Short-term (this PR)

Ship what we have. The extensions page is useful as-is for managing
non-CLI extensions (server, client), and the CLI cards provide visibility
into what's installed even if the primary enable/disable for CLIs remains
in the settings page.

The dual-gating (both `enabledProviders` AND `extensions.disabled`) is
technically correct — `enabledProviders` controls "is this CLI configured
and ready to use" while `extensions.disabled` controls "should this
extension appear at all." But it IS confusing.

### Medium-term

**Unify CLI enable/disable under the extensions page.** Remove the
per-provider on/off toggles from the settings page (keep the per-provider
config like default CWD, model, permission mode). When a CLI extension is
disabled on the extensions page, it should also be treated as not enabled
in `enabledProviders`. This gives one place to enable/disable, one place
to configure.

**Show agent chat plugins on the extensions page** as a fourth category.
They're conceptually extensions too — they add functionality to a pane type.

### Long-term

**Merge the config.** `codingCli.enabledProviders` and
`extensions.disabled` should be unified into a single mechanism. The
`extensions.disabled` blacklist is the better model — new extensions
are enabled by default, you explicitly disable what you don't want.
The `enabledProviders` whitelist was designed before the extension system
existed and could be migrated.

The manifest could also absorb provider-specific config. A CLI extension's
`freshell.json` already defines `supportsPermissionMode`, `supportsModel`,
etc. The per-provider defaults (default CWD, model, permission mode) could
live as extension-scoped settings rather than in a separate
`codingCli.providers` config tree.

## Manifest Expansion (Not Done Yet)

The following optional fields would improve the extensions page but aren't
blocking:

- `author` — string or `{ name, url }` for attribution
- `homepage` — URL to docs/repo
- `repository` — GitHub URL (precursor to install-from-URL)

These are additive changes to `ExtensionManifestSchema` and
`ClientExtensionEntry`.

## Files Changed

- `src/components/ExtensionsView.tsx` — new component (extensions page)
- `src/components/SettingsView.tsx` — added "Manage Extensions" button
- `src/components/Sidebar.tsx` — added `'extensions'` to `AppView` type
- `src/App.tsx` — added extensions view routing
- `src/components/panes/PanePicker.tsx` — filter by `extensions.disabled`
- `shared/settings.ts` — added `extensions.disabled` to settings schema
