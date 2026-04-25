import { CodexTerminalSidecar } from './sidecar.js'
import { generateMcpInjection } from '../../mcp/config-writer.js'

export type CodexLaunchPlan = {
  sessionId?: string
  remote: {
    wsUrl: string
  }
  sidecar: Pick<CodexTerminalSidecar, 'attachTerminal' | 'shutdown'>
}

type PlanCreateInput = {
  cwd?: string
  terminalId: string
  env: NodeJS.ProcessEnv
  resumeSessionId?: string
  model?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: string
}

type SidecarCreateInput = PlanCreateInput & {
  commandArgs: string[]
}

function appServerMcpTarget(): 'unix' | 'windows' {
  return process.platform === 'win32' ? 'windows' : 'unix'
}

export class CodexLaunchPlanner {
  constructor(
    private readonly createSidecar: (input: SidecarCreateInput) => Pick<CodexTerminalSidecar, 'ensureReady' | 'attachTerminal' | 'shutdown'>
      = (input) => new CodexTerminalSidecar({
        cwd: input.cwd,
        commandArgs: input.commandArgs,
        env: input.env,
      }),
  ) {}

  async planCreate(input: PlanCreateInput): Promise<CodexLaunchPlan> {
    const sidecar = this.createSidecar({
      ...input,
      commandArgs: generateMcpInjection('codex', input.terminalId, input.cwd, appServerMcpTarget()).args,
    })
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
