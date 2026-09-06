import {
  getCodexSurvivorAttachErrorCode,
  type CodexAppServerRuntime,
  type CodexSurvivorAttachErrorCode,
  type HeldCodexSidecarOwnership,
} from './runtime.js'
import type { CodexThreadLifecycleEvent, CodexThreadLifecycleLossEvent, CodexTurnEvent } from './client.js'
import type {
  CodexThreadTurnReadParams,
  CodexThreadTurnReadResult,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResult,
} from './protocol.js'
import { waitForAllSettledOrThrow } from '../../shutdown-join.js'
import { logger } from '../../logger.js'
import {
  CodexRemoteProxy,
  type CodexApprovalRequestEvent,
  type CodexRemoteProxyCandidate,
  type CodexRemoteProxyRepairTrigger,
} from './remote-proxy.js'

type CodexRuntimeLike = Pick<
  CodexAppServerRuntime,
  | 'ensureReady'
  | 'shutdown'
  | 'updateOwnershipMetadata'
  | 'onThreadLifecycleLoss'
  | 'onFsChanged'
  | 'watchPath'
  | 'unwatchPath'
  | 'readThreadTurn'
  | 'listThreadTurns'
  | 'attachToSurvivingSidecar'
>

/**
 * Restore-time survivor claim seam (kata 4g2a), implemented by CodexSidecarReconciler in
 * sidecar-reattach.ts. Declared structurally here: this module never imports the reconciler, so
 * the only import edges stay launch-planner.ts → runtime.ts and sidecar-reattach.ts → runtime.ts.
 */
export type CodexSidecarClaimSource = {
  claimForSession(sessionId: string): HeldCodexSidecarOwnership | null
  dropClaim(ownershipId: string): void
  settleFailedClaim(ownership: HeldCodexSidecarOwnership, code: CodexSurvivorAttachErrorCode): Promise<void>
}

export type CodexLaunchSidecar = {
  adopt(input: { terminalId: string; generation: number }): Promise<void>
  noteSessionId?(sessionId: string): Promise<void>
  markCandidatePersisted?(): void
  pauseCandidateCapture?(reason: string): void
  resumeCandidateCapture?(reason: string): void
  onCandidate?(handler: (candidate: CodexRemoteProxyCandidate) => void): () => void
  onTurnStarted?(handler: (event: CodexTurnEvent) => void): () => void
  onTurnCompleted?(handler: (event: CodexTurnEvent) => void): () => void
  onApprovalRequested?(handler: (event: CodexApprovalRequestEvent) => void): () => void
  onApprovalResolved?(handler: (event: { requestId: string }) => void): () => void
  onRepairTrigger?(handler: (event: CodexRemoteProxyRepairTrigger) => void): () => void
  onFsChanged?(handler: (event: { watchId: string; changedPaths: string[] }) => void): () => void
  onThreadLifecycle?(handler: (event: CodexThreadLifecycleEvent) => void): () => void
  onLifecycleLoss?(handler: (event: CodexThreadLifecycleLossEvent) => void): () => void
  listThreadTurns?(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResult>
  readThreadTurn?(params: CodexThreadTurnReadParams): Promise<CodexThreadTurnReadResult>
  watchPath?(targetPath: string, watchId: string): Promise<{ path: string }>
  unwatchPath?(watchId: string): Promise<void>
  shutdown(): Promise<void>
}

export type CodexLaunchPlan = {
  sessionId?: string
  remote: {
    wsUrl: string
  }
  sidecar: CodexLaunchSidecar
}

export type CodexSidecarTeardownError = Error & {
  codexSidecarTeardownFailed: true
}

type PlanCreateInput = {
  cwd?: string
  resumeSessionId?: string
  model?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: string
}

type CodexLaunchProxyOptions = {
  upstreamWsUrl: string
  requireCandidatePersistence?: boolean
}

type CodexLaunchProxy = Pick<
  CodexRemoteProxy,
  | 'start'
  | 'close'
  | 'markCandidatePersisted'
  | 'pauseCandidateCapture'
  | 'resumeCandidateCapture'
  | 'onCandidate'
  | 'onTurnStarted'
  | 'onTurnCompleted'
  | 'onApprovalRequested'
  | 'onApprovalResolved'
  | 'onRepairTrigger'
  | 'onThreadLifecycle'
  | 'onLifecycleLoss'
>

type CodexLaunchPlannerOptions = {
  proxyFactory?: (options: CodexLaunchProxyOptions) => CodexLaunchProxy
  reconciler?: CodexSidecarClaimSource
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codexSidecarTeardownError(message: string, cause: unknown): CodexSidecarTeardownError {
  const error = new Error(message) as CodexSidecarTeardownError
  error.codexSidecarTeardownFailed = true
  error.cause = cause
  return error
}

export function isCodexSidecarTeardownError(error: unknown): error is CodexSidecarTeardownError {
  return (error as { codexSidecarTeardownFailed?: boolean } | null | undefined)?.codexSidecarTeardownFailed === true
}

export class CodexLaunchPlanner {
  private readonly activeSidecars = new Set<CodexLaunchSidecar>()
  private readonly failedSidecarShutdowns = new Set<CodexLaunchSidecar>()
  private readonly runtimeFactory: () => CodexRuntimeLike
  private readonly proxyFactory: (options: CodexLaunchProxyOptions) => CodexLaunchProxy
  private readonly reconciler?: CodexSidecarClaimSource
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | null = null

  constructor(
    runtimeOrFactory: CodexRuntimeLike | (() => CodexRuntimeLike),
    options: CodexLaunchPlannerOptions = {},
  ) {
    this.runtimeFactory = typeof runtimeOrFactory === 'function'
      ? runtimeOrFactory
      : () => runtimeOrFactory
    this.proxyFactory = options.proxyFactory ?? ((proxyOptions) => new CodexRemoteProxy(proxyOptions))
    this.reconciler = options.reconciler
  }

  async planCreate(input: PlanCreateInput): Promise<CodexLaunchPlan> {
    this.assertAcceptingPlans()
    await this.retryFailedSidecarShutdownsBeforePlan()
    this.assertAcceptingPlans()

    if (input.resumeSessionId) {
      const claimedPlan = await this.tryPlanSurvivorClaim(input)
      if (claimedPlan) return claimedPlan
    }

    const runtime = this.runtimeFactory()
    let proxy: CodexLaunchProxy | undefined
    const sidecar = this.createSidecar(runtime, () => proxy)
    this.activeSidecars.add(sidecar)

    try {
      if (input.resumeSessionId) {
        const ready = await runtime.ensureReady(input.cwd)
        await runtime.updateOwnershipMetadata({ sessionId: input.resumeSessionId }).catch((error) => {
          // Stamp loss must never break a working resume; it only forfeits this
          // sidecar as a future restore claim candidate.
          logger.warn({ err: error }, 'Codex sidecar ownership session stamp failed; restore-claim for this sidecar is degraded')
        })
        proxy = this.proxyFactory({
          upstreamWsUrl: ready.wsUrl,
          requireCandidatePersistence: false,
        })
        const proxyReady = await proxy.start()
        this.assertAcceptingPlans()
        return {
          sessionId: input.resumeSessionId,
          remote: {
            wsUrl: proxyReady.wsUrl,
          },
          sidecar,
        }
      }

      const ready = await runtime.ensureReady(input.cwd)
      proxy = this.proxyFactory({ upstreamWsUrl: ready.wsUrl })
      const proxyReady = await proxy.start()
      this.assertAcceptingPlans()

      return {
        remote: {
          wsUrl: proxyReady.wsUrl,
        },
        sidecar,
      }
    } catch (error) {
      try {
        await sidecar.shutdown()
      } catch (shutdownError) {
        throw codexSidecarTeardownError(
          `Codex launch sidecar teardown failed after planning error: ${errorMessage(shutdownError)}`,
          shutdownError,
        )
      }
      throw error
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownStarted = true
    if (this.shutdownPromise) {
      await this.shutdownPromise
      return
    }
    const attempt = waitForAllSettledOrThrow(
      [...this.activeSidecars].map((sidecar) => Promise.resolve().then(() => sidecar.shutdown())),
      'Codex launch planner shutdown failed.',
    )
    this.shutdownPromise = attempt
    try {
      await attempt
    } finally {
      if (this.shutdownPromise === attempt) {
        this.shutdownPromise = null
      }
    }
  }

  private assertAcceptingPlans(): void {
    if (this.shutdownStarted) {
      throw new Error('Codex launch planner is shutting down; new Codex launch plans are not accepted.')
    }
  }

  /**
   * Restore-time survivor claim seam (kata 4g2a da92 parity): a resume-keyed plan claims a
   * verified prior-generation sidecar held by the boot reconciler before falling back to the
   * spawn path. Returns null when no reconciler is installed or no claim can produce a plan, so
   * the caller spawns fresh (Task 1 then stamps the resume session id onto the new record).
   * Coded attach failures settle back through the reconciler and advance to the next candidate;
   * uncoded errors (e.g. proxy start or planner shutdown raced the attach) run the same
   * ownership-gated teardown contract as planCreate's catch and rethrow unchanged.
   */
  private async tryPlanSurvivorClaim(input: PlanCreateInput): Promise<CodexLaunchPlan | null> {
    const sessionId = input.resumeSessionId
    const reconciler = this.reconciler
    if (!sessionId || !reconciler) return null

    // One candidate at a time through claimForSession; an empty claim returns null so the caller
    // falls through to the spawn path unchanged.
    for (;;) {
      const candidate = reconciler.claimForSession(sessionId)
      if (!candidate) return null

      const candidateRuntime = this.runtimeFactory()
      let candidateProxy: CodexLaunchProxy | undefined
      const candidateSidecar = this.createSidecar(candidateRuntime, () => candidateProxy)
      try {
        const attached = await candidateRuntime.attachToSurvivingSidecar(candidate, { sessionId })
        candidateProxy = this.proxyFactory({
          upstreamWsUrl: attached.wsUrl,
          requireCandidatePersistence: false,
        })
        const proxyReady = await candidateProxy.start()
        this.assertAcceptingPlans()
        this.activeSidecars.add(candidateSidecar)
        reconciler.dropClaim(candidate.metadata.ownershipId)
        logger.info(
          { ownershipId: candidate.metadata.ownershipId, sessionId, wsUrl: attached.wsUrl },
          'Codex restore claimed a surviving sidecar',
        )
        return {
          sessionId,
          remote: {
            wsUrl: proxyReady.wsUrl,
          },
          sidecar: candidateSidecar,
        }
      } catch (error) {
        const code = getCodexSurvivorAttachErrorCode(error)
        if (code) {
          // Coded survivor failure: the candidate runtime is provably inert
          // (attachToSurvivingSidecar throws before any retitle/ready-state mutation and closes
          // its own client), so the sidecar never enters activeSidecars and needs no shutdown —
          // settling the claim with the reconciler owns the survivor's fate.
          await candidateProxy?.close()
          await reconciler.settleFailedClaim(candidate, code)
          logger.warn(
            { err: error, ownershipId: candidate.metadata.ownershipId, sessionId, code },
            'Codex survivor claim failed; trying the next candidate or falling back to a fresh spawn',
          )
          continue
        }
        // Uncoded failure (e.g. proxy start or planner shutdown raced the attach): the candidate
        // is consumed-then-unowned. Drop the claim, run the existing catch path's ownership-gated
        // teardown of whatever the runtime built/attached, and rethrow the original error so
        // planCodexLaunchWithRetry's fresh-spawn semantics stay unchanged. The candidate enters
        // activeSidecars BEFORE the teardown attempt (review F1): a failed shutdown lands in
        // failedSidecarShutdowns, which retryFailedSidecarShutdownsBeforePlan only retries for
        // sidecars that remain planner-owned — the spawn-path catch relies on the same ordering.
        // A successful shutdown self-removes from both sets.
        reconciler.dropClaim(candidate.metadata.ownershipId)
        this.activeSidecars.add(candidateSidecar)
        try {
          await candidateSidecar.shutdown()
        } catch (shutdownError) {
          throw codexSidecarTeardownError(
            `Codex launch sidecar teardown failed after planning error: ${errorMessage(shutdownError)}`,
            shutdownError,
          )
        }
        throw error
      }
    }
  }

  private async retryFailedSidecarShutdownsBeforePlan(): Promise<void> {
    const failedSidecars = [...this.failedSidecarShutdowns]
      .filter((sidecar) => this.activeSidecars.has(sidecar))
    if (failedSidecars.length === 0) return

    try {
      await waitForAllSettledOrThrow(
        failedSidecars.map((sidecar) => sidecar.shutdown()),
        'Codex launch planner failed to clear blocked sidecar shutdowns.',
      )
    } catch (error) {
      throw codexSidecarTeardownError(
        `Codex launch planner cannot create a new plan while sidecar teardown is blocked: ${errorMessage(error)}`,
        error,
      )
    }
  }

  private createSidecar(runtime: CodexRuntimeLike, getProxy: () => CodexLaunchProxy | undefined): CodexLaunchSidecar {
    let shutdownPromise: Promise<void> | null = null
    let shutdownAttemptStarted = false
    let shutdownSucceeded = false
    const assertAdoptable = () => {
      if (this.shutdownStarted || shutdownAttemptStarted) {
        throw new Error('Codex launch sidecar is shutting down; it cannot be adopted.')
      }
    }
    const assertActive = () => {
      if (this.shutdownStarted || shutdownAttemptStarted) {
        throw new Error('Codex launch sidecar is shutting down; remote operations stopped.')
      }
    }
    const sidecar: CodexLaunchSidecar = {
      adopt: async ({ terminalId, generation }) => {
        assertAdoptable()
        await runtime.updateOwnershipMetadata({ terminalId, generation })
        assertAdoptable()
        this.activeSidecars.delete(sidecar)
        this.failedSidecarShutdowns.delete(sidecar)
      },
      noteSessionId: async (sessionId) => {
        await runtime.updateOwnershipMetadata({ sessionId })
      },
      markCandidatePersisted: () => getProxy()?.markCandidatePersisted(),
      pauseCandidateCapture: (reason) => getProxy()?.pauseCandidateCapture(reason),
      resumeCandidateCapture: (reason) => getProxy()?.resumeCandidateCapture(reason),
      onCandidate: (handler) => getProxy()?.onCandidate(handler) ?? (() => undefined),
      onTurnStarted: (handler) => getProxy()?.onTurnStarted(handler) ?? (() => undefined),
      onTurnCompleted: (handler) => getProxy()?.onTurnCompleted(handler) ?? (() => undefined),
      onApprovalRequested: (handler) => getProxy()?.onApprovalRequested(handler) ?? (() => undefined),
      onApprovalResolved: (handler) => getProxy()?.onApprovalResolved(handler) ?? (() => undefined),
      onRepairTrigger: (handler) => getProxy()?.onRepairTrigger(handler) ?? (() => undefined),
      onFsChanged: (handler) => runtime.onFsChanged(handler),
      onThreadLifecycle: (handler) => getProxy()?.onThreadLifecycle(handler) ?? (() => undefined),
      onLifecycleLoss: (handler) => {
        const unsubRuntime = runtime.onThreadLifecycleLoss(handler)
        const unsubProxy = getProxy()?.onLifecycleLoss(handler)
        return () => {
          unsubRuntime()
          unsubProxy?.()
        }
      },
      readThreadTurn: (params) => {
        assertActive()
        return runtime.readThreadTurn(params)
      },
      listThreadTurns: (params) => {
        assertActive()
        return runtime.listThreadTurns(params)
      },
      watchPath: async (targetPath, watchId) => {
        assertActive()
        const result = await runtime.watchPath(targetPath, watchId)
        assertActive()
        return result
      },
      unwatchPath: async (watchId) => {
        assertActive()
        await runtime.unwatchPath(watchId)
        assertActive()
      },
      shutdown: async () => {
        if (shutdownSucceeded) return
        if (shutdownPromise) {
          await shutdownPromise
          return
        }
        if (!shutdownAttemptStarted) {
          shutdownAttemptStarted = true
        }
        const attempt = Promise.resolve()
          .then(() => {
            const proxy = getProxy()
            return waitForAllSettledOrThrow([
              ...(proxy ? [proxy.close()] : []),
              runtime.shutdown(),
            ], 'Codex launch sidecar shutdown failed.')
          })
          .then(() => {
            shutdownSucceeded = true
            this.activeSidecars.delete(sidecar)
            this.failedSidecarShutdowns.delete(sidecar)
          })
          .catch((error) => {
            this.failedSidecarShutdowns.add(sidecar)
            throw error
          })
        shutdownPromise = attempt
        try {
          await attempt
        } finally {
          if (shutdownPromise === attempt) {
            shutdownPromise = null
          }
        }
      },
    }
    return sidecar
  }
}
