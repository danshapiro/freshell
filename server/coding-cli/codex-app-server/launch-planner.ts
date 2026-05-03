import type { CodexAppServerRuntime } from './runtime.js'

export type CodexLaunchPlan = {
  sessionId: string
  remote: {
    wsUrl: string
  }
}

type PlanCreateInput = {
  cwd?: string
  resumeSessionId?: string
  model?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: string
}

export class CodexLaunchPlanner {
  constructor(
    private readonly runtime: Pick<CodexAppServerRuntime, 'ensureReady' | 'startThread'>,
  ) {}

  async planCreate(input: PlanCreateInput): Promise<CodexLaunchPlan> {
    if (input.resumeSessionId) {
      const ready = await this.runtime.ensureReady()
      return {
        sessionId: input.resumeSessionId,
        remote: {
          wsUrl: ready.wsUrl,
        },
      }
    }

    const planResult = await this.runtime.startThread({
        cwd: input.cwd,
        model: input.model,
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
      })

    return {
      sessionId: planResult.threadId,
      remote: {
        wsUrl: planResult.wsUrl,
      },
    }
  }
}
