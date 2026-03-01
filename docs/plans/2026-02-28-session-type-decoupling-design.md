# Session Type Decoupling Design

**Date:** 2026-02-28
**Status:** Approved
**Branch:** justin/session-type-decoupling

## Problem

Freshclaude sessions show a Claude CLI icon in the sidebar instead of the Freshclaude icon. This happens because freshclaude runs Claude Code under the hood, so the session JSONL file ends up in `~/.claude/projects/...`. The server-side session indexer determines provider by filesystem path, sees the file under `~/.claude/`, and tags it as `provider: 'claude'`. The sidebar then renders the Claude icon.

The pane itself correctly shows the Freshclaude icon (it has `kind: 'agent-chat'` with `provider: 'freshclaude'`), but that information never flows back to the sidebar's session list for closed sessions.

## Root Cause

The `provider` field does double duty:
1. **Filesystem/CLI identity** — which CLI tool created the session files on disk
2. **UI identity** — what icon and label to show

These are the same for Claude CLI and Codex, but diverge for freshclaude (and will diverge further as custom pane types are added).

## Design Decisions

### 1. Decouple `provider` from UI identity via `sessionType`

- **`provider`** (unchanged) — `CodingCliProviderName` — means "which CLI's files are these on disk." Used for filesystem indexing, session matching, and CLI operations.
- **`sessionType`** (new) — `string` — means "what kind of session is this." Used for icon/label rendering. Defaults to `provider` when not explicitly set.

`sessionType` is an open string rather than a closed enum. Known types (claude, codex, freshclaude, kilroy) get specific icons and labels. Unknown types get a generic icon and use the type string as the label. This supports future custom pane types without code changes.

### 2. Persist `sessionType` in `~/.freshell/session-metadata.json`

A dedicated file for system-generated session metadata, separate from:
- `config.json` (user settings and preferences)
- Session JSONL files (owned by CLI tools, not ours to modify)

**Format:**
```json
{
  "version": 1,
  "sessions": {
    "claude:abc-123-def": { "sessionType": "freshclaude" },
    "claude:xyz-789-ghi": { "sessionType": "kilroy" }
  }
}
```

- Keyed by `provider:sessionId` composite key (existing pattern)
- Each entry is an object for future extensibility
- Only sessions with non-default `sessionType` get entries
- Write-once at session creation, read at indexer refresh
- No cleanup needed — orphaned entries are harmless (a few bytes each)

### 3. Auto-tag on creation only

When freshclaude (or kilroy, or future custom pane types) creates a session, the server tags it with the appropriate `sessionType`. Old sessions from before this feature stay as their default (provider value). No retroactive detection, no manual override UI.

### 4. Registry-based icon/label resolution

A unified `resolveSessionTypeConfig(sessionType: string)` function replaces direct `ProviderIcon`/`getProviderLabel` calls in the sidebar. Lookup chain:

1. Check `CODING_CLI_PROVIDER_CONFIGS` (claude, codex, opencode, gemini, kimi)
2. Check `AGENT_CHAT_PROVIDER_CONFIGS` (freshclaude, kilroy)
3. Future: user-registered pane type configs
4. Fallback: generic icon + use sessionType string as label

## Data Flow

### Write Path (session creation)
1. User opens a freshclaude pane
2. Agent-chat system spawns Claude Code, obtains session ID
3. Client or server calls `POST /api/session-metadata` with `{ provider, sessionId, sessionType: 'freshclaude' }`
4. Server writes entry to `~/.freshell/session-metadata.json`

### Read Path (session list)
1. Session indexer discovers JSONL files, builds session list with `provider: 'claude'`
2. Before returning via `/api/sessions`, indexer merges `sessionType` from `session-metadata.json`
3. If no entry exists, `sessionType` defaults to `provider` value
4. Frontend receives `sessionType` on each session object

### Frontend Rendering
1. `SidebarSessionItem` gets `sessionType: string` field
2. `SidebarItem` renders icon via `resolveSessionTypeConfig(item.sessionType)`
3. Tooltip uses resolved label
4. `PaneIcon` already works correctly for open panes (reads from pane content) — no changes needed

### What Doesn't Change
- `provider` field stays everywhere for filesystem/CLI/matching logic
- Session matching/dedup still uses `provider:sessionId`
- Pane content types unchanged
- `extractSessionRef()` still returns `provider: 'claude'` for agent-chat panes (correct for matching)

## Testing Strategy

### Server-Side
- `SessionMetadataStore` — read/write, missing file handling, corrupt file resilience
- Session indexer merges `sessionType` from metadata store
- `POST /api/session-metadata` endpoint validation

### Frontend
- `resolveSessionTypeConfig()` — known types return correct icon/label, unknown types get fallback
- `SidebarItem` renders correct icon based on `sessionType`
- Memo comparators include `sessionType`
- `buildSessionItems` propagates `sessionType`

### Integration
- Create freshclaude session -> sidebar shows freshclaude icon
- Create Claude CLI session -> sidebar shows claude icon (unchanged)
- Restart server -> freshclaude session persists correct icon

## Scope Exclusions

- No migration of `sessionOverrides` out of `config.json` (separate concern, future work)
- No manual override UI for `sessionType`
- No retroactive detection of old freshclaude sessions
- `HistoryView` and `SessionView` icon changes deferred if complex (sidebar is the primary surface)
