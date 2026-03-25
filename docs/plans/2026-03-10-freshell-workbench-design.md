# Freshell Workbench — Extension Design

**Date:** 2026-03-10
**Status:** Approved

## Problem

Claude sessions are siloed per repo. Work that spans multiple repos (project migrations, cross-repo investigations) has no single place to see status. Experiments and research branches get lost. There's no way to recall "what was I doing on that auth thing?" or "what experiments have I run in this repo?"

## Solution

A Freshell client extension ("workbench") that provides a taggable, filterable view of all Claude sessions across repos. Sessions are organized along four optional dimensions: repo (auto-populated), project, type, and status. The view groups by one dimension and filters by the others.

## Data Model

### Dimensions

Four single-select dimensions. Repo is auto-populated; the others are user-defined.

| Dimension | Source | Example values |
|-----------|--------|----------------|
| **Repo** | Auto from session `projectPath` | `freshell`, `kilroy`, `cxdb` |
| **Project** | User-defined | "auth migration", "perf investigation" |
| **Type** | User-defined | "idea", "experiment", "investigation" |
| **Status** | User-defined | "preliminary", "active", "abandoned", "merged" |

Users can edit what values exist in each dimension via the UI.

### Storage

A single JSON file at `~/.freshell/extensions/freshell-workbench/data.json`:

```json
{
  "dimensions": {
    "project": ["auth migration", "perf investigation"],
    "type": ["idea", "experiment", "investigation"],
    "status": ["preliminary", "active", "abandoned", "merged"]
  },
  "tags": {
    "claude:abc123": { "project": "auth migration", "type": "experiment", "status": "active" },
    "claude:def456": { "project": null, "type": "idea", "status": "preliminary" }
  }
}
```

Session keys use `{provider}:{sessionId}` format to match Freshell's session model.

## UI

### Main View

- **Group-by selector** at top: pick which dimension becomes columns (repo / project / type / status)
- **Filter bar** below: dropdowns for the other three dimensions to narrow results
- **Toggle**: show/hide untagged sessions
- **Search**: text input that queries Freshell's `GET /api/sessions/search` endpoint
- Sessions appear as cards in their column, showing: title/summary, repo, and tag badges
- Click a tag badge to edit it (inline dropdown)
- Click a session card to expand and show summary/first message inline

### Dimension Management

- A settings/gear area to add/remove/rename values for project, type, and status dimensions
- Repo values are derived automatically and not editable

### Session Tagging

- From the main view, click a session's tag area to assign dimension values via dropdowns
- From search results, same interaction

## Technical Architecture

### Extension Type

Client-only extension. No server process needed — reads session data from Freshell's existing REST API and stores tag data in a local JSON file.

### Manifest (`freshell.json`)

```json
{
  "name": "freshell-workbench",
  "version": "0.1.0",
  "label": "Workbench",
  "description": "Track experiments and projects across repos",
  "category": "client",
  "icon": "layout-dashboard",
  "client": {
    "entry": "dist/index.html"
  },
  "picker": {
    "group": "tools"
  }
}
```

### Data Flow

1. Extension iframe loads, fetches `GET /api/sessions` to get all sessions with repo info
2. Reads `data.json` from local storage (or creates it with defaults on first run)
3. Merges session data with tag data for display
4. Tag edits write back to `data.json`
5. Search uses `GET /api/sessions/search?q=QUERY&tier=title`

### Storage Approach

The extension runs in an iframe on the same origin as Freshell, so it can:
- Call Freshell's REST API for session data
- Use `localStorage` namespaced under `freshell-workbench:` for the tag/dimension data
- Alternatively, persist to a JSON file via a small write endpoint (future)

For V1, `localStorage` is simplest and avoids needing any server-side changes. The data is small (dimension definitions + session-to-tag mappings). If persistence across browsers/machines becomes important later, we can add file-based storage.

### Future: postMessage Navigation

When Freshell adds its planned postMessage bridge for extensions, the workbench can send a "navigate to session" message to open the session detail view in the main app. Until then, session details are shown inline in the extension.

## Tech Stack

- React (matches Freshell's stack for familiarity)
- Tailwind CSS (matches Freshell styling)
- Vite for build
- No external dependencies beyond what's needed for the UI

## Scope — What's In V1

- Four-dimension tagging with user-defined values
- Group-by / filter view
- Session search via Freshell API
- Inline session detail (title, summary, first message)
- localStorage persistence
- Dimension value management (add/remove/rename)

## Scope — What's NOT in V1

- postMessage navigation to Freshell session views
- File-based persistence / sync across machines
- Drag-and-drop (sessions are tagged via dropdowns)
- Branch status awareness (merged/stale/ahead-behind)
- Auto-tagging based on branch names or content
