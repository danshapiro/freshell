import { ManagedRuntimeOwner, requireOpenCodeOnecliBootstrap } from '../../../scripts/testing/runtime-sandbox.js'
import { RustServer } from './rust-server.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import { resolveManagedExternalDescriptor, type ManagedHistoryWindowFacts, type ManagedHistoryWindowStage } from '../../../scripts/testing/runtime-external-browser.js'
import { ExternalManagedRuntimeRig } from './external-managed-runtime.js'
import { expect, type Page } from '@playwright/test'
import { executeAction } from '../../../tools/freshell-mcp/freshell-tool.js'
import { resolveCanonicalAction } from '../../../tools/node-client-runtime/action-capabilities.js'

/** Observe the real MCP client's create transport; callers retain native alias checks. */
export async function observeFreshMcpIngress(action: string, params: Record<string, unknown>, invoke = executeAction) {
  const prior = globalThis.fetch
  const requests: any[] = []
  const dataOf = (result: any): any => result?.data?.data ?? result?.data ?? result
  const hasPaneId = (result: any): boolean => typeof result?.paneId === 'string' && result.paneId.trim().length > 0
  let result: any
  let invocationFailed = false
  globalThis.fetch = async (input, init) => {
    const response = await prior(input, init)
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (init?.method === 'POST' && /^\/api\/(?:tabs|panes\/[^/]+\/split)$/.test(url.pathname)) {
      const observation = { request: { method: init.method, path: url.pathname, body: JSON.parse(String(init.body)) },
        reply: undefined as any, httpOk: response.ok, status: 'absent', errorPresent: false }
      requests.push(observation)
      const envelope = await response.clone().json()
      observation.reply = dataOf(envelope)
      observation.status = envelope?.status === undefined ? 'absent'
        : envelope.status === 'ok' || envelope.status === 'error' ? envelope.status : 'other'
      observation.errorPresent = Boolean(envelope?.error || observation.reply?.error)
    }
    return response
  }
  try {
    try { result = dataOf(await invoke(action, params)) } catch { invocationFailed = true }
    const observed = requests[0]
    const errorPresent = invocationFailed || Boolean(result?.error) || requests.some(row => row.errorPresent)
    if (requests.length !== 1 || !hasPaneId(result) || errorPresent || !observed?.httpOk
      || !['ok', 'absent'].includes(observed.status) || !hasPaneId(observed.reply) || observed.reply.paneId !== result.paneId) {
      // Log only finite transport facts: provider errors and input bodies can contain secrets.
      throw new Error('actual MCP request/reply was not observed: ' + JSON.stringify({
        action: resolveCanonicalAction(action) ?? 'unknown', requestCount: requests.length,
        paneIdPresent: hasPaneId(result), errorPresent, status: observed?.status ?? 'absent',
      }))
    }
    return { request: observed.request, reply: observed.reply }
  } finally { globalThis.fetch = prior }
}

/** Runs inside the browser; indexed rows and diagnostics describe one state read. */
export function observeManagedHistoryWindow({ provider, nativeSessionId }: { provider: string; nativeSessionId: string }) {
  const sessions = window.__FRESHELL_TEST_HARNESS__?.getState().sessions
  const history = sessions?.windows?.history
  const projects = history?.projects ?? []
  const indexed = projects.flatMap(project => project.sessions
    .filter(session => session.provider === provider && session.sessionId === nativeSessionId)
    .map(session => ({ projectPath: project.projectPath, cwd: session.cwd, checkoutPath: session.checkoutPath })))
  const count = (groups: typeof projects | undefined) => groups?.reduce((total, project) => total + project.sessions
    .filter(session => session.provider === provider && session.sessionId === nativeSessionId).length, 0)
  if (!history) return { indexed, facts: { available: false, exactIdentityCount: indexed.length,
    sidebarExactIdentityCount: count(sessions?.windows?.sidebar?.projects), topLevelExactIdentityCount: count(sessions?.projects) } as ManagedHistoryWindowFacts }
  const tier = (value: string | undefined): 'absent' | 'title' | 'other' => value === undefined ? 'absent' : value === 'title' ? 'title' : 'other'
  const facts: ManagedHistoryWindowFacts = { available: Boolean(history), exactIdentityCount: indexed.length,
    resultVersion: typeof history?.resultVersion === 'number' && Number.isSafeInteger(history.resultVersion) && history.resultVersion >= 0
      ? history.resultVersion : undefined,
    lastLoadedAtPresent: typeof history?.lastLoadedAt === 'number', loading: history?.loading,
    loadingKind: history?.loadingKind === undefined ? 'absent'
      : ['initial', 'search', 'background', 'pagination'].includes(history.loadingKind) ? history.loadingKind : 'other',
    errorPresent: Boolean(history?.error), requestedQueryEmpty: !(history?.query ?? '').trim(), appliedQueryEmpty: !(history?.appliedQuery ?? '').trim(),
    requestedTier: tier(history?.searchTier), appliedTier: tier(history?.appliedSearchTier), partial: history?.partial,
    integrity: !history ? 'unknown' : !history.integrityError ? 'none' : history.integrityError.kind === 'identity_collision' ? 'identity_collision' : 'other',
    activeSurface: sessions?.activeSurface === undefined ? 'absent' : sessions.activeSurface === 'history' ? 'history' : sessions.activeSurface === 'sidebar' ? 'sidebar' : 'other',
    sidebarExactIdentityCount: count(sessions?.windows?.sidebar?.projects), topLevelExactIdentityCount: count(sessions?.projects) }
  return { indexed, facts }
}

export interface ManagedHistoryWindowObservation {
  begin(deadline: number): void
  captureWindow(stage: ManagedHistoryWindowStage, read: () => Promise<ManagedHistoryWindowFacts>): void
  window(stage: ManagedHistoryWindowStage, facts: ManagedHistoryWindowFacts): void
}

/** Open the indexed native session through the actual Projects history UI. */
export async function openFreshHistorySession(page: Page, identity: {
  repoRoot: string; provider: string; nativeSessionId: string
}, observation?: ManagedHistoryWindowObservation): Promise<void> {
  const deadline = Date.now() + 60_000
  const capture = (stage: ManagedHistoryWindowStage) => {
    try { observation?.captureWindow(stage, async () => (await page.evaluate(observeManagedHistoryWindow, identity)).facts) } catch { /* diagnostics preserve the original action */ }
  }
  try { observation?.begin(deadline) } catch { /* diagnostic setup cannot replace an assertion */ }
  const remaining = () => {
    const timeout = deadline - Date.now()
    if (timeout <= 0) throw new Error('history opening deadline expired')
    return timeout
  }
  try {
    capture('before-projects')
    await page.getByRole('button', { name: /^Projects/ }).click({ timeout: remaining() })
    const refresh = page.getByRole('button', { name: 'Refresh sessions', exact: true })
    capture('before-refresh')
    await refresh.click({ timeout: remaining() })
    // Wait for refresh to finish before looking for the exact history row;
    // a visible Sidebar row cannot stand in for indexed history.
    await expect(refresh).toBeEnabled({ timeout: remaining() })
    // The actual indexed row owns its project group. A linked checkout can
    // group under its common repository while retaining a different cwd.
    const { indexed, facts } = await page.evaluate(observeManagedHistoryWindow, identity)
    try { observation?.window('indexed', facts) } catch { /* keep the exact indexed assertion */ }
    expect(indexed, 'exact provider/native root must have one indexed History group').toHaveLength(1)
    const checkout = indexed[0].checkoutPath ?? indexed[0].cwd
    if (checkout) expect(checkout, 'indexed host checkout must match the owned launch').toBe(identity.repoRoot)
    const project = page.locator('[data-context="history-project"][data-project-path=' + JSON.stringify(indexed[0].projectPath) + ']')
    await expect(project).toBeVisible({ timeout: remaining() })
    const history = page.locator('[data-context="history-session"][data-provider=' + JSON.stringify(identity.provider)
      + '][data-session-id=' + JSON.stringify(identity.nativeSessionId) + ']')
    if (!await history.isVisible()) {
      await project.click({ timeout: remaining() })
    }
    await expect(history).toBeVisible({ timeout: remaining() })
    await history.getByRole('button', { name: 'Open session', exact: true }).click({ timeout: remaining() })
    capture('complete')
  } catch (error) {
    capture('failed')
    throw error
  }
}

/** Split the observed fresh pane through the actual browser menu within one finite action budget. */
export async function splitFreshBrowserPane(page: Page, paneId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  const remaining = () => {
    const timeout = deadline - Date.now()
    if (timeout <= 0) throw new Error(`browser split deadline expired for pane ${paneId}`)
    return timeout
  }
  await page.locator('[data-context="pane-header"]').and(page.locator('[data-pane-id="' + paneId + '"]'))
    .click({ button: 'right', timeout: remaining() })
  await page.getByRole('menuitem', { name: 'Split right', exact: true }).click({ timeout: remaining() })
  await expect(page.getByRole('toolbar', { name: /pane type picker/i }).last()).toBeVisible({ timeout: remaining() })
}

export {
  P2_OPENCODE_VERSION, P2_OPENCODE_MODEL,
  type ManagedEnvironmentInputs,
  type ManagedRuntimeView, type ManagedOpenCodeAdoptionStatus,
  type ExactRuntimeHandle, type FixtureNativeState, type RuntimeHostFacts, type NativeToolEvidence,
  type SyntheticOpenCodeSourceFacts,
  type SyntheticStoppedRepairBatchFacts, type SyntheticStoppedRepairBatchObservation,
  type SyntheticStoppedRepairFault,
  type Phase3BrowserObservation,
  type RuntimeTerminalContinuityObservation,
  type OpencodeQualificationTurn, type OpencodeQualificationProofStage,
  type OpencodeReadinessDiagnostic,
  type FreshCodexHistoryMeasurementError, type FreshCodexHistoryMeasurementFinish,
  FreshCodexSavedHistoryMeasurementSchema, FreshCodexSavedHistoryPreservationSchema,
} from '../../../scripts/testing/runtime-sandbox.js'

/** The browser fixture supplies its owned web process to the shared owner. */
export class ManagedRuntimeBrowserRig extends ManagedRuntimeOwner {
  constructor(...args: ConstructorParameters<typeof ManagedRuntimeOwner> extends [unknown, ...infer Rest] ? Rest : never) {
    super((options) => new RustServer(options), ...args)
  }

  async start(): Promise<E2eServerInfo> {
    return super.start()
  }
}

export type ManagedFixtureRig = ManagedRuntimeBrowserRig | ExternalManagedRuntimeRig

export function createManagedRuntimeBrowserRig(...args: ConstructorParameters<typeof ManagedRuntimeBrowserRig>): ManagedFixtureRig {
  const descriptor = resolveManagedExternalDescriptor(process.env)
  if (!descriptor) return new ManagedRuntimeBrowserRig(...args)
  const configured = args[5] ?? { enabledProviders: ['opencode'] }
  return new ExternalManagedRuntimeRig(descriptor, fetch, {
    phase: args[1] ?? 2, enabledProviders: [...configured.enabledProviders],
    freshAgentModes: [...(configured.freshAgentModes ?? [])], fixtureFreshAgentModes: [...(configured.fixtureFreshAgentModes ?? [])],
  })
}

/** Remote setup reads private grants in its owner; local setup preserves the same validator. */
export function createManagedOpenCodeRuntimeBrowserRig(...args: ConstructorParameters<typeof ManagedRuntimeBrowserRig>): ManagedFixtureRig {
  if (resolveManagedExternalDescriptor(process.env)) return createManagedRuntimeBrowserRig(...args)
  const bootstrap = requireOpenCodeOnecliBootstrap(process.env,
    args[1] === 5 ? 'OpenCode provider qualification' : 'P2-G04')
  const configured: ConstructorParameters<typeof ManagedRuntimeBrowserRig> = [...args]
  configured[2] = { ...args[2], FRESHELL_BIND_HOST: '0.0.0.0',
    FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: bootstrap.authFile,
    FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: bootstrap.environmentFile,
    FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: bootstrap.caFile }
  return new ManagedRuntimeBrowserRig(...configured)
}

/** Observe the exact current address and revisions before sending the finite Stop request. */
export async function stopManagedRuntimeSoul(rig: ManagedFixtureRig, soulId: string) {
  const rows = (await rig.inventory()).filter(row => row.soulId === soulId && row.launchState !== 'stopped')
  if (rows.length !== 1) throw new Error('exact Stop soul is absent or ambiguous')
  const current = rows[0]
  return rig.stopRuntimeSoul(rig.exactRuntimeHandle(current), await rig.controlEpoch(), current.intentRevision)
}

/** Submit one Stop, then observe that same durable transaction before proof capture. */
export async function completeManagedRuntimeStop(rig: ManagedFixtureRig, soulId: string) {
  const rows = (await rig.inventory()).filter(row => row.soulId === soulId && row.launchState !== 'stopped')
  if (rows.length !== 1) throw new Error('exact Stop soul is absent or ambiguous')
  const current = rows[0], handle = rig.exactRuntimeHandle(current)
  const generation = current.executionGeneration
  if (generation === undefined || !Number.isSafeInteger(generation) || generation < 0) throw new Error('Stop execution generation is absent')
  const writerBeforeStop = await rig.writerClaimFacts(handle)
  if (writerBeforeStop.provider !== current.provider || !writerBeforeStop.providerStoreId
    || writerBeforeStop.soulId !== handle.soulId || writerBeforeStop.incarnationId !== handle.incarnationId
    || writerBeforeStop.nativeSessionId !== handle.nativeSessionId || writerBeforeStop.activeClaimCount !== 1
    || writerBeforeStop.globalConflictingClaimCount !== 0) throw new Error('Stop requires its exact current writer and store')
  const initial = await rig.stopRuntimeSoul(handle, await rig.controlEpoch(), current.intentRevision)
  if (initial.outcome === 'blocked_ownership') throw new Error('Stop ownership is blocked')
  const revision = initial.view.intentRevision
  if (revision !== current.intentRevision + 1 || initial.view.executionGeneration !== generation
    || (['soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const)
      .some(field => initial.view[field] !== handle[field]) || initial.view.desiredState !== 'stopped') {
    throw new Error('initial Stop reply differs from the captured transaction')
  }
  const deadline = Date.now() + 60_000
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Stop completion observation deadline expired')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Stop completion observation timed out')), remaining)
      })])
      if (Date.now() >= deadline) throw new Error('Stop completion observation deadline expired')
      return value
    } finally { clearTimeout(timer) }
  }
  for (;;) {
    const completion = await bounded(() => rig.stopCompletionFacts(handle, revision, generation))
    if (completion.providerStoreId !== writerBeforeStop.providerStoreId || completion.view.provider !== current.provider) {
      throw new Error('Stop completion provider store identity changed')
    }
    if (completion.outcome === 'blocked_ownership') throw new Error('Stop completion ownership is blocked')
    if (completion.settled) {
      if (completion.outcome !== 'verified_empty' || completion.revokePending
        || completion.view.launchState !== 'stopped' || completion.view.cleanupState !== 'verified_empty') {
        throw new Error('recorded Stop completion is inconsistent')
      }
      const claim = await bounded(() => rig.writerClaimFacts(handle))
      if (claim.soulId !== handle.soulId || claim.incarnationId !== handle.incarnationId
        || claim.nativeSessionId !== handle.nativeSessionId || claim.provider !== completion.view.provider
        || claim.providerStoreId !== completion.providerStoreId || claim.activeClaimCount !== 0 || claim.globalConflictingClaimCount !== 0) {
        throw new Error('Stop completion still has a current or conflicting writer')
      }
      const enclosure = await bounded(() => rig.ownedContainerState(rig.runtimeEnclosureHandle(completion.view)))
      if (enclosure.running) throw new Error('Stop completion enclosure is still running')
      return { initial, completion }
    }
    await bounded(() => new Promise<void>(resolve => setTimeout(resolve, 250)))
  }
}
