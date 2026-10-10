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
import type { SessionNameRecord, SessionNameRef, SessionNameUpdate } from './session-names.js'
import { TabNameSourceSchema } from './session-names.js'
import type { ManagedRuntimeInventoryChangedMessage, ManagedRuntimeViewChangedMessage } from './managed-runtime.js'

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
  'SESSION_MISSING',
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

/**
 * `terminal.stuck` — the terminal-mode wedged-agent flag, emitted once per
 * stuck/unstuck transition (and to fresh subscribers while flagged).
 * Drives the pane's "Agent appears stuck" card; never a completion edge.
 * Pinned wire contract shared with the Rust server port - do not change
 * unilaterally: { terminalId, at (server epoch ms), stuck }.
 */
export const TerminalStuckSchema = z.object({
  type: z.literal('terminal.stuck'),
  terminalId: z.string().min(1),
  at: z.number().int().nonnegative(),
  stuck: z.boolean(),
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
    terminalInterestV1: z.literal(true).optional(),
    // REQUIRED here (not just in the sent object): Zod non-strict objects silently
    // STRIP unknown keys, so without this the capability would silently no-op.
    paneReconcileV1: z.literal(true).optional(),
    paneReconcileFreshAgentV1: z.literal(true).optional(),
    // Paced terminal restore (responsive-terminal-restore Workstream 1): the
    // client understands bounded, ascending paced replay batches with
    // continuation credit. Additive optional — declared, not just sent (same
    // strip hazard as above); absent for the frozen client shape.
    pacedTerminalReplayV1: z.literal(true).optional(),
    // Hidden-pane lifetime claims (responsive-terminal-restore Workstream 1):
    // the client understands non-hydrating per-connection terminal lifetime
    // claims carried on `terminal.interest.claimedTerminalIds`, sent only
    // after the `ready` echo advertises the capability. Additive optional —
    // declared, not just sent (same strip hazard as above); absent for the
    // frozen client shape.
    terminalLifetimeClaimV1: z.literal(true).optional(),
    managedRuntimeV1: z.literal(true).optional(),
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
  /** D8 (restore-open-sessions-only): additive optional connection provenance — the
   * same values `tabs.sync.push` carries; the Rust server stores them per-connection
   * and stamps connection-scoped ledger rows. Both servers tolerate their absence. */
  deviceId: z.string().optional(),
  clientInstanceId: z.string().optional(),
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
  /** Unified agent names (Task 1): the pane's pre-durable naming handle,
   * minted per logical conversation before provider identity exists.
   * Independent of createRequestId/terminalId/sessionRef; creation retries
   * re-send the same handle. Additive optional — old servers strip it. */
  namingHandle: z.string().min(1).optional(),
  /** kata b8ke delayed-request fence: the (epoch, generation) pair the
   *  client observed when it decided to act. A pair sent together is the
   *  fence (the server stale-rejects pre-restart epochs and superseded
   *  generations); neither-sent is legacy-unfenced. */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
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
  /** Paced terminal restore (responsive-terminal-restore Workstream 1):
    *  the negotiated forward-page limit the client requests — an optional
    *  UPPER BOUND on each paced replay page's serialized bytes, honored
    *  only on pacedTerminalReplayV1 connections and clamped by the server
    *  to its own page-budget cap (min(requested, server cap)). E2R1
    *  finding 2 (the honest bound): pages are bounded by
    *  max(requested, the atomic frame size) — a single frame larger than
    *  the request forms its own ATOMIC single-frame page, bounded by the
    *  server's fragment cap (every frame is pre-fragmented, so one
    *  frame's serialized size never exceeds it). Additive optional;
    *  absent or invalid values keep the server's default. */
  replayPageBytes: z
    .number()
    .int()
    .positive()
    .describe(
      'Optional upper bound on each paced replay page\'s serialized bytes ' +
        '(pacedTerminalReplayV1 connections only), clamped to the server\'s ' +
        'page-budget cap. Pages are bounded by max(requested, the atomic ' +
        'frame size): a single frame larger than the request forms its own ' +
        'atomic page, bounded by the server fragment cap.',
    )
    .optional(),
  attachRequestId: z.string().min(1).optional(),
  /** Positive marker: the attaching xterm surface was freshly constructed
   * (page load / renderer recreation / user reset). Servers that know this
   * field answer with one control-plane `terminal.modes.sync` frame; older
   * servers accept-and-strip it (WS_PROTOCOL_VERSION deliberately not
   * bumped — additive optional, all four old/new quadrants valid). */
  surfaceReset: z.boolean().optional(),
  /** The attaching pane's createRequestId (delta-r7-r2, Finding F3): when an
   * attach carries it, the server re-stamps the terminal's Bound ledger row
   * onto THIS pane's identity (a sidebar reattach becomes the row's new pane
   * key, so a stale pane-close record for the OLD pane's createRequestId can
   * never suppress the genuinely re-opened session). Additive optional. */
  createRequestId: z.string().min(1).optional(),
  /** The attaching pane's tab id (delta-r7-r2, Finding F3): composes the
   * re-stamp's provenance `tabKey` (`deviceId:tabId`), so the row's
   * attribution advances to the attach's true tab and assertion time under
   * the existing full-triple advance rule. Additive optional. */
  tabId: z.string().min(1).optional(),
  /** b8ke ext r8 F2: the attach's observed ownership fence —
   *  terminal.attach participates in the coordinator (a queued
   *  cross-device attach is generation-fenced server-side). Additive
   *  optional. */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
  intent: TerminalAttachIntentSchema,
  priority: TerminalAttachPrioritySchema.optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
})

export const TerminalDetachSchema = z.object({
  type: z.literal('terminal.detach'),
  terminalId: z.string().min(1),
})

/** Delta-r7-r2 (Findings F1+F2) — the dedicated durable pane-close evidence
 * message. EVERY user- or system-initiated action that removes a pane from
 * the layout (pane-X, replace-pane, whole-tab close) sends ONE per removed
 * terminal-pane identity, keyed by the pane's createRequestId (present from
 * creation — never absent) and carrying the pane's terminalId when it
 * exists. The server journals a durable NON-retiring pane-close record (the
 * session survives — nothing is fenced or retired). The detach channel
 * itself stays identity-driven: detach is about the terminal, never the
 * pane.
 *
 * Delta-r7-r3 (focused-episode-7 round 2, Findings F2+F4): the close is
 * ACKNOWLEDGED — the server answers one `pane.closed.result` per message
 * once the journal write resolves, and the client's close gate awaits it
 * (never an unconfirmed drop). Because a pre-result server silently DROPS
 * unknown typed messages at its deserialization boundary, this shape ships
 * WITH the protocol version bump 8 → 9: the strict hello handshake rejects
 * a mixed-version pair with PROTOCOL_MISMATCH, so a client that gates on
 * the answer can only ever connect to a server that speaks it (see
 * `shared/ws-version.ts` for the full mixed-version note). */
export const PaneClosedSchema = z.object({
  type: z.literal('pane.closed'),
  createRequestId: z.string().min(1),
  terminalId: z.string().min(1).optional(),
})

/** Focused-episode-7 round 3 (Finding F1) — the whole-tab BATCH close. The
 * gated `closeTab` sends ONE `panes.closed` carrying the tab's full
 * terminal-pane identity set; the server journals ONE durable NON-retiring
 * envelope record (`pane-detach-batch:<tabId>`) covering the whole set in
 * ONE atomic write, then answers ONE correlated
 * `panes.closed.result{requestId, success}` (handled by the same types as
 * `pane.closed.result`'s floor). A partial per-pane durable outcome is
 * impossible by construction — the finding's mechanism was a pane-A ack +
 * pane-B failure pair leaving pane A durably closed under a still-standing
 * tab. `requestId` is the close op's own correlation key (the batch answers
 * the OP, not a pane — terminal.kill's precedent). Additive with the
 * protocol version bump 9 → 10: the client gates tab removal on the answer,
 * so a server that predates the frame fails the strict hello handshake
 * instead of silently dropping it (see `shared/ws-version.ts`).
 * The single-pane removals (pane-X, replace-pane) keep the degenerate
 * per-pane `pane.closed` envelope above; BOTH route through the same
 * server-side envelope writer. */
export const PanesClosedSchema = z.object({
  type: z.literal('panes.closed'),
  requestId: z.string().min(1),
  tabId: z.string().min(1),
  panes: z.array(z.object({
    createRequestId: z.string().min(1),
    terminalId: z.string().min(1).optional(),
  })).min(1),
})

/** Focused-episode-7 round 3 (Finding F2) — the durable OPEN re-assertion.
 * Sent for a pane the client is STILL DISPLAYING after its close evidence
 * failed to confirm (a server-answered failure, or the ambiguous timeout
 * whose record may have committed durably with the ack lost on the wire).
 * The server consumes the pane's standing `pane-detach[-batch]` close
 * record durably and re-asserts the row's attribution from the connection
 * identity + this tabId, so the recovery judgment re-agrees with the
 * displayed layout (a consumed close reads the pane OPEN again). The
 * client's send path queues it until `ready`, so a socket-down close
 * replays BEFORE this re-assertion on the returned socket — the ordering is
 * the fix, not a race.
 *
 * Focused-episode-7 round 5 (Finding F3): answered by ONE correlated
 * `pane.opened.result{createRequestId, success, error?}` once the consume
 * resolved (a failed consume is marked client-side and retried on the next
 * sweep tick — never server-log-only). The client never GATES on the answer
 * (the per-ready sweep re-asserts every displayed pane regardless), so the
 * frame is additive with NO protocol bump: a predated server degrades to the
 * pre-answer behavior the sweep already heals — see `shared/ws-version.ts`. */
export const PaneOpenedSchema = z.object({
  type: z.literal('pane.opened'),
  createRequestId: z.string().min(1),
  tabId: z.string().min(1),
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
  /**
   * The pane's terminal. Absent for a pane that is still starting (it has
   * no terminal yet): the kill then names the pane by `createRequestId`
   * alone, and the server cancels the start. At least one of the two is
   * present (refined below).
   */
  terminalId: z.string().min(1).optional(),
  /**
   * Close-result correlation (delta-r6-r3 / focused-episode-6 round 2): when
   * present, the server answers the kill with ONE `terminal.killed` frame
   * carrying THIS id, sent only once the pane's agent is confirmed Gone (its
   * processes dead and its conversation released). `success:true` means Gone
   * was confirmed — never merely "not found": an unknown pane is answered
   * success only when nothing holds a conversation for it. `success:false`
   * means the kill was refused or the durable close failed, and the pane was
   * left as it was. When absent, the legacy error-frame answers stand as-is.
   */
  requestId: z.string().min(1).optional(),
  /**
   * The closing pane's createRequestId — the durable close envelope's
   * createRequestId key when the registry probe can no longer answer (the
   * reaper beat the kill, or a post-restart stale pane: the registry row is
   * gone but the stale snapshot must still receive its closed verdict). The
   * registry stamp wins when present (server-side truth); this field only
   * fills the registry-less gap. Additive optional, tolerated by older
   * servers (accept-and-strip inbound).
   */
  createRequestId: z.string().min(1).optional(),
  /**
   * kata b8ke delayed-request fence (Task 4): the (epoch, generation) pair
   * the client observed when it decided to kill — feeds the fenced stop
   * claim (a delayed kill naming superseded ownership is typed-refused
   * instead of killing the wrong runtime). A pair sent together is the
   * fence; neither-sent is legacy-unfenced (the server falls back to the
   * retained stamp). Additive optional; WS_PROTOCOL_VERSION stays put.
   */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
  /**
   * Wedge-backstop Task 2: WHY the client is killing this terminal.
   * `'stuck-recovery'` = the "Agent appears stuck" card's restart action —
   * the server runs the process-only kill and deliberately SKIPS the
   * durable pane-close envelope so the follow-up respawn can resume the
   * session (the card's start-fresh action omits the reason — the abandoned
   * identity must be retired by the full durable close). Absent or any
   * other value keeps today's full pane-close semantics. Additive optional;
   * WS_PROTOCOL_VERSION stays put (older servers accept-and-strip inbound).
   */
  reason: z.string().optional(),
}).refine((m) => m.terminalId !== undefined || m.createRequestId !== undefined, {
  message: 'terminal.kill needs terminalId or createRequestId',
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
    /** Unified agent names (Task 6): the tab's stable naming-source
     * relationship — a mirror of client `Tab.nameSource`. Absent until
     * initial content or migration resolves ownership. Additive optional. */
    nameSource: TabNameSourceSchema.optional(),
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
  /** D8: the creating tab's client-side id; the server composes the ledger row's
   * `tabKey` as `deviceId:tabId`. Non-strict schema — tolerated by older servers. */
  tabId: z.string().min(1).optional(),
  /** Unified agent names (Task 1): the pane's pre-durable naming handle — see
   * `terminal.create.namingHandle`. Additive optional. */
  namingHandle: z.string().min(1).optional(),
  /** kata b8ke delayed-request fence: the (epoch, generation) pair the
   *  client observed when it decided to act. A pair sent together is the
   *  fence; neither-sent is legacy-unfenced. */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
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
  /** kata b8ke delayed-request fence: attach can cold-resume an untracked
   *  session (registering a runtime), so it carries the observed
   *  (epoch, generation) pair. */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
})

export const FreshAgentSendSchema = z.object({
  type: z.literal('freshAgent.send'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  /** b8ke ext r8 F5: the send's delayed-request fence (crashed-session
   *  recovery re-claims carry it, so a stale queued send is typed-refused,
   *  never an unfenced recreation). */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
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

/** `freshAgent.configure` — apply session settings (model / effort /
 * permissionMode / sandbox) to a LIVE session without sending a message, so
 * every device's model surfaces converge immediately. Claude/kilroy apply
 * for real through the sidecar's configure lane (setModel et al.); codex and
 * opencode record the choice as the next turn's per-send settings (their
 * advertised `per-send` scope). Every provider broadcasts
 * `freshAgent.session.metadata` with the new effective settings; a refused
 * or failed configure surfaces as the session-scoped `freshAgent.error`
 * banner (e.g. changing model mid-turn on claude). Additive: an older server
 * ignores the frame (accept-and-strip), degrading to the staged-at-next-send
 * behavior. */
export const FreshAgentConfigureSchema = z.object({
  type: z.literal('freshAgent.configure'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  settings: z.object({
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    effort: z.string().trim().min(1).optional(),
  }),
})

export const FreshAgentCompactSchema = z.object({
  type: z.literal('freshAgent.compact'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  instructions: z.string().trim().min(1).optional(),
  /** b8ke ext r21 F2: the delayed-request fence (additive; the pair rides
   *  the coordinator's generation discipline so a queued compact/undo/redo/
   *  fork landing after a crash + generation advance is typed-refused,
   *  never an unfenced recreation). */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
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
  /** kata b8ke delayed-request fence: kill feeds the fenced stop claim, so
   *  it carries the observed (epoch, generation) pair. */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
})

/** Codex-only process stop used by the stuck card. This extension stays
 * separate from the frozen client-message inventory; an ordinary kill closes
 * the durable session, while recovery preserves it for the next attach. */
export const FreshAgentRecoveryStopSchema = z.object({
  type: z.literal('freshAgent.recovery.stop'),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionType: z.literal('freshcodex'),
  provider: z.literal('codex'),
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
})
export type FreshAgentRecoveryStopMessage = z.infer<typeof FreshAgentRecoveryStopSchema>

export const FreshAgentRecoveryStoppedSchema = z.object({
  type: z.literal('freshAgent.recovery.stopped'),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionType: z.literal('freshcodex'),
  provider: z.literal('codex'),
  success: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
})
export type FreshAgentRecoveryStoppedMessage = z.infer<typeof FreshAgentRecoveryStoppedSchema>

export const FreshAgentForkSchema = z.object({
  type: z.literal('freshAgent.fork'),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  /** D8 (focused-ep1-r5): the forking tab's client-side id — the fork child
   * row's provenance stamps from the forking connection, `deviceId:tabId`.
   * Non-strict schema — tolerated by older servers. */
  tabId: z.string().min(1).optional(),
  /** b8ke ext r21 F2: the delayed-request fence (additive; the pair rides
   *  the coordinator's generation discipline so a queued compact/undo/redo/
   *  fork landing after a crash + generation advance is typed-refused,
   *  never an unfenced recreation). */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
})

const freshAgentRollbackShape = {
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  mode: z.enum(['step', 'toTurn']).optional(),
  turnId: z.string().min(1).optional(),
  /** b8ke ext r21 F2: the delayed-request fence (additive; the pair rides
   *  the coordinator's generation discipline so a queued undo/redo landing
   *  after a crash + generation advance is typed-refused, never an
   *  unfenced recreation). */
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
} as const

/** kata 1wxv: conversation rollback. mode absent => 'step'. turnId required by the SERVER for 'toTurn'. */
export const FreshAgentUndoSchema = z.object({
  type: z.literal('freshAgent.undo'),
  ...freshAgentRollbackShape,
})

export const FreshAgentRedoSchema = z.object({
  type: z.literal('freshAgent.redo'),
  ...freshAgentRollbackShape,
})

export const FreshAgentClientMessageSchema = z.discriminatedUnion('type', [
  FreshAgentCreateSchema,
  FreshAgentAttachSchema,
  FreshAgentSendSchema,
  FreshAgentInterruptSchema,
  FreshAgentConfigureSchema,
  FreshAgentCompactSchema,
  FreshAgentApprovalRespondSchema,
  FreshAgentQuestionRespondSchema,
  FreshAgentKillSchema,
  FreshAgentForkSchema,
  FreshAgentUndoSchema,
  FreshAgentRedoSchema,
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
    terminalInterestV1: z.literal(true).optional(),
    paneReconcileV1: z.literal(true).optional(),
    paneReconcileFreshAgentV1: z.literal(true).optional(),
    // Paced terminal restore (Workstream 1): echoed only for a hello that
    // opted in via capabilities.pacedTerminalReplayV1.
    pacedTerminalReplayV1: z.literal(true).optional(),
    // Hidden-pane lifetime claims (Workstream 1): echoed only for a hello
    // that opted in via capabilities.terminalLifetimeClaimV1. Present iff the
    // client may send `terminal.interest.claimedTerminalIds`.
    terminalLifetimeClaimV1: z.literal(true).optional(),
    managedRuntimeV1: z.literal(true).optional(),
  })
  .optional()

export type ReadyCapabilities = z.infer<typeof ReadyCapabilitiesSchema>

/** Transient per-connection presentation state. Does not attach or resize. */
export const TerminalInterestSchema = z.object({
  type: z.literal('terminal.interest'),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  focusedTerminalId: z.string().min(1).max(512).nullable().optional(),
  visibleTerminalIds: z.array(z.string().min(1).max(512)).max(1024),
  /** Hidden-pane lifetime claims (negotiated `terminalLifetimeClaimV1` only):
   *  terminals this connection wants kept alive WITHOUT attaching. The claim
   *  never grants replay or output delivery and never touches geometry or
   *  stream identity; a later snapshot omitting an id is the explicit
   *  withdrawal (release). The client sends the field only after the ready
   *  echo; older clients never send it. */
  claimedTerminalIds: z.array(z.string().min(1).max(512)).max(1024).optional(),
})
export type TerminalInterestMessage = z.infer<typeof TerminalInterestSchema>

/**
 * Paced replay continuation credit (responsive-terminal-restore Workstream 1):
 * sent by a client whose hello negotiated `pacedTerminalReplayV1` after it
 * fully consumed an ordered replay page. `consumedSeq` is the last sequence
 * consumed in order; `attachRequestId` scopes the credit to one attach
 * generation. Additive optional — older servers accept-and-strip it, so it
 * needed no protocol version bump.
 */
export const TerminalReplayCreditSchema = z.object({
  type: z.literal('terminal.replay.credit'),
  terminalId: z.string().min(1).max(512),
  streamId: z.string().min(1).max(512),
  attachRequestId: z.string().min(1).max(512),
  consumedSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})
export type TerminalReplayCreditMessage = z.infer<typeof TerminalReplayCreditSchema>

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
  TerminalInterestSchema,
  TerminalAutoResumeCancelSchema,
  TerminalDetachSchema,
  PaneClosedSchema,
  PanesClosedSchema,
  PaneOpenedSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalReplayCreditSchema,
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
  FreshAgentConfigureSchema,
  FreshAgentCompactSchema,
  FreshAgentApprovalRespondSchema,
  FreshAgentQuestionRespondSchema,
  FreshAgentKillSchema,
  FreshAgentForkSchema,
  FreshAgentUndoSchema,
  FreshAgentRedoSchema,
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
  /** kata b8ke: current runtime-owner state for every recorded
   *  (provider, sessionId) — replayed so a device that missed a handoff
   *  broadcast (offline, lag-4008, reload) learns the authoritative owner
   *  from the handshake alone. Omitted from the wire when empty. */
  runtimeOwners?: Array<{
    provider: string
    sessionId: string
    /** The emitting server's boot epoch — the client resets its generation
     *  state on epoch change instead of ignoring newer generations. */
    epoch: number
    generation: number
    ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
    /** b8ke: the record's truthful state. 'live' — the named owner is the
     *  committed live owner (a vacant key's ownerKind carries its own
     *  truth). 'fenced' — a fenced record's ownerKind names the FENCED
     *  PRIOR (not a live owner); the client folds the typed recovery
     *  state (handoff-failed + reason), never a committed owner. R4-6:
     *  'starting' | 'handoff' | 'stopping' — in-progress lifecycle
     *  transitions (the client folds them as handoff-in-progress, never
     *  as committed ownership). Omitted by pre-R3-5 servers (fold as
     *  live). */
    state?: 'live' | 'fenced' | 'starting' | 'handoff' | 'stopping'
    /** The typed fence reason (fenced records only):
     *  'watcher-failed' | 'platform-limited'. */
    reason?: string
    terminalId?: string
    /** b8ke focused episode-2 post-cap F5 (wire-additive): for an ALIASED
     *  (re-keyed) key, the CANONICAL id the server resolved. The record's
     *  ownerKind/state/generation are the CANONICAL record's truth, so a
     *  cross-device pane holding the PRE-REKEY id folds the authoritative
     *  owner state (never a permanent "vacant") and `aliasOf` carries the
     *  navigation to the canonical key. */
    aliasOf?: string
  }>
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
  /** kata b8ke: ownership-conflict refusals only — the owning kind, its
   *  generation, and the emitting server's boot epoch, so the client can
   *  refresh its observed fence from the refusal itself. Additive; omitted
   *  everywhere else (the terminal lane's refusal surface). */
  ownerKind?: 'terminal' | 'fresh-agent'
  ownerGeneration?: number
  ownerEpoch?: number
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
  /** Unified agent names (Task 1): canonical session-name projection for this
   * terminal's naming ref (last-known; the `session.name.updated` broadcast is
   * the live authority). Additive optional. */
  sessionName?: SessionNameRecord
  /** Unified agent names (Task 1): the naming identity this terminal's name
   * resolves through (pending handle before durable materialization). */
  nameRef?: SessionNameRef
  /** b8ke fence-heal: the create's committed owner pair (additive, absent on legacy servers). */
  ownerKind?: 'terminal'
  ownerEpoch?: number
  ownerGeneration?: number
}

export type TerminalAttachReadyMessage = {
  type: 'terminal.attach.ready'
  terminalId: string
  streamId: string
  geometryEpoch?: number
  geometryAuthority?: TerminalGeometryAuthority
  requestedSinceSeq?: number
  effectiveSinceSeq?: number
  /** Restore contract (negotiated pacedTerminalReplayV1 only): earliest sequence position still available for replay (headSeq+1 when nothing older is retained). */
  oldestRetainedSeq?: number
  replayResetReason?: 'geometry_authority_unknown' | 'retention_lost'
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

/**
 * The correlated `terminal.kill` answer (delta-r6-r3 / focused-episode-6
 * round 2 Findings 6+7): sent ONLY when the kill carried `requestId`
 * (older clients keep the legacy error-frame answers), once the kill's
 * durable close envelope is resolved one way or the other.
 * `success: true` = the pane close is durably recorded AND the terminal is
 * gone (an already-absent registry entry — reaper race / stale pane — counts
 * as gone, the close envelope was still written). `success: false` = the
 * durable close failed, the terminal was left untouched, and `error`
 * explains it; the closing client must NOT drop the pane. server→client
 * only, additive — WS_PROTOCOL_VERSION stays.
 */
export type TerminalKilledMessage = {
  type: 'terminal.killed'
  requestId: string
  terminalId: string
  success: boolean
  error?: string
  /** b8ke fence-heal (fix b): the typed stale-claim refusal trio (the
   *  StaleClaim arm's coordinator CURRENTS — the owning kind, its
   *  generation, and the emitting server's boot epoch), additive and
   *  absent on every non-stale kill answer (frozen-client parity). The
   *  correlated close flow surfaces the pair on its await failure result
   *  so the caller can fold it into the runtimeOwners fence. */
  ownerKind?: 'terminal' | 'fresh-agent'
  ownerEpoch?: number
  ownerGeneration?: number
}

/**
 * The correlated `pane.closed` answer (delta-r7-round-3 / focused-episode-7
 * round 2, Finding F2): sent once per `pane.closed`, AFTER the durable
 * pane-close journal write resolved one way or the other, so the closing
 * client can await the evidence's durability before dropping the pane (the
 * kill lane's close-ack rule). Correlated by the pane identity — the close
 * is keyed by `createRequestId` end to end, no separate request id.
 * `terminalId` echoes the message's when present (absent on the
 * in-flight-create close shape). `success: false` (with `error`) means the
 * durable record could NOT be written — the client keeps the pane and shows
 * the failure on it; a persisted-despite-reported-error record answers
 * `success: true` (the evidence IS durable).
 *
 * server→client only. Introduced WITH the protocol version bump 8 → 9
 * (Finding F4): a server that predates this frame's schema drops unknown
 * typed messages silently, so the client awaits the answer ONLY from a
 * server the strict hello already proved speaks v10 — see
 * `shared/ws-version.ts` for the full mixed-version note.
 */
export type PaneClosedResultMessage = {
  type: 'pane.closed.result'
  createRequestId: string
  terminalId?: string
  success: boolean
  error?: string
}

/**
 * The correlated `panes.closed` answer (focused-episode-7 round 3, Finding
 * F1): sent ONCE per batch close, AFTER the ONE durable batch envelope write
 * resolved, so the closing client can await the whole tab's close evidence
 * before dropping the tab. Correlated by the close op's own `requestId`
 * (the batch answers the op, not a pane — terminal.kill's precedent).
 * `success: false` (with `error`) means NOTHING of the set is durable — the
 * client keeps the whole tab and shows the failure on every gated pane.
 *
 * server→client only. Introduced WITH the protocol version bump 9 → 10 —
 * see `shared/ws-version.ts` for the mixed-version note.
 */
export type PanesClosedResultMessage = {
  type: 'panes.closed.result'
  requestId: string
  success: boolean
  error?: string
}

/**
 * The correlated `pane.opened` answer (focused-episode-7 round 5, Finding
 * F3): sent once per `pane.opened`, AFTER the durable consume/re-assert
 * resolved one way or the other, correlated by the pane identity (the
 * re-assertion is keyed by `createRequestId` end to end — no separate
 * request id, the `pane.closed.result` precedent). `success: false` (with
 * `error`) means the consume could NOT be journaled durably — the client
 * marks the pane and retries the re-assertion on the next sweep tick (the
 * standing close record is untouched — fail loud, never pretend).
 *
 * server→client only. Additive with NO protocol version bump: the client
 * never GATES on this answer (its listen is bounded and non-blocking — an
 * unanswered re-assertion is exactly the pre-frame behavior the per-ready
 * sweep already heals), so a server that predates the frame degrades
 * harmlessly. Contrast `pane.closed.result`/`panes.closed.result`, which the
 * close gates AWAIT (the version-bump rule: an awaited answer a predated
 * server silently drops must never ship unversioned — see
 * `shared/ws-version.ts`).
 */
export type PaneOpenedResultMessage = {
  type: 'pane.opened.result'
  createRequestId: string
  success: boolean
  error?: string
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
  /** Auto-resume recovery and settled crash frames: the crashed generation's exit code. */
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
  reason:
    | 'queue_overflow'
    | 'replay_window_exceeded'
    | 'replay_budget_exceeded'
    | 'handoff_boundary_reached'
  attachRequestId?: string
  /** Restore contract (negotiated pacedTerminalReplayV1 only): the terminal's current headSeq at gap-emission time. */
  headSeq?: number
  /** Restore contract (negotiated pacedTerminalReplayV1 only): earliest sequence position still available for replay at gap-emission time. */
  oldestRetainedSeq?: number
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
/**
 * `terminal.stuck` — the terminal-mode wedged-agent flag, emitted once per
 * stuck/unstuck transition (and to fresh subscribers while flagged). Drives
 * the pane's "Agent appears stuck" card; never a completion edge.
 */
export type TerminalStuckMessage = z.infer<typeof TerminalStuckSchema>

// -- Sessions --

export type SessionsChangedMessage = {
  type: 'sessions.changed'
  revision: number
}

/**
 * Unified agent names (Task 1): the canonical name broadcast. Published only
 * after the server's `SessionNames` store successfully commits or adopts a
 * document generation, in local generation order. The payload IS a
 * `SessionNameUpdate` (record + documentGeneration + relevant pending→durable
 * redirects + whether the accepted record changed); clients fold by record
 * and redirect revision, never arrival time. `sessions.changed` remains the
 * directory-invalidation signal and never orders names. Additive
 * server→client only; it needed no WS_PROTOCOL_VERSION bump (the client
 * never gates on it — pre-frame servers simply never send it).
 */
export type SessionNameUpdatedMessage = SessionNameUpdate & {
  type: 'session.name.updated'
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
  /** Profile-aware backup path the banner should point at. */
  backupPath?: string
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

export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited' | 'stuck'
export type SdkRestoreFailureCode =
  | 'RESTORE_NOT_FOUND'
  | 'RESTORE_UNAVAILABLE'
  | 'RESTORE_INTERNAL'
  | 'RESTORE_DIVERGED'
  | 'RESTORE_STALE_REVISION'

export type FreshAgentServerMessage =
  | { type: 'freshAgent.created'; requestId: string; sessionId: string; sessionType: string; provider: string; runtimeProvider: string; sessionRef?: { provider: string; sessionId: string }; sessionName?: SessionNameRecord; nameRef?: SessionNameRef }
  | { type: 'freshAgent.create.failed'; requestId: string; code: string; message: string; retryable?: boolean
      /** kata b8ke: ownership-conflict refusals only — the owning kind, its
       *  generation, and the emitting server's boot epoch, so the client
       *  can refresh its observed fence from the refusal itself. Additive;
       *  omitted everywhere else (the fresh-agent lane's refusal surface). */
      ownerKind?: 'terminal' | 'fresh-agent'
      ownerGeneration?: number
      ownerEpoch?: number }
  | { type: 'freshAgent.send.accepted'; requestId: string; sessionId: string; sessionType: string; provider: string; submittedTurnId?: string; cwd?: string }
  | { type: 'freshAgent.event'; sessionId: string; sessionType: string; provider: string; event: unknown }
  | { type: 'freshAgent.session.materialized'; previousSessionId: string; sessionId: string; sessionType: string; provider: string; sessionRef?: { provider: string; sessionId: string }; sessionName?: SessionNameRecord; nameRef?: SessionNameRef }
  | { type: 'freshAgent.forked'; requestId?: string; parentSessionId: string; sessionId: string; sessionType: string; provider: string; runtimeProvider: string; parentRetiredByRuntime?: boolean; sessionRef?: { provider: string; sessionId: string } }
  | { type: 'freshAgent.killed'; sessionId: string; sessionType: string; provider: string; success: boolean }

/**
 * kata b8ke: one server-authoritative runtime owner per canonical
 * (provider, sessionId), shared by the terminal lane and every Fresh Agent
 * provider. Broadcast at every ownership transition (handoff
 * started/committed/failed, release) so every device holding a matching
 * sessionRef pane converges on the same owner — clients fold these
 * reactively (like `freshAgent.turn.complete`), nothing awaits an answer,
 * so it needed no protocol version bump. `epoch` is the emitting server's boot
 * epoch: fenced comparisons use (epoch, generation), and a client that sees
 * a different epoch resets its generation state instead of ignoring newer
 * generations.
 */
export type SessionRuntimeOwnerMessage = {
  type: 'session.runtimeOwner'
  provider: string
  sessionId: string
  /** The emitting server's boot epoch. */
  epoch: number
  generation: number
  ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
  previousKind?: 'terminal' | 'fresh-agent'
  /** The owning terminal runtime (terminal-owner frames only). */
  terminalId?: string
  /** The coordinator operation that produced this transition. */
  operationId: string
  transition: 'handoff-started' | 'handoff-committed' | 'handoff-failed' | 'released'
  /** Machine-readable failure reason (handoff-failed frames). */
  reason?: string
  /** b8ke R3-5: true on the ready-replay fold of a FENCED record (the
   *  named owner is the fenced prior, not a live owner). b8ke R4-5: the
   *  fenced reap/stop FAILURE broadcasts also set it — an online
   *  old-kind pane keeps the typed recovery state (no polling
   *  resumption) after the fenced failure frame. */
  fenced?: boolean
  /** b8ke focused episode-2 post-cap F5 (wire-additive): the CANONICAL id
   *  this frame's sessionId was re-keyed to. The rekey transition emits a
   *  mirror frame under the OLD key carrying the resolved owner state, so
   *  a device holding the pre-rekey id folds the canonical owner (never a
   *  permanent "vacant") and can navigate to the canonical key. */
  aliasOf?: string
}

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
    /** 'stopping': a requested stop of the row's unit is in flight (Gone not
     *  confirmed yet); the client shows "Stopping…" from it, so it survives a
     *  reload. */
    runtimeStatus?: 'running' | 'recovering' | 'stopping'
    /** When the stop of a 'stopping' row began (epoch ms). */
    stoppingSince?: number
    cwd?: string
    codexDurability?: CodexDurabilityRef
    /** Server→client only, additive + optional: the terminal's resume target is an opencode subagent (child) session. */
    resumeTargetIsSubagent?: boolean
    /** Unified agent names (Task 1): canonical session-name projection (last-known). Additive optional. */
    sessionName?: SessionNameRecord
    /** Unified agent names (Task 1): the naming identity this terminal's name resolves through. Additive optional. */
    nameRef?: SessionNameRef
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
  | TerminalKilledMessage
  | PaneClosedResultMessage
  | PanesClosedResultMessage
  | PaneOpenedResultMessage
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
  | TerminalStuckMessage
  | SessionNameUpdatedMessage
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
  | SessionRuntimeOwnerMessage
  | ExtensionRegistryMessage
  | ExtensionServerStartingMessage
  | ExtensionServerReadyMessage
  | ExtensionServerErrorMessage
  | ExtensionServerStoppedMessage
  | ManagedRuntimeInventoryChangedMessage
  | ManagedRuntimeViewChangedMessage
