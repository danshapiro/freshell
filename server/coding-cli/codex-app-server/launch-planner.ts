import type { CodexAppServerRuntime } from './runtime.js'
import type { CodexThreadLifecycleEvent, CodexThreadLifecycleLossEvent, CodexTurnEvent } from './client.js'
import type {
  CodexThreadTurnReadParams,
  CodexThreadTurnReadResult,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResult,
} from './protocol.js'
import { waitForAllSettledOrThrow } from '../../shutdown-join.js'
import {
  CodexRemoteProxy,
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
>

export type CodexLaunchSidecar = {
  adopt(input: { terminalId: string; generation: number }): Promise<void>
  markCandidatePersisted?(): void
  onCandidate?(handler: (candidate: CodexRemoteProxyCandidate) => void): () => void
  onTurnStarted?(handler: (event: CodexTurnEvent) => void): () => void
  onTurnCompleted?(handler: (event: CodexTurnEvent) => void): () => void
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
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | null = null

  constructor(runtimeOrFactory: CodexRuntimeLike | (() => CodexRuntimeLike)) {
    this.runtimeFactory = typeof runtimeOrFactory === 'function'
      ? runtimeOrFactory
      : () => runtimeOrFactory
  }

  async planCreate(input: PlanCreateInput): Promise<CodexLaunchPlan> {
    this.assertAcceptingPlans()
    await this.retryFailedSidecarShutdownsBeforePlan()
    this.assertAcceptingPlans()

    const runtime = this.runtimeFactory()
    let proxy: CodexRemoteProxy | undefined
    const sidecar = this.createSidecar(runtime, () => proxy)
    this.activeSidecars.add(sidecar)

    try {
      if (input.resumeSessionId) {
        const ready = await runtime.ensureReady(input.cwd)
        proxy = new CodexRemoteProxy({
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
      proxy = new CodexRemoteProxy({ upstreamWsUrl: ready.wsUrl })
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

  private createSidecar(runtime: CodexRuntimeLike, getProxy: () => CodexRemoteProxy | undefined): CodexLaunchSidecar {
    let shutdownPromise: Promise<void> | null = null
    let shutdownAttemptStarted = false
    let shutdownSucceeded = false
    let notifyShutdownStarted!: () => void
    const shutdownStarted = new Promise<void>((resolve) => {
      notifyShutdownStarted = resolve
    })
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
      markCandidatePersisted: () => getProxy()?.markCandidatePersisted(),
      onCandidate: (handler) => getProxy()?.onCandidate(handler) ?? (() => undefined),
      onTurnStarted: (handler) => getProxy()?.onTurnStarted(handler) ?? (() => undefined),
      onTurnCompleted: (handler) => getProxy()?.onTurnCompleted(handler) ?? (() => undefined),
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
          notifyShutdownStarted()
        }
        const attempt = Promise.resolve()
          .then(async () => {
            await getProxy()?.close()
            await runtime.shutdown()
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
