import type { CodexAppServerRuntime } from './runtime.js'
import type { CodexThreadLifecycleLossEvent } from './client.js'
import { waitForAllSettledOrThrow } from '../../shutdown-join.js'

type CodexRuntimeLike = Pick<
  CodexAppServerRuntime,
  'ensureReady' | 'startThread' | 'listLoadedThreads' | 'shutdown' | 'updateOwnershipMetadata' | 'onThreadLifecycleLoss'
>

export type CodexLaunchSidecar = {
  adopt(input: { terminalId: string; generation: number }): Promise<void>
  listLoadedThreads(): Promise<string[]>
  onLifecycleLoss?(handler: (event: CodexThreadLifecycleLossEvent) => void): () => void
  shutdown(): Promise<void>
  waitForLoadedThread(threadId: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<void>
}

export type CodexLaunchPlan = {
  sessionId: string
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
    const sidecar = this.createSidecar(runtime)
    this.activeSidecars.add(sidecar)

    try {
      if (input.resumeSessionId) {
        const ready = await runtime.ensureReady()
        this.assertAcceptingPlans()
        return {
          sessionId: input.resumeSessionId,
          remote: {
            wsUrl: ready.wsUrl,
          },
          sidecar,
        }
      }

      const planResult = await runtime.startThread({
        cwd: input.cwd,
        model: input.model,
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
      })
      this.assertAcceptingPlans()

      return {
        sessionId: planResult.threadId,
        remote: {
          wsUrl: planResult.wsUrl,
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

  private createSidecar(runtime: CodexRuntimeLike): CodexLaunchSidecar {
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
    const assertReadable = () => {
      if (this.shutdownStarted || shutdownAttemptStarted) {
        throw new Error('Codex launch sidecar is shutting down; loaded-thread readiness polling stopped.')
      }
    }
    const waitForNextPoll = async (pollMs: number) => {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, pollMs)),
        shutdownStarted,
      ])
      assertReadable()
    }
    const sidecar: CodexLaunchSidecar = {
      adopt: async ({ terminalId, generation }) => {
        assertAdoptable()
        await runtime.updateOwnershipMetadata({ terminalId, generation })
        assertAdoptable()
        this.activeSidecars.delete(sidecar)
        this.failedSidecarShutdowns.delete(sidecar)
      },
      listLoadedThreads: async () => {
        assertReadable()
        const loaded = await runtime.listLoadedThreads()
        assertReadable()
        return loaded
      },
      onLifecycleLoss: (handler) => runtime.onThreadLifecycleLoss(handler),
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
          .then(() => runtime.shutdown())
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
      waitForLoadedThread: async (threadId, options = {}) => {
        const timeoutMs = options.timeoutMs ?? 10_000
        const pollMs = options.pollMs ?? 100
        const deadline = Date.now() + timeoutMs

        while (Date.now() < deadline) {
          const loaded = await sidecar.listLoadedThreads()
          if (loaded.includes(threadId)) return
          await waitForNextPoll(pollMs)
        }

        throw new Error(`Codex app-server did not load thread ${threadId} within ${timeoutMs}ms.`)
      },
    }
    return sidecar
  }
}
