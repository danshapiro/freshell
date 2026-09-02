/**
 * Shared WebSocket protocol types — single source of truth for both server and client.
 *
 * Client→Server: Zod schemas (server validates) + inferred TypeScript types.
 * Server→Client: TypeScript types only (client trusts server, no runtime validation).
 *
 * Client MUST use `import type` to avoid bundling Zod runtime code.
 */
import { z } from 'zod'
import { WS_PROTOCOL_VERSION } from './ws-version.js'
import type { ClientExtensionEntry } from './extension-types.js'
import type { ServerSettings } from './settings.js'
import { LiveTerminalHandleSchema, SessionRefSchema, type RestoreError } from './session-contract.js'
import { CodexDurabilityRefSchema, type CodexDurabilityRef } from './codex-durability.js'

// ──────────────────────────────────────────────────────────────
// Shared enums and helpers
// ──────────────────────────────────────────────────────────────

export const ErrorCode = z.enum([
  'NOT_AUTHENTICATED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE',
  'INVALID_TERMINAL_ID',
  'SESSION_IDENTITY_MISMATCH',
  'INVALID_SESSION_ID',
  'RESTORE_UNAVAILABLE',
  'INVALID_CREATE_REQUEST',
  'PTY_SPAWN_FAILED',
  'FILE_WATCHER_ERROR',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'PROTOCOL_MISMATCH',
  'SESSION_RESERVED',
  'FRESH_AGENT_LOST_SESSION',
  'FRESH_AGENT_CREATE_FAILED',
  'RECONCILE_NOT_NEGOTIATED',
])

export type ErrorCode = z.infer<typeof ErrorCode>

export { WS_PROTOCOL_VERSION }

export const ShellSchema = z.enum(['system', 'cmd', 'powershell', 'wsl'])

export const CodingCliProviderSchema = z.string().min(1)

export type CodingCliProviderName = z.infer<typeof CodingCliProviderSchema>

export const SessionLocatorSchema = SessionRefSchema.extend({
  provider: CodingCliProviderSchema,
})

export type SessionLocator = z.infer<typeof SessionLocatorSchema>

// ──────────────────────────────────────────────────────────────
// Terminal metadata schemas (used in both directions)
// ──────────────────────────────────────────────────────────────

export const TokenSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
  modelContextWindow: z.number().int().positive().optional(),
  compactThresholdTokens: z.number().int().positive().optional(),
  compactPercent: z.number().int().min(0).max(100).optional(),
})

export type TokenSummary = z.infer<typeof TokenSummarySchema>

export const TerminalMetaRecordSchema = z.object({
  terminalId: z.string().min(1),
  cwd: z.string().optional(),
  checkoutRoot: z.string().optional(),
  repoRoot: z.string().optional(),
  displaySubdir: z.string().optional(),
  branch: z.string().optional(),
  isDirty: z.boolean().optional(),
  provider: CodingCliProviderSchema.optional(),
  sessionId: z.string().optional(),
  tokenUsage: TokenSummarySchema.optional(),
  updatedAt: z.number().int().nonnegative(),
})

export type TerminalMetaRecord = z.infer<typeof TerminalMetaRecordSchema>

export const TerminalMetaUpdatedSchema = z.object({
  type: z.literal('terminal.meta.updated'),
  upsert: z.array(TerminalMetaRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const CodexActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'pending', 'busy', 'unknown']),
  updatedAt: z.number().int().nonnegative(),
})

export type CodexActivityRecord = z.infer<typeof CodexActivityRecordSchema>

export const TerminalTurnCompletionSnapshotSchema = z.object({
  terminalId: z.string().min(1),
  at: z.number().int().nonnegative(),
  completionSeq: z.number().int().positive(),
})

export type TerminalTurnCompletionSnapshot = z.infer<typeof TerminalTurnCompletionSnapshotSchema>

export const CodexActivityListResponseSchema = z.object({
  type: z.literal('codex.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(CodexActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const CodexActivityUpdatedSchema = z.object({
  type: z.literal('codex.activity.updated'),
  upsert: z.array(CodexActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

// ──────────────────────────────────────────────────────────────
// Host Stats (hoststats.* — additive, WS_PROTOCOL_VERSION unchanged)
//
// Degraded-section rule (frozen): a section that times out, throws, or is
// unsupported on the current platform returns its FULL shape with
// available:false and zero/empty/null/[] for every other field — never a
// bare {available:false} (per-section fields stay schema-required).
// ──────────────────────────────────────────────────────────────

const Avail = { available: z.boolean() }

export const HostStatsMachineSchema = z.object({
  cores: z.number().int().positive(),
  memTotalBytes: z.number().nonnegative(),
  platform: z.string(),                          // process.platform value
  wsl: z.boolean(),
  kernel: z.string().nullable(),                 // uname release; null on darwin fallback
  hostname: z.string().nullable(),
  // capability snapshot, computed once at service start (cheap dir listings/probes):
  psi: z.boolean(),                              // /proc/pressure readable
  cgroup: z.enum(['v1', 'v2', 'none']),
  thermalCount: z.number().int().nonnegative(),
  batteryPresent: z.boolean(),
  gpu: z.literal('none'),                        // GPU detection out of scope; chip renders 'n/a' truthfully
})

export type HostStatsMachine = z.infer<typeof HostStatsMachineSchema>

export const HostStatsLiveSchema = z.object({
  machine: HostStatsMachineSchema,
  cpu: z.object({
    ...Avail, usagePct: z.number().min(0).max(100),
    stealPct: z.number().min(0).max(100).nullable(),
    perCorePct: z.array(z.number().min(0).max(100)),
    freqMHz: z.number().nonnegative().nullable(),
  }),
  load: z.object({ ...Avail, load1: z.number(), load5: z.number(), load15: z.number(), cores: z.number().int().positive() }),
  memory: z.object({
    ...Avail, source: z.enum(['host', 'cgroup', 'processes']),
    totalBytes: z.number().nonnegative(), usedBytes: z.number().nonnegative(), availableBytes: z.number().nonnegative(),
    cgroupLimitBytes: z.number().nonnegative().nullable(),
    swapTotalBytes: z.number().nonnegative().nullable(), swapUsedBytes: z.number().nonnegative().nullable(),
  }),
  paging: z.object({
    ...Avail, swapInKbps: z.number().nonnegative(), swapOutKbps: z.number().nonnegative(),
    majFaultsPerSec: z.number().nonnegative(), oomKillsDelta: z.number().int().nonnegative(), oomKillsTotal: z.number().int().nonnegative(),
  }),
  psi: z.object({
    ...Avail,
    cpuSome10: z.number().nullable(), memSome10: z.number().nullable(), memFull10: z.number().nullable(),
    ioSome10: z.number().nullable(), ioFull10: z.number().nullable(),
  }),
  diskIo: z.object({
    ...Avail, readBps: z.number().nonnegative(), writeBps: z.number().nonnegative(),
    utilPct: z.number().min(0).max(100).nullable(), weightedAwaitMs: z.number().nonnegative().nullable(),
  }),
  network: z.object({
    ...Avail, rxBps: z.number().nonnegative(), txBps: z.number().nonnegative(),
    rxErrorsTotal: z.number().int().nonnegative(), txErrorsTotal: z.number().int().nonnegative(),
    rxDroppedTotal: z.number().int().nonnegative(), txDroppedTotal: z.number().int().nonnegative(),
    rxErrorsDelta: z.number().int().nonnegative(), txErrorsDelta: z.number().int().nonnegative(),      // last-tick deltas — server keeps prev tick
    rxDroppedDelta: z.number().int().nonnegative(), txDroppedDelta: z.number().int().nonnegative(),
  }),
  limits: z.object({
    ...Avail, fdsUsed: z.number().int().nonnegative().nullable(), fdsMax: z.number().int().nonnegative().nullable(),
    pidsUsed: z.number().int().nonnegative().nullable(), pidsMax: z.number().int().nonnegative().nullable(),
    timeWait: z.number().int().nonnegative().nullable(), ephemeralPorts: z.number().int().nonnegative().nullable(),
  }),
  freshell: z.object({
    ...Avail, source: z.enum(['node', 'rust']),
    ptysRunning: z.number().int().nonnegative(), ptysMax: z.number().int().nonnegative(),
    wsClients: z.number().int().nonnegative(), wsClientsMax: z.number().int().nonnegative(),
    eventLoopLagP99Ms: z.number().nonnegative().nullable(),   // rust: scheduler drift p99; null when unmeasurable
    rssBytes: z.number().nonnegative().nullable(), uptimeSec: z.number().nonnegative(),
  }),
})

export type HostStatsLive = z.infer<typeof HostStatsLiveSchema>

export const HostStatsManualSchema = z.object({
  topProcesses: z.object({
    ...Avail, dwellMs: z.number().int().nonnegative(),
    list: z.array(z.object({
      pid: z.number().int().positive(), name: z.string(), cpuPct: z.number().min(0), rssBytes: z.number().nonnegative(),
      state: z.string(),                                   // single-char kernel state, or platform word
    })),
  }),
  processHealth: z.object({ ...Avail, zombies: z.number().int().nonnegative(), dState: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  inotify: z.object({
    ...Avail, instances: z.number().int().nonnegative().nullable(), watches: z.number().int().nonnegative().nullable(),
    maxUserWatches: z.number().int().nonnegative().nullable(), maxUserInstances: z.number().int().nonnegative().nullable(),
  }),
  disks: z.object({
    ...Avail, list: z.array(z.object({
      mount: z.string(), totalBytes: z.number().nonnegative(), freeBytes: z.number().nonnegative(), usedPct: z.number().min(0).max(100),
      inodesTotal: z.number().nonnegative().nullable(), inodesFree: z.number().nonnegative().nullable(),
    })),
  }),
  thermals: z.object({
    ...Avail, zones: z.array(z.object({ label: z.string(), celsius: z.number() })),
    battery: z.object({ pct: z.number().min(0).max(100), status: z.string() }).nullable(),
  }),
  sectionErrors: z.record(z.string(), z.string()),        // section key -> short error string when budget/read failed
})

export type HostStatsManual = z.infer<typeof HostStatsManualSchema>

export const HostStatsSnapshotSchema = z.object({
  type: z.literal('hoststats.snapshot'),
  at: z.number().int().nonnegative(),          // server wall clock ms (epoch)
  live: HostStatsLiveSchema,
  manualAt: z.number().int().nonnegative().nullable(),  // last on-request refresh time; null = never
  manual: HostStatsManualSchema.nullable(),             // present when manualAt set
})
export type HostStatsSnapshotMessage = z.infer<typeof HostStatsSnapshotSchema>

export const HostStatsRefreshResponseSchema = z.object({
  type: z.literal('hoststats.refresh.response'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  at: z.number().int().nonnegative().optional(),
  manual: HostStatsManualSchema.optional(),
  error: z.string().optional(),
})
export type HostStatsRefreshResponseMessage = z.infer<typeof HostStatsRefreshResponseSchema>

export const OpencodeActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.literal('busy'),
  updatedAt: z.number().int().nonnegative(),
})

export type OpencodeActivityRecord = z.infer<typeof OpencodeActivityRecordSchema>

export const OpencodeActivityListResponseSchema = z.object({
  type: z.literal('opencode.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(OpencodeActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const OpencodeActivityUpdatedSchema = z.object({
  type: z.literal('opencode.activity.updated'),
  upsert: z.array(OpencodeActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const ClaudeActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'busy']),
  updatedAt: z.number().int().nonnegative(),
})

export type ClaudeActivityRecord = z.infer<typeof ClaudeActivityRecordSchema>

export const ClaudeActivityListResponseSchema = z.object({
  type: z.literal('claude.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(ClaudeActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const ClaudeActivityUpdatedSchema = z.object({
  type: z.literal('claude.activity.updated'),
  upsert: z.array(ClaudeActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const AmplifierActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'busy']),
  updatedAt: z.number().int().nonnegative(),
})

export type AmplifierActivityRecord = z.infer<typeof AmplifierActivityRecordSchema>

export const AmplifierActivityListResponseSchema = z.object({
  type: z.literal('amplifier.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(AmplifierActivityRecordSchema),
  latestTurnCompletions: z.array(TerminalTurnCompletionSnapshotSchema).optional(),
})

export const AmplifierActivityUpdatedSchema = z.object({
  type: z.literal('amplifier.activity.updated'),
  upsert: z.array(AmplifierActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})

export const TerminalTurnCompleteSchema = z.object({
  type: z.literal('terminal.turn.complete'),
  terminalId: z.string().min(1),
  provider: z.enum(['opencode', 'claude', 'codex', 'amplifier']),
  sessionId: z.string().min(1).optional(),
  at: z.number().int().nonnegative(),
  completionSeq: z.number().int().positive(),
})

/**
 * Attention edge for terminal-mode CLI panes (claude/codex/opencode/amplifier):
 * "the agent stopped making progress and you don't already know". Emitted once
 * per attention transition. Rings for: completed turns (after a grace window
 * with no new activity and no detectable queued prompt), FAILED turns,
 * non-human rollout abort reasons (forward-compatible policy — no live codex
 * <= 0.147 emits one), spontaneous process death while ENGAGED (confirmed
 * turn, armed grace window, or pending approval; immediate — no grace), and
 * approval-request pauses (managed codex; opencode permission pauses; unmanaged/PTY-only codex has
 * no approval signal). NEVER emitted after a HUMAN-REQUESTED stop:
 * Esc/interrupt (turn.status 'interrupted', abort reason
 * 'interrupted'/'replaced'), slash-command quits from an idle pane
 * (input-only pending state never counts as death-bell engagement), tab
 * close, terminal.close, or server shutdown (including graceful-shutdown
 * SIGTERMs). Subagent completions inside a running turn never produce it.
 * Queued input suppresses completion bells (work continues) but NOT death
 * bells (a dead process never runs the queue) and NOT approval bells (still
 * blocked on the human). This is the ONLY edge the client rings/shades on
 * for terminal CLI panes ('terminal.turn.complete' stays informational).
 *
 * Pinned wire contract shared with the Rust server port - do not change
 * unilaterally: { terminalId, at (server epoch ms), reason: 'grace' | 'queue-empty' }.
 */
export const TerminalIdleSchema = z.object({
  type: z.literal('terminal.idle'),
  terminalId: z.string().min(1),
  at: z.number().int().nonnegative(),
  reason: z.enum(['grace', 'queue-empty']),
})

// ──────────────────────────────────────────────────────────────
// SDK content block schemas (from Claude Code NDJSON)
// ──────────────────────────────────────────────────────────────

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
})

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
})

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ── Token usage ──

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
}).passthrough()

export type Usage = z.infer<typeof UsageSchema>

// ──────────────────────────────────────────────────────────────
// Client → Server messages (Zod validated)
// ──────────────────────────────────────────────────────────────

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  protocolVersion: z.literal(WS_PROTOCOL_VERSION),
  capabilities: z.object({
    uiScreenshotV1: z.boolean().optional(),
    terminalOutputBatchV1: z.boolean().optional(),
    // REQUIRED here (not just in the sent object): Zod non-strict objects silently
    // STRIP unknown keys, so without this the capability would silently no-op.
    paneReconcileV1: z.literal(true).optional(),
    paneReconcileFreshAgentV1: z.literal(true).optional(),
  }).optional(),
  client: z.object({
    mobile: z.boolean().optional(),
  }).optional(),
  sidebarOpenSessions: z.array(SessionLocatorSchema).optional(),
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
})

export const PingSchema = z.object({
  type: z.literal('ping'),
})

/**
 * The client's includeSubagents listing preference (amplifier watch
 * reduction). Per-connection, pushed mid-session and on (re)connect; old
 * servers answer it with INVALID_MESSAGE without closing (accept-and-strip),
 * so no client-side capability gate is needed.
 */
export const SessionsPrefsSchema = z.object({
  type: z.literal('sessions.prefs'),
  includeSubagents: z.boolean(),
})
export type SessionsPrefs = z.infer<typeof SessionsPrefsSchema>

export const ClientDiagnosticSchema = z.object({
  type: z.literal('client.diagnostic'),
  event: z.literal('restore_unavailable'),
  reason: z.literal('dead_live_handle'),
  terminalId: z.string().min(1),
  tabId: z.string().min(1),
  paneId: z.string().min(1),
  mode: z.string().min(1),
  hasSessionRef: z.literal(false),
})

export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.string().default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
  sessionRef: SessionLocatorSchema.optional(),
  codexDurability: CodexDurabilityRefSchema.optional(),
  liveTerminal: LiveTerminalHandleSchema.optional(),
  restore: z.boolean().optional(),
  recoveryIntent: z.literal('fresh_after_restore_unavailable').optional(),
  tabId: z.string().min(1).optional(),
  paneId: z.string().min(1).optional(),
}).strict()

export const TerminalCodexCandidatePersistedSchema = z.object({
  type: z.literal('terminal.codex.candidate.persisted'),
  terminalId: z.string().min(1),
  candidateThreadId: z.string().min(1),
  rolloutPath: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
}).strict()

export const TerminalAttachIntentSchema = z.enum([
  'viewport_hydrate',
  'keepalive_delta',
  'transport_reconnect',
])

export const TerminalAttachPrioritySchema = z.enum([
  'foreground',
  'background',
])

export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  expectedSessionRef: SessionLocatorSchema.optional(),
  sinceSeq: z.number().int().nonnegative().optional(),
  maxReplayBytes: z.number().int().positive().optional(),
  attachRequestId: z.string().min(1).optional(),
  /** Positive marker: the attaching xterm surface was freshly constructed
   * (page load / renderer recreation / user reset). Servers that know this
   * field answer with one control-plane `terminal.modes.sync` frame; older
   * servers accept-and-strip it (WS_PROTOCOL_VERSION deliberately not
   * bumped — additive optional, all four old/new quadrants valid). */
  surfaceReset: z.boolean().optional(),
  intent: TerminalAttachIntentSchema,
  priority: TerminalAttachPrioritySchema.optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
})

export const TerminalDetachSchema = z.object({
  type: z.literal('terminal.detach'),
  terminalId: z.string().min(1),
})

export const TerminalAutoResumeCancelSchema = z.object({
  type: z.literal('terminal.autoResumeCancel'),
  /** The OLD (crashed) terminal id from the recovering notice frame. */
  terminalId: z.string().min(1),
})
export type TerminalAutoResumeCancelMessage = z.infer<typeof TerminalAutoResumeCancelSchema>

export const TerminalInputSchema = z.object({
  type: z.literal('terminal.input'),
  terminalId: z.string().min(1),
  expectedSessionRef: SessionLocatorSchema.optional(),
  data: z.string(),
})

export const TerminalResizeSchema = z.object({
  type: z.literal('terminal.resize'),
  terminalId: z.string().min(1),
  expectedSessionRef: SessionLocatorSchema.optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
})

export const TerminalKillSchema = z.object({
  type: z.literal('terminal.kill'),
  terminalId: z.string().min(1),
})

export const CodexActivityListSchema = z.object({
  type: z.literal('codex.activity.list'),
  requestId: z.string().min(1),
})

export const OpencodeActivityListSchema = z.object({
  type: z.literal('opencode.activity.list'),
  requestId: z.string().min(1),
})

export const ClaudeActivityListSchema = z.object({
  type: z.literal('claude.activity.list'),
  requestId: z.string().min(1),
})

export const AmplifierActivityListSchema = z.object({
  type: z.literal('amplifier.activity.list'),
  requestId: z.string().min(1),
})

export const HostStatsSubscribeSchema = z.object({
  type: z.literal('hoststats.subscribe'),
}).strict()

export const HostStatsUnsubscribeSchema = z.object({
  type: z.literal('hoststats.unsubscribe'),
}).strict()

export const HostStatsRefreshSchema = z.object({
  type: z.literal('hoststats.refresh'),
  requestId: z.string().min(1),
}).strict()

export const UiLayoutSyncSchema = z.object({
  type: z.literal('ui.layout.sync'),
  tabs: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    fallbackSessionRef: SessionLocatorSchema.optional(),
  })),
  activeTabId: z.string().nullable().optional(),
  layouts: z.record(z.string(), z.unknown()),
  activePane: z.record(z.string(), z.string()),
  paneTitles: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  paneTitleSetByUser: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
  timestamp: z.number(),
})

export const UiScreenshotResultSchema = z.object({
  type: z.literal('ui.screenshot.result'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  mimeType: z.literal('image/png').optional(),
  imageBase64: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  changedFocus: z.boolean().optional(),
  restoredFocus: z.boolean().optional(),
  error: z.string().optional(),
}).strict()

// Coding CLI session schemas
export const CodingCliCreateSchema = z.object({
  type: z.literal('codingcli.create'),
  requestId: z.string().min(1),
  provider: CodingCliProviderSchema,
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
  /** Canonical identity carrier (kata ejh6). */
  sessionRef: SessionLocatorSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
})

export const CodingCliInputSchema = z.object({
  type: z.literal('codingcli.input'),
  sessionId: z.string().min(1),
  data: z.string(),
})

export const CodingCliKillSchema = z.object({
  type: z.literal('codingcli.kill'),
  sessionId: z.string().min(1),
})

export const FreshAgentCreateSchema = z.object({
  type: z.literal('freshAgent.create'),
  requestId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']).optional(),
  cwd: z.string().optional(),
  legacyRestoreContext: z.object({
    title: z.string().min(1).optional(),
    createdAt: z.number().finite().optional(),
    updatedAt: z.number().finite().optional(),
  }).optional(),
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  sessionRef: z.object({ provider: z.string().min(1), sessionId: z.string().min(1) }).optional(),
  modelSelection: z.object({ kind: z.string().min(1), modelId: z.string().min(1) }).optional().or(z.null()),
  effort: z.string().trim().min(1).optional(),
  plugins: z.array(z.string()).optional(),
})

export const FreshAgentAttachSchema = z.object({
  type: z.literal('freshAgent.attach'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
  cwd: z.string().optional(),
  sessionRef: SessionLocatorSchema.optional(),
})

export const FreshAgentSendSchema = z.object({
  type: z.literal('freshAgent.send'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  text: z.string().min(1),
  settings: z.object({
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    effort: z.string().trim().min(1).optional(),
  }).optional(),
  images: z.array(z.object({
    mediaType: z.string(),
    data: z.string(),
  })).optional(),
})

export const FreshAgentInterruptSchema = z.object({
  type: z.literal('freshAgent.interrupt'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
})

export const FreshAgentCompactSchema = z.object({
  type: z.literal('freshAgent.compact'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  instructions: z.string().trim().min(1).optional(),
})

export const FreshAgentApprovalRespondSchema = z.object({
  type: z.literal('freshAgent.approval.respond'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  requestId: z.union([z.string().min(1), z.number().int()]),
  decision: z.record(z.string(), z.unknown()),
})

export const FreshAgentQuestionRespondSchema = z.object({
  type: z.literal('freshAgent.question.respond'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  requestId: z.union([z.string().min(1), z.number().int()]),
  answers: z.record(z.string(), z.string()),
})

export const FreshAgentKillSchema = z.object({
  type: z.literal('freshAgent.kill'),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
})

export const FreshAgentForkSchema = z.object({
  type: z.literal('freshAgent.fork'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
})

export const FreshAgentClientMessageSchema = z.discriminatedUnion('type', [
  FreshAgentCreateSchema,
  FreshAgentAttachSchema,
  FreshAgentSendSchema,
  FreshAgentInterruptSchema,
  FreshAgentCompactSchema,
  FreshAgentApprovalRespondSchema,
  FreshAgentQuestionRespondSchema,
  FreshAgentKillSchema,
  FreshAgentForkSchema,
])

export type FreshAgentClientMessage = z.infer<typeof FreshAgentClientMessageSchema>

// ── pane.reconcile (reconciliation handshake) ──

export const ReconcileSessionRefSchema = SessionLocatorSchema

export const ReconcilePaneSchema = z.object({
  /** Opaque to the server; echoed verbatim on the verdict. */
  paneKey: z.string().min(1),
  /** v1: 'terminal' or 'fresh-agent'. */
  kind: z.enum(['terminal', 'fresh-agent']),
  /** TerminalMode string as persisted ('shell', 'claude', …). */
  mode: z.string().min(1),
  /** The pane's stable creation key — required by contract. */
  createRequestId: z.string().min(1),
  /** Last known live handle. */
  terminalId: z.string().min(1).optional(),
  /** Locality hint, informational only. */
  serverInstanceId: z.string().min(1).optional(),
  /** Optional identity claim. */
  sessionRef: ReconcileSessionRefSchema.optional(),
  /** PERMANENT legacy-compat door: the server promotes this into a sessionRef
   *  forever (kata ejh6 section 2). Do NOT plan a later removal. */
  resumeSessionId: z.string().optional(),
  /** Informational only — never trusted. */
  status: z.string().optional(),
})

export const PaneReconcileRequestSchema = z.object({
  type: z.literal('pane.reconcile.request'),
  /** Client-minted, echoed verbatim; correlation only. */
  reconcileId: z.string().min(1),
  /** Flat list — no tree, no tab structure. Cap: 200 entries. */
  panes: z.array(ReconcilePaneSchema).max(200),
})

export type ReconcilePane = z.infer<typeof ReconcilePaneSchema>
export type PaneReconcileRequest = z.infer<typeof PaneReconcileRequestSchema>

export const PaneVerdictSchema = z.object({
  /** Echoed verbatim, 1:1 with request order. */
  paneKey: z.string().min(1),
  verdict: z.enum(['attach', 'respawn', 'fresh', 'dead_session', 'invalid', 'error']),
  /** attach only: the live terminal to attach to. */
  terminalId: z.string().min(1).optional(),
  /**
   * attach: authoritative identity; respawn: THE identity to resume with;
   * dead_session: the claimed-but-missing identity, for the error UI.
   */
  sessionRef: ReconcileSessionRefSchema.optional(),
  /** Present iff the server overrode a differing client claim. */
  corrected: z.literal(true).optional(),
  /** fresh / dead_session / error / invalid: machine-readable code. */
  reason: z.string().optional(),
  /** A newer duplicate generation exists for the same createRequestId; flags the duplicate terminalId. */
  duplicate: z.string().optional(),
})

export const PaneReconcileResultSchema = z.object({
  type: z.literal('pane.reconcile.result'),
  /** Echoed from the request. */
  reconcileId: z.string().min(1),
  /** This server process's boot. */
  bootId: z.string().min(1),
  serverInstanceId: z.string().min(1),
  /** Cardinality invariant: verdicts.length === panes.length, matched 1:1 by paneKey. */
  verdicts: z.array(PaneVerdictSchema),
})

export type PaneVerdict = z.infer<typeof PaneVerdictSchema>
export type PaneReconcileResultMessage = z.infer<typeof PaneReconcileResultSchema>

/** Server capability advertisement on `ready`: present iff the client's hello opted in via capabilities.paneReconcileV1. */
export const ReadyCapabilitiesSchema = z
  .object({
    paneReconcileV1: z.literal(true).optional(),
    paneReconcileFreshAgentV1: z.literal(true).optional(),
  })
  .optional()

export type ReadyCapabilities = z.infer<typeof ReadyCapabilitiesSchema>

// ── Client message discriminated union ──

export const ClientMessageSchema = z.discriminatedUnion('type', [
  PaneReconcileRequestSchema,
  HelloSchema,
  PingSchema,
  SessionsPrefsSchema,
  ClientDiagnosticSchema,
  TerminalCreateSchema,
  TerminalCodexCandidatePersistedSchema,
  TerminalAttachSchema,
  TerminalAutoResumeCancelSchema,
  TerminalDetachSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  CodexActivityListSchema,
  OpencodeActivityListSchema,
  ClaudeActivityListSchema,
  AmplifierActivityListSchema,
  HostStatsSubscribeSchema,
  HostStatsUnsubscribeSchema,
  HostStatsRefreshSchema,
  UiLayoutSyncSchema,
  UiScreenshotResultSchema,
  CodingCliCreateSchema,
  CodingCliInputSchema,
  CodingCliKillSchema,
  FreshAgentCreateSchema,
  FreshAgentAttachSchema,
  FreshAgentSendSchema,
  FreshAgentInterruptSchema,
  FreshAgentCompactSchema,
  FreshAgentApprovalRespondSchema,
  FreshAgentQuestionRespondSchema,
  FreshAgentKillSchema,
  FreshAgentForkSchema,
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>

// ──────────────────────────────────────────────────────────────
// Server → Client messages (TypeScript types only)
// ──────────────────────────────────────────────────────────────

// -- Core protocol --

export type ReadyMessage = {
  type: 'ready'
  timestamp: string
  serverInstanceId?: string
  bootId?: string
  /** The git commit the server binary was built from ("unknown" fallback).
   *  Additive/optional bootId doctrine: the client bakes its own build id at
   *  Vite build time and reloads once on a mismatch. Omitted from the wire
   *  when the Rust value is None. */
  buildId?: string
  /** Present iff the client's hello opted in via capabilities.paneReconcileV1. */
  capabilities?: ReadyCapabilities
}

export type PongMessage = {
  type: 'pong'
  timestamp: string
}

export type ErrorMessage = {
  type: 'error'
  code: ErrorCode
  message: string
  requestId?: string
  terminalId?: string
  terminalExitCode?: number
  expectedSessionRef?: SessionLocator
  actualSessionRef?: SessionLocator
  /** SESSION_RESERVED only: how long the loser should wait before re-sending its create. Additive; omitted everywhere else. */
  retryAfterMs?: number
  /** RESTORE_UNAVAILABLE only (D7): the live terminal that owns the refused session, so the create-error fold can reattach instead of dead-ending. Additive; omitted everywhere else. */
  liveTerminalId?: string
  timestamp: string
}

// -- Terminal lifecycle --

export type TerminalCreatedMessage = {
  type: 'terminal.created'
  requestId: string
  terminalId: string
  createdAt: number
  cwd?: string
  sessionRef?: SessionLocator
  clearCodexDurability?: boolean
  restoreError?: RestoreError
  /** Resume-validation: operator-visible notice set when the server dropped a stale resume id and spawned fresh. The client writes it into the pane's xterm. Additive; Node never sets it. */
  notice?: string
}

export type TerminalAttachReadyMessage = {
  type: 'terminal.attach.ready'
  terminalId: string
  streamId: string
  geometryEpoch?: number
  geometryAuthority?: TerminalGeometryAuthority
  requestedSinceSeq?: number
  effectiveSinceSeq?: number
  replayResetReason?: 'geometry_authority_unknown'
  headSeq: number
  replayFromSeq: number
  replayToSeq: number
  attachRequestId?: string
  sessionRef?: SessionLocator
}

export type TerminalGeometryAuthority = 'single_client' | 'server_stream' | 'multi_client_unknown'

export type TerminalStreamChangedMessage = {
  type: 'terminal.stream.changed'
  terminalId: string
  streamId: string
  reason: 'new_pty_session' | 'codex_pty_recovery' | 'retention_lost' | 'server_restart_incompatible_retention'
  attachRequestId?: string
}

export type TerminalDetachedMessage = {
  type: 'terminal.detached'
  terminalId: string
}

export type TerminalExitMessage = {
  type: 'terminal.exit'
  terminalId: string
  exitCode: number
}

export type TerminalStatusMessage = {
  type: 'terminal.status'
  terminalId: string
  status: 'running' | 'recovering' | 'exited'
  reason?: string
  attempt?: number
  /** Auto-resume 'recovering' frames only: the bounded retry budget. The
   * client renders attempt/maxAttempts from these FIELDS — `reason` prose is
   * purely presentational and must never be parsed (council 7w4h/xkhx). */
  maxAttempts?: number
  /** Auto-resume 'recovering' frames only: the crashed generation's exit code. */
  exitCode?: number
  /** Flap-circuit-breaker settle frames ('exited') only: successful
   * auto-resumes inside the rolling window — the typed source for the
   * "crashed N times" banner. */
  resumeCycles?: number
}

/** Lane D1: server-initiated crash auto-resume replaced a pane's terminal.
 * The client folds newTerminalId into the pane that owns oldTerminalId. */
export type TerminalReplacedMessage = {
  type: 'terminal.replaced'
  oldTerminalId: string
  newTerminalId: string
  exitCode: number
  attempt: number
  maxAttempts: number
}

export type TerminalOutputMessage = {
  type: 'terminal.output'
  terminalId: string
  streamId: string
  seqStart: number
  seqEnd: number
  data: string
  attachRequestId?: string
  source?: 'live' | 'replay'
}

export type TerminalOutputBatchSegment = {
  seqStart: number
  seqEnd: number
  endOffset: number
  data?: string
  rawFrameCount: number
  barrier?: 'control' | 'startup_probe' | 'osc52' | 'request_mode' | 'turn_complete' | 'gap' | 'geometry'
}

export type TerminalOutputBatchMessage = {
  type: 'terminal.output.batch'
  terminalId: string
  streamId: string
  attachRequestId: string
  source: 'live' | 'replay'
  seqStart: number
  seqEnd: number
  data: string
  serializedBytes: number
  segments: TerminalOutputBatchSegment[]
}

export type TerminalOutputGapMessage = {
  type: 'terminal.output.gap'
  terminalId: string
  streamId: string
  fromSeq: number
  toSeq: number
  reason: 'queue_overflow' | 'replay_window_exceeded' | 'replay_budget_exceeded'
  attachRequestId?: string
}

export type TerminalTitleUpdatedMessage = {
  type: 'terminal.title.updated'
  terminalId: string
  title: string
}

/**
 * Control-plane emulator-mode preamble. Emitted ONLY on attaches marked
 * `surfaceReset: true`, strictly ordered after `terminal.attach.ready` and
 * before any replay/live output on the same socket. Seq-less by design; the
 * client folds it through the same generation gates as replay content and
 * fails closed when `attachRequestId` is absent/foreign. Additive,
 * server→client only, not client-validated (WS_PROTOCOL_VERSION stays).
 */
export type TerminalModesSyncMessage = {
  type: 'terminal.modes.sync'
  terminalId: string
  attachRequestId: string
  streamId: string
  data: string
}

export type TerminalSessionAssociatedMessage = {
  type: 'terminal.session.associated'
  terminalId: string
  sessionRef: SessionLocator
  /**
   * Present ONLY on a server-authoritative mid-session rebind (the CLI under
   * this pane switched/forked to a new session). Names the session id this
   * association supersedes; the client accepts the overwrite only when its
   * current sessionRef.sessionId equals this value. Optional + additive:
   * WS_PROTOCOL_VERSION deliberately NOT bumped (server->client only, not
   * client-validated; old clients ignore it and keep the conflict veto).
   */
  previousSessionId?: string
}

export type TerminalCodexDurabilityUpdatedMessage = {
  type: 'terminal.codex.durability.updated'
  terminalId: string
  durability: CodexDurabilityRef
}

export type TerminalInputBlockedMessage = {
  type: 'terminal.input.blocked'
  terminalId: string
  reason: 'codex_identity_pending' | 'codex_identity_capture_timeout' | 'codex_identity_unavailable' | 'codex_recovery_pending' | 'codex_clean_exit_decision_pending' | 'codex_lifecycle_loss_pending' | 'unknown_terminal'
}

export type TerminalsChangedMessage = {
  type: 'terminals.changed'
  revision: number
  recoverableTerminalIds?: string[]
}

export type TerminalMetaUpdatedMessage = z.infer<typeof TerminalMetaUpdatedSchema>

export type CodexActivityListResponseMessage = z.infer<typeof CodexActivityListResponseSchema>

export type CodexActivityUpdatedMessage = z.infer<typeof CodexActivityUpdatedSchema>

export type OpencodeActivityListResponseMessage = z.infer<typeof OpencodeActivityListResponseSchema>

export type OpencodeActivityUpdatedMessage = z.infer<typeof OpencodeActivityUpdatedSchema>

export type ClaudeActivityListResponseMessage = z.infer<typeof ClaudeActivityListResponseSchema>
export type ClaudeActivityUpdatedMessage = z.infer<typeof ClaudeActivityUpdatedSchema>

export type AmplifierActivityListResponseMessage = z.infer<typeof AmplifierActivityListResponseSchema>
export type AmplifierActivityUpdatedMessage = z.infer<typeof AmplifierActivityUpdatedSchema>

export type TerminalTurnCompleteMessage = z.infer<typeof TerminalTurnCompleteSchema>
export type TerminalIdleMessage = z.infer<typeof TerminalIdleSchema>

// -- Sessions --

export type SessionsChangedMessage = {
  type: 'sessions.changed'
  revision: number
}

// -- Settings --

export type SettingsUpdatedMessage = {
  type: 'settings.updated'
  settings: ServerSettings
}

// -- UI commands --

export type UiCommandMessage = {
  type: 'ui.command'
  command: string
  payload?: unknown
}

// -- Performance logging --

export type PerfLoggingMessage = {
  type: 'perf.logging'
  enabled: boolean
}

export type ConfigFallbackMessage = {
  type: 'config.fallback'
  reason: 'PARSE_ERROR' | 'VERSION_MISMATCH' | 'READ_ERROR' | 'ENOENT'
  backupExists: boolean
}

// -- Tabs sync --

export type TabsSyncAckMessage = {
  type: 'tabs.sync.ack'
  accepted: boolean
  openRecords: number
  closedRecords: number
  /** false when the accepted push was NOT durably persisted (fail-loud honesty). Omitted on success. */
  persisted?: boolean
  /** machine-readable reason accompanying persisted:false (e.g. "oversize") */
  persistReason?: string
}

export type TabsSyncSnapshotOpenRecord = Record<string, unknown> & {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
}

export type TabsSyncSnapshotClosedRecord = Record<string, unknown> & {
  deviceId: string
  deviceLabel: string
}

export type TabsSyncSnapshotMessage = {
  type: 'tabs.sync.snapshot'
  requestId: string
  data: {
    localOpen: TabsSyncSnapshotOpenRecord[]
    sameDeviceOpen: TabsSyncSnapshotOpenRecord[]
    remoteOpen: TabsSyncSnapshotOpenRecord[]
    closed: TabsSyncSnapshotClosedRecord[]
    devices: Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }>
  }
}

// -- Session repair --

export type SessionStatusMessage = {
  type: 'session.status'
  sessionId: string
  status: string
  chainDepth?: number
  orphansFixed?: number
}

export type SessionRepairActivityMessage = {
  type: 'session.repair.activity'
  event: 'scanned' | 'repaired' | 'error'
  sessionId: string
  status?: string
  chainDepth?: number
  orphanCount?: number
  orphansFixed?: number
  message?: string
}

// -- Coding CLI --

export type CodingCliCreatedMessage = {
  type: 'codingcli.created'
  requestId: string
  sessionId: string
  provider: CodingCliProviderName
}

export type CodingCliEventMessage = {
  type: 'codingcli.event'
  sessionId: string
  provider: CodingCliProviderName
  // Provider-specific payload shape. Consumers should narrow/cast based on
  // provider and local event normalization contracts.
  event: unknown
}

export type CodingCliExitMessage = {
  type: 'codingcli.exit'
  sessionId: string
  provider: CodingCliProviderName
  exitCode: number
}

export type CodingCliStderrMessage = {
  type: 'codingcli.stderr'
  sessionId: string
  provider: CodingCliProviderName
  text: string
}

export type CodingCliKilledMessage = {
  type: 'codingcli.killed'
  sessionId: string
  success: boolean
}

export type CodingCliWsMessage =
  | CodingCliEventMessage
  | CodingCliCreatedMessage
  | CodingCliExitMessage
  | CodingCliStderrMessage

// -- Fresh Agent server→client messages --

export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
export type SdkRestoreFailureCode =
  | 'RESTORE_NOT_FOUND'
  | 'RESTORE_UNAVAILABLE'
  | 'RESTORE_INTERNAL'
  | 'RESTORE_DIVERGED'
  | 'RESTORE_STALE_REVISION'

export type FreshAgentServerMessage =
  | { type: 'freshAgent.created'; requestId: string; sessionId: string; sessionType: string; provider: string; runtimeProvider: string; sessionRef?: { provider: string; sessionId: string } }
  | { type: 'freshAgent.create.failed'; requestId: string; code: string; message: string; retryable?: boolean }
  | { type: 'freshAgent.send.accepted'; requestId: string; sessionId: string; sessionType: string; provider: string; submittedTurnId?: string; cwd?: string }
  | { type: 'freshAgent.event'; sessionId: string; sessionType: string; provider: string; event: unknown }
  | { type: 'freshAgent.session.materialized'; previousSessionId: string; sessionId: string; sessionType: string; provider: string; sessionRef?: { provider: string; sessionId: string } }
  | { type: 'freshAgent.forked'; requestId?: string; parentSessionId: string; sessionId: string; sessionType: string; provider: string; runtimeProvider: string; sessionRef?: { provider: string; sessionId: string } }
  | { type: 'freshAgent.killed'; sessionId: string; sessionType: string; provider: string; success: boolean }

// -- Extensions --

export type ExtensionRegistryMessage = {
  type: 'extensions.registry'
  extensions: ClientExtensionEntry[]
}

export type ExtensionServerStartingMessage = {
  type: 'extension.server.starting'
  name: string
}

export type ExtensionServerReadyMessage = {
  type: 'extension.server.ready'
  name: string
  port: number
}

export type ExtensionServerErrorMessage = {
  type: 'extension.server.error'
  name: string
  error: string
}

export type ExtensionServerStoppedMessage = {
  type: 'extension.server.stopped'
  name: string
}

export type TerminalInventoryMessage = {
  type: 'terminal.inventory'
  bootId: string
  terminals: Array<{
    terminalId: string
    title: string
    description?: string
    mode: string
    sessionRef?: SessionLocator
    createdAt: number
    lastActivityAt: number
    status: 'running' | 'exited'
    runtimeStatus?: 'running' | 'recovering'
    cwd?: string
    codexDurability?: CodexDurabilityRef
    /** Server→client only, additive + optional: the terminal's resume target is an opencode subagent (child) session. */
    resumeTargetIsSubagent?: boolean
  }>
  terminalMeta: TerminalMetaRecord[]
}

// ── Server message discriminated union ──

export type ServerMessage =
  | ReadyMessage
  | PongMessage
  | ErrorMessage
  | TerminalCreatedMessage
  | TerminalAttachReadyMessage
  | TerminalModesSyncMessage
  | TerminalStreamChangedMessage
  | TerminalDetachedMessage
  | TerminalExitMessage
  | TerminalStatusMessage
  | TerminalReplacedMessage
  | TerminalOutputMessage
  | TerminalOutputBatchMessage
  | TerminalOutputGapMessage
  | TerminalTitleUpdatedMessage
  | TerminalSessionAssociatedMessage
  | TerminalCodexDurabilityUpdatedMessage
  | TerminalInputBlockedMessage
  | TerminalsChangedMessage
  | TerminalMetaUpdatedMessage
  | TerminalInventoryMessage
  | PaneReconcileResultMessage
  | CodexActivityListResponseMessage
  | CodexActivityUpdatedMessage
  | HostStatsSnapshotMessage
  | HostStatsRefreshResponseMessage
  | OpencodeActivityListResponseMessage
  | OpencodeActivityUpdatedMessage
  | ClaudeActivityListResponseMessage
  | ClaudeActivityUpdatedMessage
  | AmplifierActivityListResponseMessage
  | AmplifierActivityUpdatedMessage
  | TerminalTurnCompleteMessage
  | TerminalIdleMessage
  | SessionsChangedMessage
  | SettingsUpdatedMessage
  | UiCommandMessage
  | PerfLoggingMessage
  | ConfigFallbackMessage
  | TabsSyncAckMessage
  | TabsSyncSnapshotMessage
  | SessionStatusMessage
  | SessionRepairActivityMessage
  | CodingCliCreatedMessage
  | CodingCliEventMessage
  | CodingCliExitMessage
  | CodingCliStderrMessage
  | CodingCliKilledMessage
  | FreshAgentServerMessage
  | ExtensionRegistryMessage
  | ExtensionServerStartingMessage
  | ExtensionServerReadyMessage
  | ExtensionServerErrorMessage
  | ExtensionServerStoppedMessage
