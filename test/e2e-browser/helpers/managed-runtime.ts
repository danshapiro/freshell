import { ManagedRuntimeOwner, requireOpenCodeOnecliBootstrap } from '../../../scripts/testing/runtime-sandbox.js'
import { RustServer } from './rust-server.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import { resolveManagedExternalDescriptor } from '../../../scripts/testing/runtime-external-browser.js'
import { ExternalManagedRuntimeRig } from './external-managed-runtime.js'

export {
  P2_OPENCODE_VERSION, P2_OPENCODE_MODEL,
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
