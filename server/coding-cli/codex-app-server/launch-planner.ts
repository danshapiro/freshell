import { CodexTerminalSidecar } from './sidecar.js'
import { generateMcpInjection } from '../../mcp/config-writer.js'
import type { TerminalEnvContext } from '../../terminal-registry.js'

export type CodexLaunchPlan = {
  sessionId?: string
  remote: {
    wsUrl: string
    processPid?: number
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

export type CodexLaunchFactoryInput = {
  terminalId: string
  cwd?: string
  envContext?: TerminalEnvContext
  resumeSessionId?: string
  providerSettings?: {
    model?: string
    sandbox?: string
    permissionMode?: string
  }
}

export type CodexLaunchFactory = (input: CodexLaunchFactoryInput) => Promise<CodexLaunchPlan>

type CodexLaunchRetryOptions = {
  onFailedAttempt?: (input: { attempt: number; delayMs: number; error: Error }) => void
  shouldRetry?: (error: Error) => boolean
}

const INITIAL_LAUNCH_RETRY_DELAYS_MS = [0, 250, 1000, 2000, 5000] as const

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runCodexLaunchWithRetry<T>(
  launch: (attempt: number) => Promise<T>,
  options: CodexLaunchRetryOptions = {},
): Promise<T> {
  let lastError: Error | undefined

  for (let index = 0; index < INITIAL_LAUNCH_RETRY_DELAYS_MS.length; index += 1) {
    const attempt = index + 1
    const delayMs = INITIAL_LAUNCH_RETRY_DELAYS_MS[index]
    if (delayMs > 0) {
      await sleep(delayMs)
    }
    try {
      return await launch(attempt)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (options.shouldRetry && !options.shouldRetry(lastError)) {
        throw lastError
      }
      if (attempt < INITIAL_LAUNCH_RETRY_DELAYS_MS.length) {
        options.onFailedAttempt?.({ attempt, delayMs: INITIAL_LAUNCH_RETRY_DELAYS_MS[index + 1], error: lastError })
      }
    }
  }

  throw lastError ?? new Error('Codex launch failed before a terminal record could be created.')
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
    let ready: Awaited<ReturnType<typeof sidecar.ensureReady>>
    try {
      ready = await sidecar.ensureReady()
    } catch (error) {
      await sidecar.shutdown().catch(() => undefined)
      throw error
    }

    if (input.resumeSessionId) {
      return {
        sessionId: input.resumeSessionId,
        remote: {
          wsUrl: ready.wsUrl,
          processPid: ready.processPid,
        },
        sidecar,
      }
    }

    return {
      remote: {
        wsUrl: ready.wsUrl,
        processPid: ready.processPid,
      },
      sidecar,
    }
  }
}
