import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type DispositionDecision = 'retained' | 'deleted'

export type DispositionReceipt = {
  status: string
  count: number
  source?: string
  command?: string
}

export type NodeTestDispositionRow = {
  oldPath: string
  title: string
  subject: string
  decision: DispositionDecision
  replacementRequired: boolean
  survivingTest: string | null
  requiredLane: string
  selector: string | null
  latestReceipt: string | DispositionReceipt
}

export type NodeTestDispositionLedger = {
  version: 1
  universe: string
  candidateCount: number
  candidatePaths: string[]
  historicalPaths?: string[]
  rows: NodeTestDispositionRow[]
}

export type VerifyDispositionOptions = {
  root?: string
  expectedCandidateCount?: number
  enforceTask10Scope?: boolean
}

/**
 * Independent Task 10 deletion scope. This snapshot is deliberately kept
 * outside the ledger so a malformed or incomplete candidatePaths declaration
 * cannot make the closed-universe check pass. It is the exact set of test
 * paths removed by the Task 10 backend deletion.
 */
export const REQUIRED_TASK10_DELETED_TEST_PATHS = [
  "test/integration/server/api-edge-cases.test.ts",
  "test/integration/server/bootstrap-router.test.ts",
  "test/integration/server/candidate-dirs-api.test.ts",
  "test/integration/server/claude-transcript-locator.test.ts",
  "test/integration/server/client-logs-api.test.ts",
  "test/integration/server/codex-real-provider-smoke.test.ts",
  "test/integration/server/codex-session-flow.test.ts",
  "test/integration/server/codex-session-rebind-regression.test.ts",
  "test/integration/server/durable-session-contract.test.ts",
  "test/integration/server/files-api.test.ts",
  "test/integration/server/fixtures/slow-opencode-listing-query.ts",
  "test/integration/server/fixtures/ts-worker-support.ts",
  "test/integration/server/fresh-agent-claude-history-route-parity.test.ts",
  "test/integration/server/fresh-agent-model-capabilities-router.test.ts",
  "test/integration/server/fresh-agent-removes-legacy-routes.test.ts",
  "test/integration/server/lan-info-api.test.ts",
  "test/integration/server/local-file-router.test.ts",
  "test/integration/server/logger.separation.harness.test.ts",
  "test/integration/server/logger.separation.harness.ts",
  "test/integration/server/logger.separation.test.ts",
  "test/integration/server/network-api.test.ts",
  "test/integration/server/opencode-listing-compiled-worker.test.ts",
  "test/integration/server/opencode-listing-discovery.test.ts",
  "test/integration/server/opencode-listing-offthread.test.ts",
  "test/integration/server/opencode-serve-real-provider-smoke.test.ts",
  "test/integration/server/opencode-session-flow.test.ts",
  "test/integration/server/pane-picker-cli.test.ts",
  "test/integration/server/platform-api.test.ts",
  "test/integration/server/port-forward-api.test.ts",
  "test/integration/server/search-starvation-e2e.test.ts",
  "test/integration/server/server-info-api.test.ts",
  "test/integration/server/session-directory-router.test.ts",
  "test/integration/server/session-metadata-api.test.ts",
  "test/integration/server/sessions-resolve-router.test.ts",
  "test/integration/server/settings-api.test.ts",
  "test/integration/server/tabs-registry-store.persistence.test.ts",
  "test/integration/server/terminal-view-router.test.ts",
  "test/integration/server/test-coordinator.test.ts",
  "test/integration/server/unified-rename-integration.test.ts",
  "test/integration/server/wsl-port-forward.test.ts",
  "test/integration/session-repair.test.ts",
  "test/server/agent-api-fresh-agent.test.ts",
  "test/server/agent-capture-pane.test.ts",
  "test/server/agent-codex-identity-invariant.test.ts",
  "test/server/agent-layout-snapshot-api.test.ts",
  "test/server/agent-panes-api.test.ts",
  "test/server/agent-panes-write.test.ts",
  "test/server/agent-resize-pane.test.ts",
  "test/server/agent-run.test.ts",
  "test/server/agent-screenshot-api.test.ts",
  "test/server/agent-send-keys.test.ts",
  "test/server/agent-tabs-api.test.ts",
  "test/server/agent-tabs-write.test.ts",
  "test/server/agent-wait-for-api.test.ts",
  "test/server/agent-wait-for.test.ts",
  "test/server/ai-api.test.ts",
  "test/server/amplifier-session-association.test.ts",
  "test/server/api.test.ts",
  "test/server/bootstrap-env-root.compiled-start.test.ts",
  "test/server/codex-activity-exact-subset.test.ts",
  "test/server/fresh-agent-extras.test.ts",
  "test/server/perf-api.test.ts",
  "test/server/session-association-broadcast.test.ts",
  "test/server/session-association.test.ts",
  "test/server/sessions-router-generate-title.test.ts",
  "test/server/tabs-registry-client-retire-api.test.ts",
  "test/server/terminals-api.test.ts",
  "test/server/test-clock-router.test.ts",
  "test/server/test-clock.test.ts",
  "test/server/ws-amplifier-activity.test.ts",
  "test/server/ws-claude-activity.test.ts",
  "test/server/ws-codex-activity.test.ts",
  "test/server/ws-codex-turn-complete.test.ts",
  "test/server/ws-edge-cases.test.ts",
  "test/server/ws-extension-registry.test.ts",
  "test/server/ws-handshake-snapshot.test.ts",
  "test/server/ws-opencode-activity.test.ts",
  "test/server/ws-protocol.test.ts",
  "test/server/ws-session-observability.test.ts",
  "test/server/ws-session-repair-activity.test.ts",
  "test/server/ws-sidebar-snapshot-refresh.test.ts",
  "test/server/ws-tabs-registry.test.ts",
  "test/server/ws-terminal-codex-identity-invariant.test.ts",
  "test/server/ws-terminal-create-reuse-running-claude.test.ts",
  "test/server/ws-terminal-create-reuse-running-codex.test.ts",
  "test/server/ws-terminal-create-session-repair.test.ts",
  "test/server/ws-terminal-idle.test.ts",
  "test/server/ws-terminal-meta.test.ts",
  "test/server/ws-terminal-modes-sync.test.ts",
  "test/server/ws-terminal-stream-v2-replay.test.ts",
  "test/unit/server/agent-api/layout-store-fresh-agent.test.ts",
  "test/unit/server/agent-api/layout-store.fresh-agent.test.ts",
  "test/unit/server/agent-layout-schema.test.ts",
  "test/unit/server/agent-layout-store-write.test.ts",
  "test/unit/server/agent-layout-store.test.ts",
  "test/unit/server/agent-response.test.ts",
  "test/unit/server/agent-screenshot-path.test.ts",
  "test/unit/server/agent-target-resolver.test.ts",
  "test/unit/server/ai-prompts.test.ts",
  "test/unit/server/api.test.ts",
  "test/unit/server/auth.test.ts",
  "test/unit/server/auto-title.test.ts",
  "test/unit/server/bootstrap.test.ts",
  "test/unit/server/chunk-ring-buffer.test.ts",
  "test/unit/server/claude-stream-types.test.ts",
  "test/unit/server/coding-cli/amplifier-activity-integration.test.ts",
  "test/unit/server/coding-cli/amplifier-activity-tracker.test.ts",
  "test/unit/server/coding-cli/amplifier-activity-wiring.test.ts",
  "test/unit/server/coding-cli/amplifier-events-reducer.test.ts",
  "test/unit/server/coding-cli/amplifier-events-tailer.test.ts",
  "test/unit/server/coding-cli/amplifier-provider.test.ts",
  "test/unit/server/coding-cli/amplifier-session-controller.test.ts",
  "test/unit/server/coding-cli/amplifier-session-locator.test.ts",
  "test/unit/server/coding-cli/claude-activity-tracker.test.ts",
  "test/unit/server/coding-cli/claude-activity-wiring.test.ts",
  "test/unit/server/coding-cli/claude-provider.test.ts",
  "test/unit/server/coding-cli/codex-activity-tracker.test.ts",
  "test/unit/server/coding-cli/codex-activity-wiring.test.ts",
  "test/unit/server/coding-cli/codex-app-server/client.test.ts",
  "test/unit/server/coding-cli/codex-app-server/durability-proof.test.ts",
  "test/unit/server/coding-cli/codex-app-server/durability-store.test.ts",
  "test/unit/server/coding-cli/codex-app-server/json-rpc-envelope.test.ts",
  "test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts",
  "test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts",
  "test/unit/server/coding-cli/codex-app-server/launch-retry.test.ts",
  "test/unit/server/coding-cli/codex-app-server/legacy-sidecar-dead-code.test.ts",
  "test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts",
  "test/unit/server/coding-cli/codex-app-server/remote-proxy-large-forward-child.ts",
  "test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts",
  "test/unit/server/coding-cli/codex-app-server/remote-tui-failure-detector.test.ts",
  "test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts",
  "test/unit/server/coding-cli/codex-app-server/runtime.test.ts",
  "test/unit/server/coding-cli/codex-app-server/schema-traceability.test.ts",
  "test/unit/server/coding-cli/codex-child-registry.test.ts",
  "test/unit/server/coding-cli/codex-observability.test.ts",
  "test/unit/server/coding-cli/codex-provider.test.ts",
  "test/unit/server/coding-cli/git-metadata.test.ts",
  "test/unit/server/coding-cli/opencode-activity-integration.test.ts",
  "test/unit/server/coding-cli/opencode-activity-tracker.test.ts",
  "test/unit/server/coding-cli/opencode-activity-wiring.test.ts",
  "test/unit/server/coding-cli/opencode-by-id-query.test.ts",
  "test/unit/server/coding-cli/opencode-by-id-runner.test.ts",
  "test/unit/server/coding-cli/opencode-listing-query.test.ts",
  "test/unit/server/coding-cli/opencode-listing-runner.test.ts",
  "test/unit/server/coding-cli/opencode-listing-worker.test.ts",
  "test/unit/server/coding-cli/opencode-ownership-reducer.test.ts",
  "test/unit/server/coding-cli/opencode-provider.sqlite.test.ts",
  "test/unit/server/coding-cli/opencode-provider.test.ts",
  "test/unit/server/coding-cli/opencode-session-controller.test.ts",
  "test/unit/server/coding-cli/opencode-subagent-query.test.ts",
  "test/unit/server/coding-cli/provider-root-failures.test.ts",
  "test/unit/server/coding-cli/provider-title-cleanup.test.ts",
  "test/unit/server/coding-cli/resolve-fallbacks.test.ts",
  "test/unit/server/coding-cli/resolve-git-root.test.ts",
  "test/unit/server/coding-cli/resolve-session.test.ts",
  "test/unit/server/coding-cli/scan-user-text-messages.test.ts",
  "test/unit/server/coding-cli/session-indexer-malformed-corpus.test.ts",
  "test/unit/server/coding-cli/session-indexer-provider-refresh.test.ts",
  "test/unit/server/coding-cli/session-indexer.test.ts",
  "test/unit/server/coding-cli/session-manager.test.ts",
  "test/unit/server/coding-cli/session-visibility.test.ts",
  "test/unit/server/coding-cli/truly-idle-emitter.test.ts",
  "test/unit/server/coding-cli/turn-completion-ledger.test.ts",
  "test/unit/server/coding-cli/turn-completion-snapshots.test.ts",
  "test/unit/server/coding-cli/types.test.ts",
  "test/unit/server/coding-cli/utils.test.ts",
  "test/unit/server/config-store.fresh-agent-settings.test.ts",
  "test/unit/server/config-store.ladder.test.ts",
  "test/unit/server/config-store.test.ts",
  "test/unit/server/detect-available-clis.test.ts",
  "test/unit/server/editor-settings.test.ts",
  "test/unit/server/elevated-powershell.test.ts",
  "test/unit/server/esm-imports.test.ts",
  "test/unit/server/extension-manager-lifecycle.test.ts",
  "test/unit/server/extension-manager.test.ts",
  "test/unit/server/extension-manifest.test.ts",
  "test/unit/server/extension-routes.test.ts",
  "test/unit/server/file-opener.test.ts",
  "test/unit/server/files-router.test.ts",
  "test/unit/server/firewall.test.ts",
  "test/unit/server/fresh-agent/claude-adapter.test.ts",
  "test/unit/server/fresh-agent/claude-history-include-bodies.test.ts",
  "test/unit/server/fresh-agent/claude-history-ledger.test.ts",
  "test/unit/server/fresh-agent/claude-history-service.test.ts",
  "test/unit/server/fresh-agent/claude-history-source.test.ts",
  "test/unit/server/fresh-agent/claude-normalize.test.ts",
  "test/unit/server/fresh-agent/claude-restore-contract.test.ts",
  "test/unit/server/fresh-agent/codex-adapter.test.ts",
  "test/unit/server/fresh-agent/codex-normalize.test.ts",
  "test/unit/server/fresh-agent/incident-router.test.ts",
  "test/unit/server/fresh-agent/model-capability-registry.supportedModels.probe.ts",
  "test/unit/server/fresh-agent/model-capability-registry.test.ts",
  "test/unit/server/fresh-agent/observability.test.ts",
  "test/unit/server/fresh-agent/opencode-commands-catalog.test.ts",
  "test/unit/server/fresh-agent/opencode-history-query.test.ts",
  "test/unit/server/fresh-agent/opencode-history-runner.test.ts",
  "test/unit/server/fresh-agent/opencode-history-worker.test.ts",
  "test/unit/server/fresh-agent/opencode-interrupted-turn.test.ts",
  "test/unit/server/fresh-agent/opencode-model-catalog.test.ts",
  "test/unit/server/fresh-agent/opencode-normalize.test.ts",
  "test/unit/server/fresh-agent/opencode-serve-adapter.test.ts",
  "test/unit/server/fresh-agent/opencode-serve-events.test.ts",
  "test/unit/server/fresh-agent/opencode-serve-manager.test.ts",
  "test/unit/server/fresh-agent/production-wiring.test.ts",
  "test/unit/server/fresh-agent/recovery-store.test.ts",
  "test/unit/server/fresh-agent/router.test.ts",
  "test/unit/server/fresh-agent/runtime-manager.test.ts",
  "test/unit/server/fresh-agent/sdk-events.test.ts",
  "test/unit/server/fresh-agent/turn-complete-clock.test.ts",
  "test/unit/server/launch-cwd.test.ts",
  "test/unit/server/log-context.test.ts",
  "test/unit/server/logger.test.ts",
  "test/unit/server/mcp/config-writer-paths.test.ts",
  "test/unit/server/mcp/config-writer.test.ts",
  "test/unit/server/network-access.test.ts",
  "test/unit/server/network-manager.test.ts",
  "test/unit/server/opencode-launch.test.ts",
  "test/unit/server/path-utils.test.ts",
  "test/unit/server/perf-logger.test.ts",
  "test/unit/server/platform.test.ts",
  "test/unit/server/port-forward.test.ts",
  "test/unit/server/production-build-integrity.test.ts",
  "test/unit/server/production-edge-cases.test.ts",
  "test/unit/server/proxy-router.test.ts",
  "test/unit/server/rate-limit.test.ts",
  "test/unit/server/read-models/request-abort.test.ts",
  "test/unit/server/read-models/work-scheduler.test.ts",
  "test/unit/server/request-ip.test.ts",
  "test/unit/server/request-logger.test.ts",
  "test/unit/server/sdk-bridge-types.test.ts",
  "test/unit/server/sdk-bridge.test.ts",
  "test/unit/server/session-association-coordinator.test.ts",
  "test/unit/server/session-binding-authority.test.ts",
  "test/unit/server/session-cache-races.test.ts",
  "test/unit/server/session-cache.test.ts",
  "test/unit/server/session-content-cache.test.ts",
  "test/unit/server/session-directory/file-search.test.ts",
  "test/unit/server/session-directory/fresh-agent-projection.test.ts",
  "test/unit/server/session-directory/projection.test.ts",
  "test/unit/server/session-directory/service.test.ts",
  "test/unit/server/session-history-loader-path-resolution.test.ts",
  "test/unit/server/session-history-loader.test.ts",
  "test/unit/server/session-history-repair.test.ts",
  "test/unit/server/session-metadata-store.test.ts",
  "test/unit/server/session-observability.test.ts",
  "test/unit/server/session-pagination.test.ts",
  "test/unit/server/session-queue.test.ts",
  "test/unit/server/session-repair-service.test.ts",
  "test/unit/server/session-scanner.test.ts",
  "test/unit/server/session-title-sync.test.ts",
  "test/unit/server/sessions-router-pagination.test.ts",
  "test/unit/server/sessions-sync/diff.test.ts",
  "test/unit/server/sessions-sync/service.test.ts",
  "test/unit/server/settings-migrate.test.ts",
  "test/unit/server/shutdown-join.test.ts",
  "test/unit/server/sidebar-session-selection.test.ts",
  "test/unit/server/startup-banner.test.ts",
  "test/unit/server/startup-state.test.ts",
  "test/unit/server/startup-url.test.ts",
  "test/unit/server/static-cache-headers.test.ts",
  "test/unit/server/tabs-registry/fresh-agent-migration.test.ts",
  "test/unit/server/tabs-registry/store.test.ts",
  "test/unit/server/terminal-env.test.ts",
  "test/unit/server/terminal-lifecycle.test.ts",
  "test/unit/server/terminal-metadata-service.test.ts",
  "test/unit/server/terminal-registry.bind-reclassify-guard.test.ts",
  "test/unit/server/terminal-registry.codex-recovery.test.ts",
  "test/unit/server/terminal-registry.codex-sidecar.test.ts",
  "test/unit/server/terminal-registry.findRunningTerminal.test.ts",
  "test/unit/server/terminal-registry.rebind-metadata-resync.test.ts",
  "test/unit/server/terminal-registry.test-clock.test.ts",
  "test/unit/server/terminal-registry.test.ts",
  "test/unit/server/terminal-session-identity.test.ts",
  "test/unit/server/terminal-stream/broker-modes-sync.test.ts",
  "test/unit/server/terminal-stream/client-output-queue.test.ts",
  "test/unit/server/terminal-stream/mode-preamble-fixtures.test.ts",
  "test/unit/server/terminal-stream/mode-tracker.test.ts",
  "test/unit/server/terminal-stream/output-barrier-scanner.test.ts",
  "test/unit/server/terminal-stream/output-batch.test.ts",
  "test/unit/server/terminal-stream/output-fragments.test.ts",
  "test/unit/server/terminal-stream/replay-deque.test.ts",
  "test/unit/server/terminal-stream/replay-ring.test.ts",
  "test/unit/server/terminal-stream/serialized-budget.test.ts",
  "test/unit/server/terminal-stream/stream-identity.test.ts",
  "test/unit/server/terminal-view/mirror.test.ts",
  "test/unit/server/title-utils.test.ts",
  "test/unit/server/unified-rename.test.ts",
  "test/unit/server/updater/executor.test.ts",
  "test/unit/server/updater/index.test.ts",
  "test/unit/server/updater/prompt.test.ts",
  "test/unit/server/updater/version-checker.test.ts",
  "test/unit/server/utils.test.ts",
  "test/unit/server/ws-fresh-agent-contract.test.ts",
  "test/unit/server/ws-handler-backpressure.test.ts",
  "test/unit/server/ws-handler-fresh-agent-backpressure.test.ts",
  "test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts",
  "test/unit/server/ws-handler-fresh-agent-ownership.test.ts",
  "test/unit/server/ws-handler-fresh-agent.test.ts",
  "test/unit/server/ws-send.test.ts",
  "test/unit/server/wsl-port-forward.test.ts",
] as const

const RECEIPT_STRING_RE = /^(PASS|SUPPLEMENTAL|SKIPPED|DELETED)\b/i
const VALID_RECEIPT_STATUSES = new Set(['passed', 'pass', 'supplemental', 'skipped', 'deleted'])
const NONE_VALUES = new Set(['', 'none', 'n/a', 'not-applicable', 'not applicable', 'null'])
const KNOWN_HISTORICAL_PATHS = new Set(['test/e2e/update-flow.test.ts'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRelativePath(value: string): boolean {
  return value.length > 0
    && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/.test(value)
    && value !== '..'
    && !value.startsWith('../')
    && !value.includes('\\')
}

function normalizeReceipt(value: unknown): DispositionReceipt | undefined {
  if (typeof value === 'string') {
    const match = value.match(RECEIPT_STRING_RE)
    if (!match) return undefined
    const status = match[1].toLowerCase()
    return {
      status,
      count: status === 'pass' || status === 'supplemental' ? 1 : 0,
      source: value,
    }
  }
  if (!isRecord(value) || typeof value.status !== 'string' || typeof value.count !== 'number') {
    return undefined
  }
  return {
    status: value.status.toLowerCase(),
    count: value.count,
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
  }
}

function rowKey(row: NodeTestDispositionRow): string {
  return `${row.oldPath}\u0000${row.subject}`
}

function error(errors: string[], row: Partial<NodeTestDispositionRow>, message: string): void {
  const location = typeof row.oldPath === 'string' && row.oldPath ? row.oldPath : '<row>'
  const subject = typeof row.subject === 'string' && row.subject ? ` [${row.subject}]` : ''
  errors.push(`${location}${subject}: ${message}`)
}

function validateRowShape(candidate: unknown, errors: string[], index: number): candidate is NodeTestDispositionRow {
  if (!isRecord(candidate)) {
    errors.push(`row ${index}: expected an object`)
    return false
  }
  const row = candidate as Partial<NodeTestDispositionRow>
  if (typeof row.oldPath !== 'string' || !isRelativePath(row.oldPath)) error(errors, row, 'oldPath must be a repository-relative POSIX path')
  if (typeof row.title !== 'string' || !row.title.trim()) error(errors, row, 'title is unresolved')
  if (typeof row.subject !== 'string' || !row.subject.trim()) error(errors, row, 'subject is unresolved')
  if (row.decision !== 'retained' && row.decision !== 'deleted') error(errors, row, 'decision must be retained or deleted')
  if (typeof row.replacementRequired !== 'boolean') error(errors, row, 'replacementRequired must be boolean')
  if (row.survivingTest !== null && (typeof row.survivingTest !== 'string' || !row.survivingTest.trim())) error(errors, row, 'survivingTest is malformed')
  if (typeof row.requiredLane !== 'string' || !row.requiredLane.trim()) error(errors, row, 'requiredLane is unresolved')
  if (row.selector !== null && (typeof row.selector !== 'string' || !row.selector.trim())) error(errors, row, 'selector is malformed')
  if (!normalizeReceipt(row.latestReceipt)) error(errors, row, 'latestReceipt is missing or has an unknown status')
  return true
}

function validateReplacement(row: NodeTestDispositionRow, errors: string[]): void {
  const receipt = normalizeReceipt(row.latestReceipt)
  if (!receipt) return

  if (row.decision === 'retained' && !row.replacementRequired) {
    error(errors, row, 'retained subject must require a replacement')
  }
  if (row.decision === 'deleted' && row.replacementRequired) {
    error(errors, row, 'deleted subject cannot require a replacement')
  }

  if (!row.replacementRequired) {
    if (row.requiredLane === 'none' && row.selector !== null) error(errors, row, 'non-replacement row has a selector')
    return
  }

  if (!row.survivingTest || NONE_VALUES.has(row.survivingTest.trim().toLowerCase())) error(errors, row, 'replacement test is unresolved')
  if (!row.selector || NONE_VALUES.has(row.selector.trim().toLowerCase())) error(errors, row, 'replacement selector is unresolved')
  if (row.requiredLane === 'none' || row.requiredLane === 'supplemental-t2') {
    error(errors, row, 'optional/supplemental lane cannot satisfy a required replacement')
  }
  if (!VALID_RECEIPT_STATUSES.has(receipt.status)) error(errors, row, `receipt status ${JSON.stringify(receipt.status)} is unknown`)
  if (receipt.status !== 'passed' && receipt.status !== 'pass') {
    error(errors, row, `replacement receipt is not positive (${receipt.status})`)
  }
  if (!Number.isInteger(receipt.count) || receipt.count <= 0) error(errors, row, 'replacement receipt selected zero tests')
  if (!(receipt.source ?? receipt.command ?? '').trim()) error(errors, row, 'replacement receipt has no provenance')
}

/**
 * Validate the deletion ledger without relying on the source files still being
 * present. The old paths are intentionally historical after Task 10; the
 * optional root check only verifies surviving replacement tests.
 */
export async function verifyNodeTestDisposition(
  candidate: unknown,
  options: VerifyDispositionOptions = {},
): Promise<string[]> {
  const errors: string[] = []
  if (!isRecord(candidate)) return ['ledger: expected an object']
  const ledger = candidate as Partial<NodeTestDispositionLedger>
  const expectedCandidateCount = options.expectedCandidateCount ?? 347
  const enforceTask10Scope = options.enforceTask10Scope ?? expectedCandidateCount === 347

  if (ledger.version !== 1) errors.push('ledger: version must be 1')
  if (typeof ledger.universe !== 'string' || !ledger.universe.trim()) errors.push('ledger: universe is unresolved')
  if (ledger.candidateCount !== expectedCandidateCount) errors.push(`ledger: candidateCount must be ${expectedCandidateCount}`)
  if (!Array.isArray(ledger.rows)) {
    errors.push('ledger: rows must be an array')
    return errors
  }

  const candidatePaths = ledger.candidatePaths
  const candidatePathSet = new Set<string>()
  if (!Array.isArray(candidatePaths)) {
    errors.push('ledger: candidatePaths must be an array')
  } else {
    for (const [index, candidatePath] of candidatePaths.entries()) {
      if (typeof candidatePath !== 'string' || !isRelativePath(candidatePath)) {
        errors.push(`candidatePaths[${index}]: expected a repository-relative POSIX path`)
        continue
      }
      if (candidatePathSet.has(candidatePath)) errors.push(`duplicate candidate path: ${candidatePath}`)
      candidatePathSet.add(candidatePath)
    }
    if (candidatePaths.length !== ledger.candidateCount) errors.push(`ledger: candidatePaths has ${candidatePaths.length} entries, expected ${ledger.candidateCount}`)
  }

  if (enforceTask10Scope) {
    for (const requiredPath of REQUIRED_TASK10_DELETED_TEST_PATHS) {
      if (!candidatePathSet.has(requiredPath)) {
        errors.push(`ledger: required Task 10 deleted test path missing from closed candidate universe: ${requiredPath}`)
      }
    }
  }

  const historicalPaths = ledger.historicalPaths
  const historicalPathSet = new Set<string>()
  if (historicalPaths !== undefined) {
    if (!Array.isArray(historicalPaths)) {
      errors.push('ledger: historicalPaths must be an array')
    } else {
      for (const [index, historicalPath] of historicalPaths.entries()) {
        if (typeof historicalPath !== 'string' || !isRelativePath(historicalPath)) {
          errors.push(`historicalPaths[${index}]: expected a repository-relative POSIX path`)
          continue
        }
        if (!KNOWN_HISTORICAL_PATHS.has(historicalPath)) {
          errors.push(`historicalPaths[${index}]: path is not an approved prior-task deletion: ${historicalPath}`)
        }
        if (historicalPathSet.has(historicalPath)) errors.push(`duplicate historical path: ${historicalPath}`)
        historicalPathSet.add(historicalPath)
      }
    }
  }

  const rowsByKey = new Map<string, NodeTestDispositionRow>()
  const pathsWithRows = new Set<string>()
  for (const [index, candidateRow] of ledger.rows.entries()) {
    if (!validateRowShape(candidateRow, errors, index)) continue
    const row = candidateRow
    const key = rowKey(row)
    if (rowsByKey.has(key)) errors.push(`duplicate disposition row: ${row.oldPath} [${row.subject}]`)
    rowsByKey.set(key, row)
    pathsWithRows.add(row.oldPath)
    if (!candidatePathSet.has(row.oldPath) && !historicalPathSet.has(row.oldPath)) {
      error(errors, row, 'oldPath is not in the closed candidate universe')
    }
    validateReplacement(row, errors)
  }

  if (ledger.rows.length < ledger.candidateCount) errors.push(`ledger: only ${ledger.rows.length} rows for ${ledger.candidateCount} candidate files`)
  const candidateRows = [...pathsWithRows].filter((oldPath) => candidatePathSet.has(oldPath))
  if (candidateRows.length !== ledger.candidateCount) errors.push(`ledger: ${candidateRows.length} unique candidate old paths for ${ledger.candidateCount} candidate files`)
  for (const oldPath of pathsWithRows) {
    if (!candidatePathSet.has(oldPath) && !historicalPathSet.has(oldPath)) {
      errors.push(`row path is neither a candidate nor an explicitly historical path: ${oldPath}`)
    }
  }
  for (const historicalPath of historicalPathSet) {
    if (!pathsWithRows.has(historicalPath)) errors.push(`historical path without disposition: ${historicalPath}`)
  }
  if (candidatePathSet.size > 0) {
    for (const candidatePath of candidatePathSet) {
      if (!pathsWithRows.has(candidatePath)) errors.push(`stale candidate path without disposition: ${candidatePath}`)
    }
  }

  if (options.root) {
    for (const row of rowsByKey.values()) {
      if (!row.replacementRequired || !row.survivingTest) continue
      try {
        await readFile(path.join(options.root, ...row.survivingTest.split('/')))
      } catch {
        error(errors, row, `surviving test is absent: ${row.survivingTest}`)
      }
    }
  }

  return [...new Set(errors)].sort()
}

export async function loadNodeTestDisposition(root: string): Promise<NodeTestDispositionLedger> {
  const file = path.join(root, 'scripts/retirement/node-test-disposition.json')
  return JSON.parse(await readFile(file, 'utf8')) as NodeTestDispositionLedger
}

async function main(): Promise<void> {
  const root = path.resolve(process.cwd())
  const ledger = await loadNodeTestDisposition(root)
  const errors = await verifyNodeTestDisposition(ledger, { root })
  if (errors.length > 0) {
    for (const item of errors) process.stderr.write(`${item}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(JSON.stringify({
    severity: 'info',
    event: 'node_test_disposition_verified',
    candidateCount: ledger.candidateCount,
    rowCount: ledger.rows.length,
    retainedRows: ledger.rows.filter((row) => row.decision === 'retained').length,
    deletedRows: ledger.rows.filter((row) => row.decision === 'deleted').length,
  }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
