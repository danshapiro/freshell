# Multi-CLI Architecture Specification

## Executive Summary

This specification defines a modular, extensible architecture for supporting multiple coding CLIs in Freshell. Based on exhaustive research of Claude Code, Codex CLI, OpenCode, Gemini CLI, and Kimi CLI, this document provides implementation-ready details for a provider abstraction layer.

**Verified CLI Versions (January 2026):**
- Claude Code 2.x
- Codex CLI 0.92+
- OpenCode (SST)
- Gemini CLI (Google)
- Kimi CLI (Moonshot)

---

## Part 1: CLI Comparison Matrix (Verified)

### Session Storage Comparison

| CLI | Home Directory | Env Override | Session Path Pattern | File Format | Session ID Source |
|-----|---------------|--------------|---------------------|-------------|-------------------|
| **Claude Code** | `~/.claude/` | `CLAUDE_CONFIG_DIR` | `projects/{path-hash}/sessions/{uuid}.jsonl` | JSONL | UUID in filename |
| **Codex CLI** | `~/.codex/` | `CODEX_HOME` | `sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl` | JSONL | UUID in filename |
| **OpenCode** | `~/.local/share/opencode/` | XDG spec only | `storage/session/{projectID}/{sessionID}.json` + separate message/part files | JSON (multi-file) | ID in filename |
| **Gemini CLI** | `~/.gemini/` | **None** | `tmp/{project_hash}/chats/session-*.json` | JSON (monolithic) | In filename |
| **Kimi CLI** | `~/.kimi/` | **None** | `sessions/{workdir_md5}/{session_uuid}/` | JSONL (checkpoint-based) | UUID in directory |

**Important Corrections:**
- `GEMINI_HOME` does **NOT exist** (requested as `GEMINI_CONFIG_DIR` in Issue #2815, not implemented)
- `KIMI_HOME` does **NOT exist** (hardcoded to `~/.kimi/`)
- `OPENCODE_HOME` does **NOT exist** - uses XDG spec with `OPENCODE_CONFIG` for config file path only
- Gemini JSONL migration (Issue #15292) is **NOT complete** - still uses JSON

### Streaming Output Comparison

| CLI | Flag | Format | Interactive Support | Notes |
|-----|------|--------|---------------------|-------|
| **Claude Code** | `--output-format stream-json` | NDJSON | **Yes** | Full streaming in interactive mode |
| **Codex CLI** | `codex exec --json` | NDJSON | **No** (exec only) | Interactive TUI has NO JSON option |
| **OpenCode** | `--format json` / SSE | JSON/SSE | **Yes** (via serve) | Requires `opencode serve` for streaming |
| **Gemini CLI** | `--output-format stream-json` | NDJSON | **Yes** | Works in interactive mode |
| **Kimi CLI** | `--output-format stream-json` | NDJSON | **Yes** | Also `--print` for non-interactive |

### Resume Capabilities

| CLI | Resume by ID | Resume Latest | Command Syntax |
|-----|--------------|---------------|----------------|
| **Claude Code** | `--resume <id>` | `--continue` | `claude --resume <uuid>` |
| **Codex CLI** | `codex resume <id>` | `--last` | `codex resume --last` or `codex resume <uuid>` |
| **OpenCode** | `--session <id>` | `--continue` | `opencode --session <id>` or `opencode -c` |
| **Gemini CLI** | `--resume <id>` | `--resume latest` | `gemini --resume latest` or `--resume <uuid>` |
| **Kimi CLI** | `--session <id>` | `--continue` | `kimi --continue` or `kimi --session <id>` |

### Auto-Approval Flags (Verified)

| CLI | Flag | Notes |
|-----|------|-------|
| **Claude Code** | `--dangerously-skip-permissions` | Also `--permission-mode` for plan mode |
| **Codex CLI** | `--dangerously-bypass-approvals-and-sandbox` or `--yolo` | `--yolo` is real alias |
| **OpenCode** | **None** (config-based) | Use `"permission": "allow"` in `opencode.json` |
| **Gemini CLI** | `--yolo` or `-y` | Real flag, also `Ctrl+Y` to toggle |
| **Kimi CLI** | `--yolo` | Real flag, also `/yolo` slash command |

### MCP Support

| CLI | MCP Client | MCP Server | Config Location |
|-----|------------|------------|-----------------|
| **Claude Code** | Yes | Yes (`claude mcp serve`) | `~/.claude.json`, `.mcp.json` |
| **Codex CLI** | Yes | Yes (`codex mcp-server`) | `~/.codex/config.toml` |
| **OpenCode** | Yes | No | `opencode.json` |
| **Gemini CLI** | Yes | No | `~/.gemini/settings.json` |
| **Kimi CLI** | Yes | No | `~/.kimi/mcp.json` |

### Platform Support

| CLI | Native Windows | WSL | macOS | Linux |
|-----|---------------|-----|-------|-------|
| **Claude Code** | Limited | Recommended | Full | Full |
| **Codex CLI** | Experimental | Recommended | Full | Full |
| **OpenCode** | Limited (permission issues) | Recommended | Full | Full |
| **Gemini CLI** | **Full** (native) | Supported | Full | Full |
| **Kimi CLI** | PowerShell install | Recommended | Full | Full |

---

## Part 2: Normalized Event Schema

All CLIs will be normalized to a common event format:

```typescript
// ============================================================
// CORE TYPES
// ============================================================

type CodingCliProvider = 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi';

type NormalizedEventType =
  | 'session.start'      // Session initialized
  | 'session.end'        // Session completed/terminated
  | 'message.user'       // User message
  | 'message.assistant'  // Assistant text response
  | 'message.delta'      // Streaming text delta
  | 'thinking'           // Reasoning/chain-of-thought
  | 'tool.call'          // Tool invocation request
  | 'tool.result'        // Tool execution result
  | 'token.usage'        // Token/cost tracking
  | 'error'              // Error occurred
  | 'approval.request'   // Permission request (interactive)
  | 'approval.response'; // Permission response

// ============================================================
// NORMALIZED EVENT
// ============================================================

interface NormalizedEvent {
  type: NormalizedEventType;
  timestamp: string;          // ISO8601
  provider: CodingCliProvider;
  sessionId: string;          // Provider's session ID
  sequenceNumber: number;     // Monotonic, for ordering
  raw: unknown;               // Original provider event for debugging

  // Type-specific payloads (only one populated per event)
  session?: SessionPayload;
  message?: MessagePayload;
  tool?: ToolPayload;
  tokens?: TokenPayload;
  error?: ErrorPayload;
  approval?: ApprovalPayload;
}

interface SessionPayload {
  cwd: string;
  model: string;
  version?: string;           // CLI version
  tools?: string[];           // Available tools
  gitBranch?: string;
}

interface MessagePayload {
  role: 'user' | 'assistant';
  content: string;
  isDelta?: boolean;          // True for streaming deltas
  messageId?: string;         // For correlating deltas
}

interface ToolPayload {
  callId: string;
  name: string;
  // For tool.call:
  arguments?: Record<string, unknown>;
  // For tool.result:
  output?: string;
  isError?: boolean;
  exitCode?: number;          // For shell commands
}

interface TokenPayload {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  totalCost?: number;         // USD
}

interface ErrorPayload {
  message: string;
  code?: string;
  recoverable: boolean;
}

interface ApprovalPayload {
  requestId: string;
  toolName: string;
  description: string;
  approved?: boolean;         // For response
}

// ============================================================
// SESSION COMPOSITE KEY
// ============================================================

/**
 * Sessions are uniquely identified by provider + sessionId.
 * This prevents collisions across providers.
 */
type SessionCompositeKey = `${CodingCliProvider}:${string}`;

function makeSessionKey(provider: CodingCliProvider, sessionId: string): SessionCompositeKey {
  return `${provider}:${sessionId}`;
}

function parseSessionKey(key: SessionCompositeKey): { provider: CodingCliProvider; sessionId: string } {
  const [provider, ...rest] = key.split(':');
  return { provider: provider as CodingCliProvider, sessionId: rest.join(':') };
}
```

---

## Part 3: Provider Configuration Schema

Data-driven configuration with explicit special handling markers:

```typescript
// ============================================================
// PROVIDER CONFIGURATION
// ============================================================

interface CodingCliProviderConfig {
  // Identity
  id: CodingCliProvider;
  displayName: string;
  icon?: string;                    // Icon identifier for UI
  color?: string;                   // Brand color for UI

  // Environment
  homeEnvVar: string | null;        // null if no env var override exists
  defaultHome: string;              // e.g., '~/.claude', '~/.codex'
  commandEnvVar: string;            // e.g., 'CLAUDE_CMD'
  defaultCommand: string;           // e.g., 'claude'

  // Session Discovery
  sessionDiscovery: {
    // Glob pattern relative to home directory
    pattern: string;

    // How to extract session ID from path
    sessionIdExtractor: 'filename' | 'filename-uuid-suffix' | 'directory-name' | 'parse-file';
    sessionIdRegex?: string;        // Regex with capture group for ID

    // How sessions are organized
    groupBy: 'project-directory' | 'date' | 'flat';

    // For project-directory grouping, how to get project path
    projectPathSource?: 'directory-structure' | 'session-metadata';

    // Special handling flags
    requiresMultiFileReconstruction?: boolean;  // OpenCode
    requiresMetadataParse?: boolean;            // Codex (date-based needs cwd from file)
  };

  // Session File Parsing
  sessionParsing: {
    format: 'jsonl' | 'json' | 'multi-file';

    // For multi-file format, additional patterns
    messagePattern?: string;        // e.g., 'storage/message/{sessionId}/*.json'
    partPattern?: string;           // e.g., 'storage/part/{messageId}/*.json'

    // JSON paths for metadata (using lodash.get style paths)
    paths: {
      sessionId?: string;           // null if from filename/directory
      cwd: string;
      model?: string;
      timestamp?: string;
      version?: string;
      title?: string;
    };

    // Message identification for JSONL/JSON array formats
    messageMatching?: {
      userRole: { field: string; value: string | string[] };
      assistantRole: { field: string; value: string | string[] };
      contentPath: string;
    };
  };

  // Live Session Spawning
  spawning: {
    // Whether this CLI supports streaming JSON in interactive mode
    supportsInteractiveStreaming: boolean;

    // Command structure for streaming mode (null if not supported)
    streamCommand?: {
      subcommand?: string;          // e.g., 'exec' for Codex
      args: string[];               // e.g., ['--output-format', 'stream-json']
    };

    // Command structure for resume
    resumeCommand: {
      style: 'flag' | 'subcommand';
      flag?: string;                // e.g., '--resume'
      subcommand?: string;          // e.g., 'resume'
      latestFlag?: string;          // e.g., '--last', '--continue'
    };

    // Flags
    cwdFlag?: string | null;        // null = uses current directory
    modelFlag?: string;             // e.g., '--model', '-m'

    // Auto-approval
    autoApproveFlag?: string | null; // null = config-based (OpenCode)
    autoApproveConfig?: {           // For config-based approval (OpenCode)
      configKey: string;
      configValue: unknown;
    };
  };

  // Event Parsing (for streaming output)
  eventParsing: {
    // Map provider event type strings to normalized types
    eventTypeField: string;         // e.g., 'type'
    eventSubtypeField?: string;     // e.g., 'subtype' for Claude

    eventMap: Record<string, NormalizedEventType>;

    // Compound event types (e.g., 'item.completed.agent_message')
    compoundEventSeparator?: string; // e.g., '.'
    compoundTypeFields?: string[];   // Fields to concatenate

    // JSON paths for extracting data
    paths: {
      content?: string;
      toolName?: string;
      toolCallId?: string;
      toolArgs?: string;
      toolOutput?: string;
      tokenInput?: string;
      tokenOutput?: string;
      tokenCached?: string;
    };
  };
}

// ============================================================
// JSON PATH RESOLUTION
// ============================================================

/**
 * Resolves a dot-notation path on an object.
 * Supports:
 *   - 'foo.bar' -> obj.foo.bar
 *   - 'foo[0].bar' -> obj.foo[0].bar
 *   - 'foo.*.bar' -> NOT supported (use explicit indices)
 *
 * Returns undefined for missing paths (never throws).
 */
function resolvePath(obj: unknown, path: string): unknown {
  if (!path || obj === null || obj === undefined) return undefined;

  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
```

---

## Part 4: Provider Configurations (Verified)

### Claude Code Configuration

```typescript
const CLAUDE_CONFIG: CodingCliProviderConfig = {
  id: 'claude',
  displayName: 'Claude Code',
  icon: 'anthropic',
  color: '#D97706',  // Anthropic orange

  homeEnvVar: 'CLAUDE_CONFIG_DIR',
  defaultHome: '~/.claude',
  commandEnvVar: 'CLAUDE_CMD',
  defaultCommand: 'claude',

  sessionDiscovery: {
    pattern: 'projects/*/sessions/*.jsonl',
    sessionIdExtractor: 'filename',
    sessionIdRegex: '^([a-f0-9-]+)\\.jsonl$',
    groupBy: 'project-directory',
    projectPathSource: 'directory-structure',
  },

  sessionParsing: {
    format: 'jsonl',
    paths: {
      sessionId: 'session_id',
      cwd: 'cwd',
      model: 'model',
      timestamp: 'timestamp',
      version: 'claude_code_version',
    },
    messageMatching: {
      userRole: { field: 'type', value: 'user' },
      assistantRole: { field: 'type', value: 'assistant' },
      contentPath: 'message.content',
    },
  },

  spawning: {
    supportsInteractiveStreaming: true,
    streamCommand: {
      args: ['--output-format', 'stream-json', '--verbose'],
    },
    resumeCommand: {
      style: 'flag',
      flag: '--resume',
      latestFlag: '--continue',
    },
    cwdFlag: null,  // Uses current directory
    modelFlag: '--model',
    autoApproveFlag: '--dangerously-skip-permissions',
  },

  eventParsing: {
    eventTypeField: 'type',
    eventSubtypeField: 'subtype',
    eventMap: {
      'system.init': 'session.start',
      'assistant': 'message.assistant',
      'user': 'message.user',
      'result.success': 'session.end',
      'result.error': 'error',
    },
    paths: {
      content: 'message.content',
      toolName: 'name',
      toolCallId: 'id',
      tokenInput: 'usage.input_tokens',
      tokenOutput: 'usage.output_tokens',
    },
  },
};
```

### Codex CLI Configuration

```typescript
const CODEX_CONFIG: CodingCliProviderConfig = {
  id: 'codex',
  displayName: 'Codex CLI',
  icon: 'openai',
  color: '#10A37F',  // OpenAI green

  homeEnvVar: 'CODEX_HOME',
  defaultHome: '~/.codex',
  commandEnvVar: 'CODEX_CMD',
  defaultCommand: 'codex',

  sessionDiscovery: {
    pattern: 'sessions/*/*/*/*/rollout-*.jsonl',  // YYYY/MM/DD/
    sessionIdExtractor: 'filename-uuid-suffix',
    sessionIdRegex: 'rollout-[\\dT-]+-([a-f0-9-]+)\\.jsonl$',
    groupBy: 'date',
    projectPathSource: 'session-metadata',
    requiresMetadataParse: true,  // Need to read file to get cwd for grouping
  },

  sessionParsing: {
    format: 'jsonl',
    paths: {
      sessionId: 'session_id',  // First line type=session_meta
      cwd: 'cwd',               // From session_meta
      model: 'model_provider',
      timestamp: 'timestamp',
      version: 'cli_version',
    },
    messageMatching: {
      userRole: { field: 'type', value: ['user_turn', 'response_item'] },
      assistantRole: { field: 'type', value: 'agent_message' },
      contentPath: 'text',
    },
  },

  spawning: {
    // CRITICAL: Codex does NOT support interactive JSON streaming
    supportsInteractiveStreaming: false,
    streamCommand: {
      subcommand: 'exec',
      args: ['--json'],
    },
    resumeCommand: {
      style: 'subcommand',
      subcommand: 'resume',
      latestFlag: '--last',
    },
    cwdFlag: '--cd',
    modelFlag: '--model',
    autoApproveFlag: '--yolo',  // Alias for --dangerously-bypass-approvals-and-sandbox
  },

  eventParsing: {
    eventTypeField: 'type',
    compoundEventSeparator: '.',
    eventMap: {
      'thread.started': 'session.start',
      'turn.completed': 'token.usage',
      'turn.failed': 'error',
      'item.completed': 'message.assistant',  // Check item.type for specifics
    },
    paths: {
      content: 'item.text',
      toolName: 'item.command',
      toolCallId: 'item.id',
      toolOutput: 'item.aggregated_output',
      tokenInput: 'usage.input_tokens',
      tokenOutput: 'usage.output_tokens',
      tokenCached: 'usage.cached_input_tokens',
    },
  },
};
```

### Gemini CLI Configuration

```typescript
const GEMINI_CONFIG: CodingCliProviderConfig = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  icon: 'google',
  color: '#4285F4',  // Google blue

  // VERIFIED: No GEMINI_HOME env var exists
  homeEnvVar: null,
  defaultHome: '~/.gemini',
  commandEnvVar: 'GEMINI_CMD',
  defaultCommand: 'gemini',

  sessionDiscovery: {
    pattern: 'tmp/*/chats/session-*.json',
    sessionIdExtractor: 'filename',
    sessionIdRegex: 'session-(.+)\\.json$',
    groupBy: 'project-directory',
    projectPathSource: 'directory-structure',  // project_hash in path
  },

  sessionParsing: {
    // VERIFIED: Still using JSON format (Issue #15292 not merged)
    format: 'json',
    paths: {
      sessionId: null,  // From filename
      cwd: null,        // From project hash directory (need reverse lookup)
      model: null,      // In settings, not session file
      timestamp: null,  // File mtime
    },
    messageMatching: {
      userRole: { field: 'role', value: 'user' },
      assistantRole: { field: 'role', value: 'model' },
      contentPath: 'parts[0].text',
    },
  },

  spawning: {
    supportsInteractiveStreaming: true,
    streamCommand: {
      args: ['--output-format', 'stream-json'],
    },
    resumeCommand: {
      style: 'flag',
      flag: '--resume',
      latestFlag: '--resume latest',
    },
    cwdFlag: null,
    modelFlag: '--model',
    autoApproveFlag: '--yolo',  // VERIFIED: Real flag
  },

  eventParsing: {
    eventTypeField: 'type',
    eventMap: {
      'init': 'session.start',
      'message': 'message.assistant',  // Check role field
      'tool_use': 'tool.call',
      'tool_result': 'tool.result',
      'result': 'session.end',
    },
    paths: {
      content: 'content',
      toolName: 'tool_name',
      toolCallId: 'tool_id',
      toolOutput: 'output',
    },
  },
};
```

### OpenCode Configuration

```typescript
const OPENCODE_CONFIG: CodingCliProviderConfig = {
  id: 'opencode',
  displayName: 'OpenCode',
  icon: 'opencode',
  color: '#6366F1',  // Indigo

  // VERIFIED: Uses XDG spec, no OPENCODE_HOME
  homeEnvVar: null,  // Uses XDG_DATA_HOME/opencode
  defaultHome: '~/.local/share/opencode',
  commandEnvVar: 'OPENCODE_CMD',
  defaultCommand: 'opencode',

  sessionDiscovery: {
    // VERIFIED: Correct path structure
    pattern: 'storage/session/*/*.json',
    sessionIdExtractor: 'filename',
    sessionIdRegex: '([^/]+)\\.json$',
    groupBy: 'project-directory',
    projectPathSource: 'session-metadata',
    requiresMultiFileReconstruction: true,  // Special handling needed
  },

  sessionParsing: {
    // VERIFIED: Multi-file structure
    format: 'multi-file',
    messagePattern: 'storage/message/{sessionId}/*.json',
    partPattern: 'storage/part/{messageId}/*.json',
    paths: {
      sessionId: 'id',
      cwd: 'directory',
      model: null,  // In message parts
      timestamp: 'time.created',
      title: 'title',
    },
    messageMatching: {
      userRole: { field: 'role', value: 'user' },
      assistantRole: { field: 'role', value: 'assistant' },
      contentPath: 'parts',  // Need to reconstruct from part files
    },
  },

  spawning: {
    supportsInteractiveStreaming: true,  // Via SSE server
    streamCommand: {
      subcommand: 'run',
      args: ['--format', 'json'],
    },
    resumeCommand: {
      style: 'flag',
      flag: '--session',
      latestFlag: '--continue',
    },
    cwdFlag: null,
    modelFlag: '--model',
    // VERIFIED: No --yolo flag, uses config
    autoApproveFlag: null,
    autoApproveConfig: {
      configKey: 'permission',
      configValue: 'allow',
    },
  },

  eventParsing: {
    eventTypeField: 'type',
    eventMap: {
      'session.created': 'session.start',
      'session.status.done': 'session.end',
      'message.updated': 'message.assistant',
    },
    paths: {
      content: 'content',
    },
  },
};
```

### Kimi CLI Configuration

```typescript
const KIMI_CONFIG: CodingCliProviderConfig = {
  id: 'kimi',
  displayName: 'Kimi CLI',
  icon: 'moonshot',
  color: '#FF6B6B',  // Red

  // VERIFIED: No KIMI_HOME env var
  homeEnvVar: null,
  defaultHome: '~/.kimi',
  commandEnvVar: 'KIMI_CMD',
  defaultCommand: 'kimi',

  sessionDiscovery: {
    // VERIFIED: sessions/{workdir_md5}/{session_uuid}/
    pattern: 'sessions/*/*/',  // Directory-based
    sessionIdExtractor: 'directory-name',
    sessionIdRegex: 'sessions/[^/]+/([^/]+)/$',
    groupBy: 'project-directory',
    projectPathSource: 'session-metadata',
  },

  sessionParsing: {
    format: 'jsonl',  // Checkpoint-based
    paths: {
      sessionId: null,  // From directory name
      cwd: null,        // From workdir_md5 parent (need reverse lookup)
      model: 'model',
      timestamp: 'timestamp',
    },
    messageMatching: {
      userRole: { field: 'role', value: 'user' },
      assistantRole: { field: 'role', value: 'assistant' },
      contentPath: 'content',
    },
  },

  spawning: {
    supportsInteractiveStreaming: true,
    streamCommand: {
      args: ['--output-format', 'stream-json'],
    },
    resumeCommand: {
      style: 'flag',
      flag: '--session',
      latestFlag: '--continue',
    },
    cwdFlag: null,  // Uses current directory
    modelFlag: '--model',
    autoApproveFlag: '--yolo',  // VERIFIED: Real flag
  },

  eventParsing: {
    eventTypeField: 'type',
    eventMap: {
      'TurnBegin': 'session.start',
      'ContentPart': 'message.delta',
      'ToolCall': 'tool.call',
      'ToolResult': 'tool.result',
    },
    paths: {
      content: 'content',
      toolName: 'name',
      toolCallId: 'call_id',
    },
  },
};
```

---

## Part 5: Special Provider Handling

Some providers cannot be fully handled by data-driven config alone.

### OpenCode Multi-File Session Reconstruction

```typescript
// server/coding-cli/providers/opencode.ts

interface OpenCodeSessionInfo {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
}

interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  model?: { providerID: string; modelID: string };
}

interface OpenCodePart {
  id: string;
  type: 'text' | 'reasoning' | 'tool_state_completed' | 'file' | 'patch' | /* ... */;
  content?: string;
  // ... other fields based on type
}

/**
 * Reconstructs a full OpenCode session from its multi-file storage.
 *
 * Files:
 *   storage/session/{projectID}/{sessionID}.json - Session metadata
 *   storage/message/{sessionID}/*.json - Message metadata (one per message)
 *   storage/part/{messageID}/*.json - Message parts (text, tools, etc.)
 */
async function reconstructOpenCodeSession(
  baseDir: string,
  sessionId: string,
): Promise<{ session: OpenCodeSessionInfo; messages: Array<{ info: OpenCodeMessageInfo; parts: OpenCodePart[] }> }> {
  // 1. Find and read session file
  const sessionFiles = await glob(`${baseDir}/storage/session/*/${sessionId}.json`);
  if (sessionFiles.length === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const session: OpenCodeSessionInfo = JSON.parse(await readFile(sessionFiles[0], 'utf-8'));

  // 2. List all message files for this session
  const messageFiles = await glob(`${baseDir}/storage/message/${sessionId}/*.json`);

  // 3. For each message, load info and parts
  const messages: Array<{ info: OpenCodeMessageInfo; parts: OpenCodePart[] }> = [];

  for (const messageFile of messageFiles) {
    const messageInfo: OpenCodeMessageInfo = JSON.parse(await readFile(messageFile, 'utf-8'));

    // Load all parts for this message
    const partFiles = await glob(`${baseDir}/storage/part/${messageInfo.id}/*.json`);
    const parts: OpenCodePart[] = [];

    for (const partFile of partFiles) {
      const part: OpenCodePart = JSON.parse(await readFile(partFile, 'utf-8'));
      parts.push(part);
    }

    // Sort parts by ID (they have monotonic IDs)
    parts.sort((a, b) => a.id.localeCompare(b.id));

    messages.push({ info: messageInfo, parts });
  }

  // Sort messages by ID
  messages.sort((a, b) => a.info.id.localeCompare(b.info.id));

  return { session, messages };
}
```

### Gemini Project Hash Reverse Lookup

```typescript
// server/coding-cli/providers/gemini.ts

/**
 * Gemini stores sessions under tmp/{project_hash}/, but we need
 * the actual project path for UI display.
 *
 * Options:
 * 1. Hash all known project paths and match (slow for many projects)
 * 2. Store a mapping file in ~/.freshell/ (persistence overhead)
 * 3. Parse Gemini's own mapping (if it exists)
 *
 * For now, we'll show the hash as fallback and improve later.
 */
function geminiProjectHashToPath(hash: string): string | null {
  // TODO: Implement project hash reverse lookup
  // For now, return null and display hash in UI
  return null;
}
```

### Codex Session Grouping by Project

```typescript
// server/coding-cli/providers/codex.ts

/**
 * Codex stores sessions by date (YYYY/MM/DD/), but we want to
 * group by project in the UI.
 *
 * Strategy:
 * 1. Scan all session files
 * 2. Parse first line to get session_meta with cwd
 * 3. Group by cwd
 * 4. Cache the cwd→sessions mapping
 */
interface CodexSessionCache {
  sessions: Map<string, { filePath: string; cwd: string; sessionId: string; timestamp: number }>;
  lastScanned: number;
}

async function buildCodexSessionCache(codexHome: string): Promise<CodexSessionCache> {
  const pattern = `${codexHome}/sessions/*/*/*/*/rollout-*.jsonl`;
  const files = await glob(pattern);

  const sessions = new Map();

  for (const filePath of files) {
    try {
      // Read only first line for metadata
      const firstLine = await readFirstLine(filePath);
      const meta = JSON.parse(firstLine);

      if (meta.type === 'session_meta') {
        const match = filePath.match(/rollout-[\dT-]+-([a-f0-9-]+)\.jsonl$/);
        if (match) {
          sessions.set(match[1], {
            filePath,
            cwd: meta.cwd,
            sessionId: meta.session_id || match[1],
            timestamp: new Date(meta.timestamp).getTime(),
          });
        }
      }
    } catch (e) {
      // Skip malformed files
    }
  }

  return { sessions, lastScanned: Date.now() };
}
```

---

## Part 6: Architecture Design

### Directory Structure

```
server/
├── coding-cli/
│   ├── index.ts                    # Re-exports
│   ├── types.ts                    # Normalized types, composite keys
│   ├── config.ts                   # Provider configurations
│   ├── path-resolver.ts            # JSON path resolution utility
│   ├── registry.ts                 # Provider registry
│   │
│   ├── session-indexer.ts          # Multi-provider session indexer
│   ├── session-parser.ts           # JSONL/JSON parsing utilities
│   ├── event-normalizer.ts         # Normalize provider events
│   │
│   ├── live-session-manager.ts     # Live session lifecycle
│   ├── stream-parser.ts            # Parse streaming output
│   │
│   ├── coordination.ts             # Live ↔ Indexed session coordination
│   │
│   └── providers/                  # Provider-specific handlers
│       ├── opencode.ts             # Multi-file reconstruction
│       ├── codex.ts                # Date→Project grouping
│       ├── gemini.ts               # Hash→Path lookup
│       └── kimi.ts                 # Workdir hash handling
│
src/
├── lib/
│   └── coding-cli-types.ts         # Client-side normalized types
│
├── store/
│   ├── codingSessionsSlice.ts      # Renamed from claudeSlice
│   └── types.ts                    # Updated with provider field
│
├── components/
│   ├── SessionView.tsx             # Generalized session viewer
│   ├── HistoryView.tsx             # Multi-provider history
│   └── session/
│       ├── MessageBubble.tsx
│       ├── ToolCallBlock.tsx
│       └── ProviderBadge.tsx       # Show provider icon/color
```

### WebSocket Protocol Extensions

```typescript
// ============================================================
// WEBSOCKET MESSAGE SCHEMAS
// ============================================================

// Terminal creation now includes optional provider
const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string(),
  mode: z.enum(['shell', 'coding-cli']).default('shell'),
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']).optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),  // Provider's session ID
  model: z.string().optional(),
  autoApprove: z.boolean().optional(),
});

// Terminal created response
const TerminalCreatedSchema = z.object({
  type: z.literal('terminal.created'),
  requestId: z.string(),
  terminalId: z.string(),
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']).optional(),
});

// Session update broadcast (replaces sessions.updated)
const SessionsUpdatedSchema = z.object({
  type: z.literal('sessions.updated'),
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']).optional(),  // If specific provider
  sessions: z.array(z.object({
    id: z.string(),
    provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']),
    projectPath: z.string(),
    title: z.string().optional(),
    updatedAt: z.number(),
  })),
});

// Live session event broadcast
const LiveSessionEventSchema = z.object({
  type: z.literal('liveSession.event'),
  terminalId: z.string(),
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']),
  sessionId: z.string().optional(),  // Once known
  event: NormalizedEventSchema,
});

// Request session history
const SessionsFetchSchema = z.object({
  type: z.literal('sessions.fetch'),
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']).optional(),
  projectPath: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
```

### REST API Extensions

```typescript
// GET /api/sessions
// Query params: ?provider=claude&project=/path/to/project&limit=50&offset=0

interface SessionsResponse {
  sessions: Array<{
    id: string;
    provider: CodingCliProvider;
    projectPath: string;
    title?: string;
    summary?: string;
    messageCount: number;
    createdAt: number;
    updatedAt: number;
  }>;
  total: number;
}

// GET /api/sessions/:provider/:sessionId
interface SessionDetailResponse {
  session: {
    id: string;
    provider: CodingCliProvider;
    projectPath: string;
    cwd: string;
    model?: string;
    title?: string;
    createdAt: number;
    updatedAt: number;
  };
  events: NormalizedEvent[];
}

// GET /api/providers
interface ProvidersResponse {
  providers: Array<{
    id: CodingCliProvider;
    displayName: string;
    installed: boolean;
    enabled: boolean;
    version?: string;
  }>;
}
```

---

## Part 7: Session Coordination (Live ↔ Indexed)

This section addresses the critical gap of coordinating live sessions with the indexer.

### Problem Statement

When a live session is running:
1. `LiveSessionManager` owns the running process
2. The CLI is writing to its session file
3. `MultiProviderSessionIndexer` may detect the file change
4. UI could show duplicates (live view + history entry)

### Solution: Coordination Registry

```typescript
// server/coding-cli/coordination.ts

interface ActiveSession {
  terminalId: string;
  provider: CodingCliProvider;
  providerSessionId?: string;  // Once CLI reports it
  filePath?: string;           // Once we can determine it
  startedAt: number;
  status: 'starting' | 'running' | 'completed' | 'error';
}

class SessionCoordinator extends EventEmitter {
  private activeSessions: Map<string, ActiveSession> = new Map();  // terminalId → session
  private fileToTerminal: Map<string, string> = new Map();         // filePath → terminalId

  constructor(
    private indexer: MultiProviderSessionIndexer,
    private liveManager: LiveSessionManager,
  ) {
    // When live session starts, register it
    liveManager.on('started', ({ terminalId, provider }) => {
      this.activeSessions.set(terminalId, {
        terminalId,
        provider,
        startedAt: Date.now(),
        status: 'starting',
      });
    });

    // When live session reports its session ID
    liveManager.on('sessionId', ({ terminalId, sessionId, filePath }) => {
      const session = this.activeSessions.get(terminalId);
      if (session) {
        session.providerSessionId = sessionId;
        session.filePath = filePath;
        session.status = 'running';

        if (filePath) {
          this.fileToTerminal.set(filePath, terminalId);
        }
      }
    });

    // When live session ends
    liveManager.on('exit', ({ terminalId }) => {
      const session = this.activeSessions.get(terminalId);
      if (session) {
        session.status = 'completed';

        // Keep in registry briefly to allow indexer to catch up
        setTimeout(() => {
          this.activeSessions.delete(terminalId);
          if (session.filePath) {
            this.fileToTerminal.delete(session.filePath);
          }

          // Emit so UI can refresh history
          this.emit('sessionCompleted', {
            provider: session.provider,
            sessionId: session.providerSessionId,
          });
        }, 2000);  // 2 second grace period
      }
    });
  }

  /**
   * Check if a session file is currently being written by a live session.
   * The indexer calls this to skip files that are "in use".
   */
  isFileActive(filePath: string): boolean {
    return this.fileToTerminal.has(filePath);
  }

  /**
   * Check if a session ID belongs to an active live session.
   * The UI uses this to decide whether to show live view or history.
   */
  isSessionLive(provider: CodingCliProvider, sessionId: string): boolean {
    for (const session of this.activeSessions.values()) {
      if (session.provider === provider && session.providerSessionId === sessionId) {
        return session.status === 'running';
      }
    }
    return false;
  }

  /**
   * Get the terminal ID for a live session, for UI navigation.
   */
  getTerminalForSession(provider: CodingCliProvider, sessionId: string): string | undefined {
    for (const session of this.activeSessions.values()) {
      if (session.provider === provider && session.providerSessionId === sessionId) {
        return session.terminalId;
      }
    }
    return undefined;
  }
}
```

### Indexer Integration

```typescript
// In MultiProviderSessionIndexer.parseSessionFile():

async parseSessionFile(provider: CodingCliProvider, filePath: string): Promise<IndexedSession | null> {
  // Skip files being written by live sessions
  if (this.coordinator.isFileActive(filePath)) {
    return null;
  }

  // Proceed with parsing...
}
```

---

## Part 8: Error Handling Strategies

### File System Errors

```typescript
interface FileSystemErrorHandler {
  onFileNotFound(path: string): void;
  onPermissionDenied(path: string): void;
  onCorruptedFile(path: string, error: Error): void;
  onWatcherLimit(): void;
}

const defaultErrorHandler: FileSystemErrorHandler = {
  onFileNotFound(path) {
    // Silent - file may have been deleted
    logger.debug(`File not found: ${path}`);
  },

  onPermissionDenied(path) {
    // Log and continue
    logger.warn(`Permission denied: ${path}`);
  },

  onCorruptedFile(path, error) {
    // Log and skip this file
    logger.warn(`Corrupted file ${path}: ${error.message}`);
    // Optionally move to quarantine
  },

  onWatcherLimit() {
    // Critical - fall back to polling
    logger.error('File watcher limit reached, falling back to polling');
    this.switchToPollingMode();
  },
};
```

### JSONL Parsing Errors

```typescript
/**
 * Parse JSONL file with resilience to:
 * - Corrupted lines (skip and continue)
 * - Incomplete trailing lines (buffer and retry)
 * - Empty files (return empty array)
 */
async function parseJsonlFile(
  filePath: string,
  options: { maxLines?: number; onError?: (line: number, error: Error) => void } = {},
): Promise<unknown[]> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const results: unknown[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;  // Skip empty lines

    try {
      results.push(JSON.parse(line));

      if (options.maxLines && results.length >= options.maxLines) {
        break;
      }
    } catch (e) {
      // For the last line, it might be incomplete (write in progress)
      if (i === lines.length - 1) {
        // Incomplete trailing line - ignore
        break;
      }

      // For middle lines, log and skip
      options.onError?.(i + 1, e as Error);
    }
  }

  return results;
}
```

### Watcher Scaling Strategy

```typescript
interface WatcherConfig {
  maxWatchers: number;          // Per provider
  pollingFallback: boolean;     // Fall back to polling if limit hit
  pollingInterval: number;      // ms
  debounceMs: number;           // Debounce file change events
}

const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  maxWatchers: 100,             // Reasonable limit per provider
  pollingFallback: true,
  pollingInterval: 5000,        // 5 seconds
  debounceMs: 300,
};

class WatcherPool {
  private watchers: Map<string, FSWatcher> = new Map();
  private pollingPaths: Set<string> = new Set();
  private pollingTimer?: NodeJS.Timeout;

  constructor(private config: WatcherConfig) {}

  watch(path: string, callback: (event: string, filename: string) => void): void {
    if (this.watchers.size >= this.config.maxWatchers) {
      if (this.config.pollingFallback) {
        this.addToPolling(path);
        return;
      }
      throw new Error('Watcher limit reached');
    }

    try {
      const watcher = chokidar.watch(path, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500 },
      });
      watcher.on('change', (filename) => callback('change', filename));
      watcher.on('add', (filename) => callback('add', filename));
      this.watchers.set(path, watcher);
    } catch (e) {
      if (this.config.pollingFallback) {
        this.addToPolling(path);
      } else {
        throw e;
      }
    }
  }

  private addToPolling(path: string): void {
    this.pollingPaths.add(path);
    this.ensurePollingActive();
  }

  private ensurePollingActive(): void {
    if (this.pollingTimer) return;
    this.pollingTimer = setInterval(() => this.pollPaths(), this.config.pollingInterval);
  }

  private async pollPaths(): Promise<void> {
    // Check mtime of all polling paths and emit changes
  }
}
```

---

## Part 9: Key Classes (Complete)

### ProviderRegistry

```typescript
// server/coding-cli/registry.ts

class ProviderRegistry {
  private providers: Map<CodingCliProvider, CodingCliProviderConfig> = new Map();
  private installCache: Map<CodingCliProvider, { installed: boolean; checkedAt: number }> = new Map();

  constructor() {
    this.register(CLAUDE_CONFIG);
    this.register(CODEX_CONFIG);
    this.register(GEMINI_CONFIG);
    this.register(OPENCODE_CONFIG);
    this.register(KIMI_CONFIG);
  }

  register(config: CodingCliProviderConfig): void {
    if (this.providers.has(config.id)) {
      throw new Error(`Provider already registered: ${config.id}`);
    }
    this.providers.set(config.id, config);
  }

  get(id: CodingCliProvider): CodingCliProviderConfig | undefined {
    return this.providers.get(id);
  }

  getAll(): CodingCliProviderConfig[] {
    return Array.from(this.providers.values());
  }

  async isInstalled(id: CodingCliProvider): Promise<boolean> {
    const cached = this.installCache.get(id);
    if (cached && Date.now() - cached.checkedAt < 60000) {  // 1 minute cache
      return cached.installed;
    }

    const config = this.providers.get(id);
    if (!config) return false;

    const command = this.getCommand(id);
    try {
      await execAsync(`${command} --version`, { timeout: 5000 });
      this.installCache.set(id, { installed: true, checkedAt: Date.now() });
      return true;
    } catch {
      this.installCache.set(id, { installed: false, checkedAt: Date.now() });
      return false;
    }
  }

  getHomeDir(id: CodingCliProvider): string {
    const config = this.providers.get(id);
    if (!config) throw new Error(`Unknown provider: ${id}`);

    if (config.homeEnvVar) {
      const envValue = process.env[config.homeEnvVar];
      if (envValue) return expandPath(envValue);
    }

    return expandPath(config.defaultHome);
  }

  getCommand(id: CodingCliProvider): string {
    const config = this.providers.get(id);
    if (!config) throw new Error(`Unknown provider: ${id}`);

    const envValue = process.env[config.commandEnvVar];
    return envValue || config.defaultCommand;
  }
}

export const providerRegistry = new ProviderRegistry();
```

### MultiProviderSessionIndexer

```typescript
// server/coding-cli/session-indexer.ts

interface IndexedSession {
  id: string;                     // Composite key: provider:sessionId
  provider: CodingCliProvider;
  sessionId: string;              // Provider's session ID
  projectPath: string;
  cwd: string;
  title?: string;
  summary?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  filePath: string;
}

interface ProjectGroup {
  projectPath: string;
  sessions: IndexedSession[];      // Sorted by updatedAt desc
}

class MultiProviderSessionIndexer extends EventEmitter {
  private watcherPool: WatcherPool;
  private sessions: Map<SessionCompositeKey, IndexedSession> = new Map();
  private coordinator?: SessionCoordinator;

  constructor(
    private registry: ProviderRegistry,
    private errorHandler: FileSystemErrorHandler = defaultErrorHandler,
  ) {
    super();
    this.watcherPool = new WatcherPool(DEFAULT_WATCHER_CONFIG);
  }

  setCoordinator(coordinator: SessionCoordinator): void {
    this.coordinator = coordinator;
  }

  async start(): Promise<void> {
    const providers = this.registry.getAll();

    for (const config of providers) {
      if (!(await this.registry.isInstalled(config.id))) {
        continue;
      }

      await this.setupProviderWatcher(config);
    }
  }

  stop(): void {
    this.watcherPool.stopAll();
  }

  async refresh(provider?: CodingCliProvider): Promise<void> {
    const configs = provider
      ? [this.registry.get(provider)].filter(Boolean)
      : this.registry.getAll();

    for (const config of configs) {
      await this.scanProvider(config!);
    }

    this.emit('update', this.getSessions());
  }

  getSessions(): IndexedSession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSessionsByProvider(provider: CodingCliProvider): IndexedSession[] {
    return this.getSessions().filter(s => s.provider === provider);
  }

  getProjectGroups(): Map<string, ProjectGroup> {
    const groups = new Map<string, ProjectGroup>();

    for (const session of this.sessions.values()) {
      const existing = groups.get(session.projectPath);
      if (existing) {
        existing.sessions.push(session);
      } else {
        groups.set(session.projectPath, {
          projectPath: session.projectPath,
          sessions: [session],
        });
      }
    }

    // Sort sessions within each group
    for (const group of groups.values()) {
      group.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    return groups;
  }

  private async setupProviderWatcher(config: CodingCliProviderConfig): Promise<void> {
    const homeDir = this.registry.getHomeDir(config.id);
    const pattern = `${homeDir}/${config.sessionDiscovery.pattern}`;

    this.watcherPool.watch(pattern, (event, filename) => {
      this.handleFileChange(config, filename);
    });

    await this.scanProvider(config);
  }

  private async scanProvider(config: CodingCliProviderConfig): Promise<void> {
    const homeDir = this.registry.getHomeDir(config.id);
    const pattern = `${homeDir}/${config.sessionDiscovery.pattern}`;
    const files = await glob(pattern);

    for (const filePath of files) {
      await this.parseAndIndex(config, filePath);
    }
  }

  private async handleFileChange(config: CodingCliProviderConfig, filePath: string): Promise<void> {
    await this.parseAndIndex(config, filePath);
    this.emit('update', this.getSessions());
  }

  private async parseAndIndex(config: CodingCliProviderConfig, filePath: string): Promise<void> {
    // Skip if being written by live session
    if (this.coordinator?.isFileActive(filePath)) {
      return;
    }

    try {
      const session = await this.parseSessionFile(config, filePath);
      if (session) {
        this.sessions.set(makeSessionKey(session.provider, session.sessionId), session);
      }
    } catch (e) {
      this.errorHandler.onCorruptedFile(filePath, e as Error);
    }
  }

  private async parseSessionFile(
    config: CodingCliProviderConfig,
    filePath: string,
  ): Promise<IndexedSession | null> {
    // Handle special provider logic
    if (config.sessionDiscovery.requiresMultiFileReconstruction) {
      return this.parseOpenCodeSession(filePath);
    }

    // Standard JSONL/JSON parsing
    const stat = await fs.stat(filePath);
    const sessionId = this.extractSessionId(config, filePath);

    if (!sessionId) return null;

    if (config.sessionParsing.format === 'jsonl') {
      return this.parseJsonlSession(config, filePath, sessionId, stat);
    } else {
      return this.parseJsonSession(config, filePath, sessionId, stat);
    }
  }

  private extractSessionId(config: CodingCliProviderConfig, filePath: string): string | null {
    if (!config.sessionDiscovery.sessionIdRegex) {
      return path.basename(filePath, path.extname(filePath));
    }

    const match = filePath.match(new RegExp(config.sessionDiscovery.sessionIdRegex));
    return match?.[1] || null;
  }

  // ... additional parsing methods
}
```

### LiveSessionManager

```typescript
// server/coding-cli/live-session-manager.ts

interface LiveSessionCreateOptions {
  provider: CodingCliProvider;
  prompt?: string;
  cwd: string;
  resumeSessionId?: string;
  model?: string;
  autoApprove?: boolean;
}

interface LiveSession {
  terminalId: string;
  provider: CodingCliProvider;
  providerSessionId?: string;
  process: ChildProcess | null;  // null for PTY mode
  pty?: IPty;                    // For non-streaming providers
  cwd: string;
  model?: string;
  status: 'starting' | 'running' | 'completed' | 'error';
  events: NormalizedEvent[];
  error?: string;
}

class LiveSessionManager extends EventEmitter {
  private sessions: Map<string, LiveSession> = new Map();

  constructor(private registry: ProviderRegistry) {
    super();
  }

  async create(terminalId: string, options: LiveSessionCreateOptions): Promise<LiveSession> {
    const config = this.registry.get(options.provider);
    if (!config) {
      throw new Error(`Unknown provider: ${options.provider}`);
    }

    const session: LiveSession = {
      terminalId,
      provider: options.provider,
      cwd: options.cwd,
      model: options.model,
      status: 'starting',
      events: [],
      process: null,
    };

    this.sessions.set(terminalId, session);
    this.emit('started', { terminalId, provider: options.provider });

    if (config.spawning.supportsInteractiveStreaming) {
      await this.spawnWithJsonStreaming(session, config, options);
    } else {
      await this.spawnAsPty(session, config, options);
    }

    return session;
  }

  private async spawnWithJsonStreaming(
    session: LiveSession,
    config: CodingCliProviderConfig,
    options: LiveSessionCreateOptions,
  ): Promise<void> {
    const args = this.buildArgs(config, options);
    const command = this.registry.getCommand(config.id);

    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    session.process = proc;
    session.status = 'running';

    // Parse JSON stream from stdout
    const rl = readline.createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        const normalized = this.normalizeEvent(config, event, session);

        if (normalized) {
          session.events.push(normalized);

          // Detect session ID from init event
          if (normalized.type === 'session.start' && normalized.session) {
            session.providerSessionId = normalized.sessionId;
            this.emit('sessionId', {
              terminalId: session.terminalId,
              sessionId: normalized.sessionId,
              filePath: this.guessFilePath(config, normalized.sessionId),
            });
          }

          this.emit('event', { terminalId: session.terminalId, event: normalized });
        }
      } catch (e) {
        // Non-JSON line, might be stderr or status
      }
    });

    proc.on('exit', (code) => {
      session.status = code === 0 ? 'completed' : 'error';
      this.emit('exit', { terminalId: session.terminalId, code });
    });

    proc.on('error', (error) => {
      session.status = 'error';
      session.error = error.message;
      this.emit('error', { terminalId: session.terminalId, error });
    });
  }

  private async spawnAsPty(
    session: LiveSession,
    config: CodingCliProviderConfig,
    options: LiveSessionCreateOptions,
  ): Promise<void> {
    // For providers without interactive streaming (Codex),
    // spawn as PTY and don't parse output
    const args = this.buildPtyArgs(config, options);
    const command = this.registry.getCommand(config.id);

    const pty = spawn(command, args, {
      name: 'xterm-256color',
      cwd: options.cwd,
      env: { ...process.env },
    });

    session.pty = pty;
    session.status = 'running';

    pty.onExit(({ exitCode }) => {
      session.status = exitCode === 0 ? 'completed' : 'error';
      this.emit('exit', { terminalId: session.terminalId, code: exitCode });
    });
  }

  private buildArgs(config: CodingCliProviderConfig, options: LiveSessionCreateOptions): string[] {
    const args: string[] = [];

    // Streaming command
    if (config.spawning.streamCommand?.subcommand) {
      args.push(config.spawning.streamCommand.subcommand);
    }
    if (config.spawning.streamCommand?.args) {
      args.push(...config.spawning.streamCommand.args);
    }

    // Resume or continue
    if (options.resumeSessionId) {
      if (config.spawning.resumeCommand.style === 'subcommand') {
        args.push(config.spawning.resumeCommand.subcommand!);
      } else {
        args.push(config.spawning.resumeCommand.flag!);
      }
      args.push(options.resumeSessionId);
    }

    // Model
    if (options.model && config.spawning.modelFlag) {
      args.push(config.spawning.modelFlag, options.model);
    }

    // Auto-approve
    if (options.autoApprove && config.spawning.autoApproveFlag) {
      args.push(config.spawning.autoApproveFlag);
    }

    // Prompt (if not resuming)
    if (options.prompt && !options.resumeSessionId) {
      args.push(options.prompt);
    }

    return args;
  }

  sendInput(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    if (session.pty) {
      session.pty.write(data);
    } else if (session.process?.stdin) {
      session.process.stdin.write(data);
    }
  }

  kill(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    if (session.pty) {
      session.pty.kill();
    } else if (session.process) {
      session.process.kill();
    }

    session.status = 'completed';
    this.emit('exit', { terminalId, code: null });
  }

  get(terminalId: string): LiveSession | undefined {
    return this.sessions.get(terminalId);
  }

  list(): LiveSession[] {
    return Array.from(this.sessions.values());
  }

  private normalizeEvent(
    config: CodingCliProviderConfig,
    event: unknown,
    session: LiveSession,
  ): NormalizedEvent | null {
    // Implementation uses config.eventParsing to map events
    // Returns null for events that don't map to a normalized type
  }
}
```

---

## Part 10: Migration Strategy

### Phase 1: Infrastructure (No Behavior Changes)

**Goal:** Create the new module structure without changing existing behavior.

1. Create `server/coding-cli/` directory structure
2. Define all TypeScript types (`types.ts`)
3. Implement `resolvePath` utility (`path-resolver.ts`)
4. Create provider configurations (`config.ts`)
5. Implement `ProviderRegistry`
6. Implement `WatcherPool` with scaling strategy
7. Write comprehensive unit tests

**Files created:**
- `server/coding-cli/types.ts`
- `server/coding-cli/path-resolver.ts`
- `server/coding-cli/config.ts`
- `server/coding-cli/registry.ts`
- `server/coding-cli/watcher-pool.ts`
- `test/unit/server/coding-cli/*.test.ts`

**Verification:** All new tests pass. Existing tests unchanged.

### Phase 2: Session Indexer Migration

**Goal:** Replace Claude-only indexer with multi-provider indexer.

1. Implement `MultiProviderSessionIndexer`
2. Implement provider-specific handlers (OpenCode, Codex, etc.)
3. Implement `SessionCoordinator`
4. Create adapter that wraps new indexer with old interface
5. Replace `claude-indexer.ts` import with adapter
6. Verify all existing tests pass
7. Remove adapter, update all consumers
8. Update REST API to include `provider` field

**Files modified:**
- `server/index.ts` - Use new indexer
- `server/ws-handler.ts` - Update broadcast format

**Files created:**
- `server/coding-cli/session-indexer.ts`
- `server/coding-cli/session-parser.ts`
- `server/coding-cli/coordination.ts`
- `server/coding-cli/providers/opencode.ts`
- `server/coding-cli/providers/codex.ts`
- `server/coding-cli/providers/gemini.ts`
- `server/coding-cli/providers/kimi.ts`

**Breaking Change:** REST API response format changes. Document in changelog.

### Phase 3: Live Session Migration

**Goal:** Replace Claude-only live sessions with multi-provider support.

1. Implement `LiveSessionManager`
2. Implement `EventNormalizer`
3. Update `terminal-registry.ts` to use new manager
4. Update WebSocket handlers for new message types
5. Handle PTY fallback for Codex (no interactive streaming)
6. Wire up `SessionCoordinator`

**Files modified:**
- `server/terminal-registry.ts`
- `server/ws-handler.ts`

**Files created:**
- `server/coding-cli/live-session-manager.ts`
- `server/coding-cli/event-normalizer.ts`
- `server/coding-cli/stream-parser.ts`

### Phase 4: Frontend Updates

**Goal:** Update UI to support multiple providers.

1. Add migration that clears localStorage with clear message:
   ```typescript
   const CURRENT_VERSION = 2;
   const stored = localStorage.getItem('freshell_version');
   if (!stored || parseInt(stored) < CURRENT_VERSION) {
     localStorage.clear();
     localStorage.setItem('freshell_version', String(CURRENT_VERSION));
     console.log('Freshell: Cleared localStorage due to breaking state changes');
   }
   ```
2. Rename `claudeSlice` → `codingSessionsSlice`
3. Update types to include `provider` field
4. Generalize `ClaudeSessionView` → `SessionView`
5. Update `HistoryView` for multi-provider display
6. Add `ProviderBadge` component
7. Update sidebar session list

**Files modified/renamed:**
- `src/store/claudeSlice.ts` → `src/store/codingSessionsSlice.ts`
- `src/store/types.ts`
- `src/components/ClaudeSessionView.tsx` → `src/components/SessionView.tsx`
- `src/components/HistoryView.tsx`
- `src/components/Sidebar.tsx`
- `src/components/TabContent.tsx`

**Files created:**
- `src/components/session/ProviderBadge.tsx`
- `src/lib/coding-cli-types.ts`

**Breaking Change:** localStorage cleared on upgrade. Users lose tab state.

### Phase 5: Configuration & Polish

1. Add provider enable/disable settings to `~/.freshell/config.json`
2. Add settings UI for enabling/disabling providers
3. Add provider-specific icons (SVG)
4. E2E tests with multiple providers
5. Documentation updates

---

## Part 11: Test Strategy

### Unit Tests

| Component | Test Cases |
|-----------|------------|
| `resolvePath` | Dot notation, array indices, missing paths, null handling |
| `ProviderRegistry` | Registration, get, isInstalled, home resolution |
| `WatcherPool` | Watch, limit handling, polling fallback |
| `SessionParser` | JSONL, JSON, malformed files, partial lines |
| `EventNormalizer` | All provider event types, compound events |
| `SessionCoordinator` | Registration, deregistration, race conditions |

### Integration Tests

| Test | Description |
|------|-------------|
| Session indexer file watching | Create/modify/delete files, verify events |
| Live session lifecycle | Start, events, exit, error |
| Coordinator prevents duplicates | Live session + indexer don't double-show |
| Provider detection | Check isInstalled for real CLIs |

### E2E Tests

| Test | Description |
|------|-------------|
| Claude session history | View, open, resume |
| Codex session history | View (PTY mode for live) |
| New session creation | Each provider type |
| Settings UI | Enable/disable providers |

### Test Fixtures

```
test/fixtures/sessions/
├── claude/
│   ├── valid-session.jsonl
│   ├── minimal-session.jsonl
│   └── corrupted-session.jsonl
├── codex/
│   └── rollout-sample.jsonl
├── gemini/
│   └── session-sample.json
├── opencode/
│   ├── session.json
│   ├── messages/
│   └── parts/
└── kimi/
    └── context.jsonl
```

### CI Strategy

```yaml
# Only run CLI integration tests if CLI is installed
- name: Test Claude integration
  if: command -v claude
  run: npm run test:integration:claude

# Always run unit tests (no CLI required)
- name: Unit tests
  run: npm run test:unit
```

---

## Appendix A: Sample Session Files (Verified)

### Claude Code Sample

```jsonl
{"type":"system","subtype":"init","cwd":"/home/user/project","session_id":"abc-123","tools":["Bash","Read","Write"],"model":"claude-sonnet-4-5","claude_code_version":"2.1.23","timestamp":"2026-01-01T00:00:00Z"}
{"type":"user","message":{"role":"user","content":"List files"},"uuid":"msg-1","timestamp":"2026-01-01T00:00:01Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here are the files..."}]},"usage":{"input_tokens":100,"output_tokens":50}}
{"type":"result","subtype":"success","duration_ms":1000,"total_cost_usd":0.01}
```

### Codex CLI Sample (Rollout File)

```jsonl
{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","session_id":"abc-123","cwd":"/home/user","cli_version":"0.92.0","model_provider":"openai"}
{"timestamp":"2026-01-01T00:00:01Z","type":"user_turn","content":[{"type":"input_text","text":"List files"}]}
{"timestamp":"2026-01-01T00:00:02Z","type":"agent_message","text":"Here are the files..."}
{"timestamp":"2026-01-01T00:00:03Z","type":"turn_complete","usage":{"input_tokens":100,"output_tokens":50,"cached_input_tokens":80}}
```

### Codex CLI Streaming Sample (`exec --json`)

```jsonl
{"type":"thread.started","thread_id":"abc-123"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":""}}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Thinking..."}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello!"}}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50,"cached_input_tokens":80}}
```

### Gemini CLI Sample (JSON, Current Format)

```json
[
  {"role":"user","parts":[{"text":"List files"}]},
  {"role":"model","parts":[{"text":"Here are the files..."}]}
]
```

### OpenCode Sample (Multi-File)

**Session file (`storage/session/{projectID}/{sessionID}.json`):**
```json
{
  "id": "ses_abc123",
  "slug": "my-session",
  "projectID": "proj_xyz",
  "directory": "/home/user/project",
  "title": "List files session",
  "time": {"created": 1704067200, "updated": 1704067260}
}
```

**Message file (`storage/message/{sessionID}/{messageID}.json`):**
```json
{
  "id": "msg_001",
  "sessionID": "ses_abc123",
  "role": "user"
}
```

**Part file (`storage/part/{messageID}/{partID}.json`):**
```json
{
  "id": "part_001",
  "type": "text",
  "content": "List files"
}
```

### Kimi CLI Sample

```jsonl
{"role":"user","content":"List files"}
{"role":"assistant","content":"Here are the files...","tool_calls":[]}
{"role":"_usage","token_count":150}
{"role":"_checkpoint","id":"checkpoint_1"}
```

---

## Appendix B: Environment Variables Reference (Verified)

| Provider | Home Dir Env | Command Env | API Key | Notes |
|----------|-------------|-------------|---------|-------|
| Claude | `CLAUDE_CONFIG_DIR` | `CLAUDE_CMD` | `ANTHROPIC_API_KEY` | |
| Codex | `CODEX_HOME` | `CODEX_CMD` | `OPENAI_API_KEY`, `CODEX_API_KEY` (exec) | `CODEX_API_KEY` only works with `exec` |
| OpenCode | **None** (XDG) | `OPENCODE_CMD` | Various per provider | Uses `OPENCODE_CONFIG` for config file |
| Gemini | **None** | `GEMINI_CMD` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | No home override exists |
| Kimi | **None** | `KIMI_CMD` | `KIMI_API_KEY` | No home override exists |

---

## Appendix C: Decision Log

| Decision | Rationale |
|----------|-----------|
| Data-driven config with special handlers | Balance flexibility with complexity; most parsing is generic |
| Composite session keys | Prevents ID collisions across providers |
| WatcherPool with polling fallback | Handles OS limits gracefully |
| SessionCoordinator for live/indexed sync | Prevents duplicate session display |
| PTY fallback for Codex | No interactive JSON streaming available |
| Clear localStorage on upgrade | Simpler than migration for state format changes |
| No GEMINI_HOME/KIMI_HOME | These env vars don't exist; config override not possible |

---

## Appendix D: Future Considerations

1. **OpenCode SSE Integration** - Connect to `opencode serve` for richer events
2. **Gemini JSONL Migration** - When Issue #15292 merges, update parser
3. **Provider Chaining** - Use one CLI to invoke another
4. **MCP Server Mode** - Use `claude mcp serve` for deeper control
5. **Project Hash Reverse Lookup** - Improve Gemini/Kimi project path display
