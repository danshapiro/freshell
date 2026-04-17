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
    private readonly runtime: Pick<CodexAppServerRuntime, 'ensureReady' | 'startThread' | 'resumeThread'>,
  ) {}

  async planCreate(input: PlanCreateInput): Promise<CodexLaunchPlan> {
    const ready = await this.runtime.ensureReady()
    const sessionId = input.resumeSessionId
      ? (await this.runtime.resumeThread({
          threadId: input.resumeSessionId,
          cwd: input.cwd,
          model: input.model,
          sandbox: input.sandbox,
          approvalPolicy: input.approvalPolicy,
        })).threadId
      : (await this.runtime.startThread({
          cwd: input.cwd,
          model: input.model,
          sandbox: input.sandbox,
          approvalPolicy: input.approvalPolicy,
        })).threadId

    return {
      sessionId,
      remote: {
        wsUrl: ready.wsUrl,
      },
    }
  }
}
