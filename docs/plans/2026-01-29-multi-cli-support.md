# Multi-CLI Support Plan: Adding Codex and Future Coding CLIs

## Executive Summary

This document outlines the plan to generalize Freshell's Claude Code integration to support multiple coding CLIs, starting with OpenAI Codex and designed for future expansion to OpenCode, Kimi CLI, and Gemini CLI.

## Current State: Claude Code Integration Inventory

### Backend Components

| File | Lines | Purpose | Generalization Potential |
|------|-------|---------|-------------------------|
| `server/claude-indexer.ts` | 1-326 | Watches `~/.claude/projects/*/sessions/*.jsonl`, parses sessions | Medium - path/parsing logic is Claude-specific |
| `server/claude-session.ts` | 1-221 | Spawns live Claude CLI sessions, manages subprocess lifecycle | Low - tied to Claude's `--output-format stream-json` |
| `server/claude-stream-types.ts` | 1-130 | TypeScript types for Claude's stream-json events | Low - Claude-specific event schema |
| `server/ws-handler.ts` | 96-514 | WebSocket handlers for `claude.create/input/kill` | Medium - protocol structure is generic |
| `server/terminal-registry.ts` | 175-483 | Terminal spawning with `mode='claude'` | High - already supports multiple modes |
| `server/index.ts` | 132-284 | REST endpoints `/api/sessions`, broadcasts | High - data-agnostic |

### Frontend Components

| File | Purpose | Generalization Potential |
|------|---------|-------------------------|
| `src/store/claudeSlice.ts` | Redux state for live Claude sessions | High - generic session pattern |
| `src/store/claudeThunks.ts` | Async thunk for creating Claude tabs | Medium - parameterizable |
| `src/lib/claude-types.ts` | Client-side event type definitions | Low - Claude-specific |
| `src/store/types.ts` | Tab/session types with `mode: 'shell' | 'claude' | 'codex'` | High - already multi-modal |
| `src/components/ClaudeSessionView.tsx` | Renders Claude session viewer | High - could be parameterized |
| `src/components/HistoryView.tsx` | Session history browser | Medium - Claude-specific labels |
| `src/components/claude/MessageBubble.tsx` | Message rendering | High - generic pattern |

### Key Integration Points

1. **Session Discovery**: `~/.claude/projects/*/sessions/*.jsonl`
2. **Live Session Spawning**: `claude --output-format stream-json`
3. **Session Resume**: `claude --resume <sessionId>`
4. **Event Protocol**: System init, messages, tool calls, results

---

## Codex CLI Analysis

### Session Storage

**Location**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

**Filename Format**: `rollout-YYYY-MM-DDTHH-MM-SS-UUID.jsonl`

Example: `rollout-2026-01-29T10-14-43-019c0af6-f843-7381-854b-1347f1e2c359.jsonl`

### JSONL Event Types

Based on actual Codex session files, the event types are:

```typescript
// Line 1: Session metadata
{
  "timestamp": "2026-01-29T18:14:43.573Z",
  "type": "session_meta",
  "payload": {
    "id": "019c0af6-f843-7381-854b-1347f1e2c359",
    "cwd": "D:\\Users\\Dan\\...",
    "cli_version": "0.92.0",
    "source": "exec",
    "model_provider": "openai",
    "base_instructions": { "text": "..." },
    "git": { "commit_hash": "...", "branch": "...", "repository_url": "..." }
  }
}

// User messages
{
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "user" | "developer" | "assistant",
    "content": [{ "type": "input_text" | "output_text", "text": "..." }]
  }
}

// Agent reasoning
{
  "type": "event_msg",
  "payload": {
    "type": "agent_reasoning" | "agent_message" | "token_count",
    "text": "...",
    "message": "..."
  }
}

// Function calls
{
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "exec_command",
    "arguments": "...",
    "call_id": "..."
  }
}

// Function results
{
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "...",
    "output": "..."
  }
}

// Turn context
{
  "type": "turn_context",
  "payload": {
    "cwd": "...",
    "approval_policy": "never",
    "sandbox_policy": { "type": "read-only" },
    "model": "gpt-5.2-codex"
  }
}
```

### CLI Options

| Option | Description |
|--------|-------------|
| `codex exec` | Non-interactive mode |
| `--json` | Output newline-delimited JSON events |
| `codex resume [SESSION_ID]` | Resume previous session |
| `--last` | Resume most recent session |
| `-m, --model` | Override model (e.g., `gpt-5-codex`) |
| `--sandbox read-only\|workspace-write\|danger-full-access` | Safety mode |
| `--ask-for-approval` | Control approval timing |

### Key Differences from Claude

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| Session path | `~/.claude/projects/*/sessions/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
| File naming | `<uuid>.jsonl` | `rollout-<timestamp>-<uuid>.jsonl` |
| Session ID in filename | UUID only | Embedded in filename |
| Metadata | First line has `type: "init"` | First line has `type: "session_meta"` |
| User message format | `{ role: "user", content: [...] }` | `{ role: "user", content: [{ type: "input_text", text }] }` |
| Tool calls | `tool_use` content blocks | `function_call` response items |
| Output format flag | `--output-format stream-json` | `--json` |
| Resume flag | `--resume <sessionId>` | `codex resume <sessionId>` |

---

## Other CLIs on Roadmap

### OpenCode
- **Install**: `npm i -g opencode-ai@latest`
- **Config**: `~/.local/share/opencode/`
- **Session export**: `opencode export [sessionID]` → JSON
- **Output format**: `--format json` for raw JSON events
- **Resume**: `--continue/-c`, `--session/-s [ID]`
- **Multi-provider**: Claude, GPT, Gemini, local models

### Kimi CLI
- **Install**: `uv tool install --python 3.13 kimi-cli`
- **Protocol**: ACP (Agent Client Protocol) + MCP
- **Context**: 128K tokens
- **Python-based**: Different ecosystem

### Gemini CLI
- **Install**: `npm install -g @google/gemini-cli`
- **Config**: `~/.gemini/settings.json`
- **Output format**: `--output-format stream-json` (same as Claude!)
- **Checkpointing**: Save/resume conversations
- **Free tier**: 60 req/min, 1000/day

---

## Architectural Approach

### Option A: Provider Adapter Pattern (Recommended)

Create a `CodingCliProvider` interface that each CLI implements:

```typescript
interface CodingCliProvider {
  // Identity
  readonly name: string;  // 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'
  readonly displayName: string;
  readonly homeDir: string;  // ~/.claude, ~/.codex, etc.

  // Session discovery
  getSessionGlob(): string;
  parseSessionFile(content: string): ParsedSession;
  extractSessionId(filename: string): string;

  // Live session spawning
  getCommand(): string;  // 'claude', 'codex', etc.
  getStreamArgs(options: SpawnOptions): string[];
  getResumeArgs(sessionId: string): string[];

  // Event parsing
  parseEvent(line: string): NormalizedEvent;

  // Optional: Provider-specific features
  supportsLiveStreaming(): boolean;
  supportsSessionResume(): boolean;
}
```

### Normalized Event Types

Create a common event format that all providers map to:

```typescript
type NormalizedEventType =
  | 'session.init'      // Session started
  | 'message.user'      // User message
  | 'message.assistant' // Assistant response
  | 'tool.call'         // Tool/function invocation
  | 'tool.result'       // Tool output
  | 'session.end'       // Session completed
  | 'token.usage'       // Token/cost tracking
  | 'reasoning'         // Chain-of-thought (if exposed)

interface NormalizedEvent {
  type: NormalizedEventType;
  timestamp: string;
  sessionId: string;
  raw: unknown;  // Original provider-specific data

  // Type-specific fields
  message?: { role: string; content: string };
  toolCall?: { id: string; name: string; arguments: unknown };
  toolResult?: { id: string; output: string; isError: boolean };
  sessionInfo?: { cwd: string; model: string; provider: string };
  tokenUsage?: { input: number; output: number; total: number };
}
```

### File Structure

```
server/
  coding-cli/
    types.ts              # Common interfaces
    provider.ts           # Base provider interface
    providers/
      claude.ts           # Claude Code adapter
      codex.ts            # Codex adapter
      opencode.ts         # OpenCode adapter (future)
      gemini.ts           # Gemini CLI adapter (future)
      kimi.ts             # Kimi CLI adapter (future)
    session-indexer.ts    # Generalized indexer (replaces claude-indexer.ts)
    session-manager.ts    # Generalized session manager (replaces claude-session.ts)

src/
  lib/
    coding-cli-types.ts   # Client-side normalized types
  components/
    SessionView.tsx       # Generalized session viewer
    session/
      MessageBubble.tsx   # Generic message rendering
      ToolCallBlock.tsx   # Generic tool call display
```

### Migration Strategy

1. **Phase 1: Extract Interface**
   - Create `CodingCliProvider` interface
   - Implement `ClaudeProvider` wrapping existing code
   - No behavior changes

2. **Phase 2: Add Codex**
   - Implement `CodexProvider`
   - Create `CodexIndexer` following same patterns
   - Add Codex session viewing UI
   - Update `HistoryView` to show both

3. **Phase 3: Generalize UI**
   - Rename `ClaudeSessionView` → `SessionView`
   - Parameterize message rendering
   - Add provider-specific theming/icons

4. **Phase 4: Future CLIs**
   - Each new CLI = new provider implementation
   - Minimal UI changes needed

---

## Implementation Tasks

### Phase 1: Interface Extraction (~2-3 days)

- [ ] Define `CodingCliProvider` interface
- [ ] Define `NormalizedEvent` types
- [ ] Create `server/coding-cli/` directory structure
- [ ] Implement `ClaudeProvider` adapter
- [ ] Create generalized `SessionIndexer` class
- [ ] Update `server/index.ts` to use new structure
- [ ] Write unit tests for provider/indexer

### Phase 2: Codex Support (~3-4 days)

- [ ] Implement `CodexProvider` adapter
- [ ] Write Codex session parsing tests
- [ ] Add Codex to `SessionIndexer` watch list
- [ ] Update `terminal-registry.ts` for Codex spawning
- [ ] Add Codex WebSocket handlers
- [ ] Update frontend types for Codex mode
- [ ] Add Codex tab creation
- [ ] Write integration tests

### Phase 3: UI Generalization (~2-3 days)

- [ ] Rename/generalize `ClaudeSessionView`
- [ ] Update `HistoryView` for multi-provider
- [ ] Add provider icons/badges
- [ ] Update sidebar session list
- [ ] Test with both Claude and Codex sessions

### Phase 4: Polish (~1-2 days)

- [ ] Config for enabled providers
- [ ] Provider-specific settings
- [ ] Documentation updates
- [ ] E2E tests

---

## Open Questions

1. **Session grouping**: Should Codex sessions be grouped by project like Claude, or by date (as they're stored)?
   - Claude: `~/.claude/projects/{projectHash}/sessions/*.jsonl`
   - Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
   - Proposal: Extract `cwd` from metadata and group by project path for both

2. **Live streaming**: Does Codex support the same live streaming as Claude?
   - Claude: `claude --output-format stream-json` provides real-time events
   - Codex: `codex exec --json` may be non-interactive only
   - Need to test: Can we run `codex` interactively with JSON output?

3. **Session resume**: Different resume semantics
   - Claude: `--resume <sessionId>` on same `claude` command
   - Codex: `codex resume <sessionId>` is a subcommand
   - Need to handle this in provider interface

4. **Project association**: How to associate Codex sessions with projects?
   - Claude has explicit project paths in directory structure
   - Codex stores cwd in metadata - need to extract and index

---

## References

- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex CLI GitHub](https://github.com/openai/codex)
- [codex-history-list](https://github.com/shinshin86/codex-history-list) - Third-party session parser
- [OpenCode Docs](https://opencode.ai/docs/cli/)
- [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
