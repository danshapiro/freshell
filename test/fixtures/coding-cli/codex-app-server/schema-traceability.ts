import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_RUNTIME_LEAF_VALUES,
  CODEX_SERVER_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_VARIANTS,
  type CodexClientRequestMethod,
  type CodexRuntimeLeafName,
  type CodexServerNotificationMethod,
  type CodexServerRequestMethod,
  type CodexThreadItemVariant,
} from './schema-inventory.js'

export type CodexTraceStatus = 'implemented' | 'planned' | 'unsupported'

export type CodexTraceEntry<TName extends string> = {
  name: TName
  status: CodexTraceStatus
  owner: string
  parser: string
  normalizer: string
  ui: string
  test: string
  notes?: string
}

const implementedClientMethods = new Set<CodexClientRequestMethod>([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/interrupt',
  'review/start',
  'thread/fork',
  'thread/list',
  'thread/loaded/list',
  'model/list',
  'modelProvider/capabilities/read',
])

const visibleNotificationMethods = new Set<CodexServerNotificationMethod>([
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'serverRequest/resolved',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'thread/compacted',
  'model/rerouted',
  'model/verification',
  'warning',
  'guardianWarning',
  'configWarning',
])

export const CODEX_CLIENT_REQUEST_TRACEABILITY: readonly CodexTraceEntry<CodexClientRequestMethod>[] =
  CODEX_CLIENT_REQUEST_METHODS.map((name) => ({
    name,
    status: implementedClientMethods.has(name) ? 'implemented' : 'unsupported',
    owner: implementedClientMethods.has(name)
      ? 'crates/freshell-codex/src/app_server.rs'
      : 'crates/freshell-codex/src/protocol.rs',
    parser: 'crates/freshell-codex/src/protocol.rs',
    normalizer: implementedClientMethods.has(name)
      ? 'crates/freshell-freshagent/src/codex.rs'
      : 'crates/freshell-codex/src/protocol.rs',
    ui: implementedClientMethods.has(name)
      ? 'src/components/fresh-agent/FreshAgentView.tsx'
      : 'clear unsupported Freshcodex action error',
    test: implementedClientMethods.has(name)
      ? 'crates/freshell-codex/tests/app_server_drive.rs'
      : 'test/unit/port/oracle/t2-codex-rust-baseline.test.ts',
    notes: name === 'thread/read'
      ? 'codex-cli 0.129.0 stable schema does not expose experimental thread/turns/list; Freshell opts into the experimental runtime method, falls back to thread/read when it is unavailable, and covers both paths with tests.'
      : undefined,
  }))

export const CODEX_SERVER_REQUEST_TRACEABILITY: readonly CodexTraceEntry<CodexServerRequestMethod>[] =
  CODEX_SERVER_REQUEST_METHODS.map((name) => ({
    name,
    status: 'planned',
    owner: 'crates/freshell-codex/src/app_server.rs',
    parser: 'crates/freshell-codex/src/protocol.rs',
    normalizer: 'crates/freshell-freshagent/src/codex.rs',
    ui: name === 'account/chatgptAuthTokens/refresh'
      ? 'runtime-global Freshcodex warning'
      : 'src/components/fresh-agent/FreshAgentView.tsx',
    test: 'test/unit/port/oracle/t2-codex-rust-baseline.test.ts',
  }))

export const CODEX_SERVER_NOTIFICATION_TRACEABILITY: readonly CodexTraceEntry<CodexServerNotificationMethod>[] =
  CODEX_SERVER_NOTIFICATION_METHODS.map((name) => ({
    name,
    status: visibleNotificationMethods.has(name) ? 'planned' : 'unsupported',
    owner: 'crates/freshell-codex/src/app_server.rs',
    parser: 'crates/freshell-codex/src/protocol.rs',
    normalizer: visibleNotificationMethods.has(name)
      ? 'crates/freshell-freshagent/src/codex.rs'
      : 'debug-only non-visible classification',
    ui: visibleNotificationMethods.has(name)
      ? 'src/components/fresh-agent/FreshAgentView.tsx'
      : 'no visible state effect',
    test: 'test/unit/port/oracle/t2-codex-rust-baseline.test.ts',
  }))

export const CODEX_THREAD_ITEM_TRACEABILITY: readonly CodexTraceEntry<CodexThreadItemVariant>[] =
  CODEX_THREAD_ITEM_VARIANTS.map((name) => ({
    name,
    status: 'planned',
    owner: 'crates/freshell-freshagent/src/codex.rs',
    parser: 'crates/freshell-codex/src/protocol.rs',
    normalizer: 'crates/freshell-freshagent/src/codex.rs',
    ui: 'src/components/fresh-agent/FreshAgentTranscript.tsx',
    test: 'test/unit/port/oracle/t2-codex-rust-baseline.test.ts',
  }))

export const CODEX_RUNTIME_LEAF_TRACEABILITY: readonly CodexTraceEntry<CodexRuntimeLeafName>[] =
  (Object.keys(CODEX_RUNTIME_LEAF_VALUES) as CodexRuntimeLeafName[]).map((name) => ({
    name,
    status: 'implemented',
    owner: 'crates/freshell-codex/src/protocol.rs',
    parser: 'crates/freshell-codex/src/protocol.rs',
    normalizer: 'crates/freshell-freshagent/src/codex.rs',
    ui: 'src/lib/session-type-utils.ts',
    test: 'test/unit/port/oracle/t2-codex-rust-baseline.test.ts',
  }))
