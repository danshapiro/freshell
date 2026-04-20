import { CodexTerminalSidecar } from './sidecar.js'

export type CodexLaunchPlan = {
  sessionId?: string
  remote: {
    wsUrl: string
  }
  sidecar: Pick<CodexTerminalSidecar, 'attachTerminal' | 'shutdown'>
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
    private readonly createSidecar: () => Pick<CodexTerminalSidecar, 'ensureReady' | 'attachTerminal' | 'shutdown'>
      = () => new CodexTerminalSidecar(),
  ) {}

  async planCreate(input: PlanCreateInput): Promise<CodexLaunchPlan> {
    const sidecar = this.createSidecar()
    const ready = await sidecar.ensureReady()

    if (input.resumeSessionId) {
      return {
        sessionId: input.resumeSessionId,
        remote: {
          wsUrl: ready.wsUrl,
        },
        sidecar,
      }
    }

    return {
      remote: {
        wsUrl: ready.wsUrl,
      },
      sidecar,
    }
  }
}
