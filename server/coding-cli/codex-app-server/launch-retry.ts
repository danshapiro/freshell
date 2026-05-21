import { setTimeout as delay } from 'node:timers/promises'
import { CodexLaunchConfigError } from '../codex-launch-config.js'
import type { CodexLaunchPlan, CodexLaunchPlanner } from './launch-planner.js'

export const CODEX_INITIAL_LAUNCH_ATTEMPTS = 5
const CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS = 100

type CodexLaunchRetryLogger = {
  warn: (fields: Record<string, unknown>, message: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function planCodexLaunchWithRetry({
  planner,
  input,
  attempts = CODEX_INITIAL_LAUNCH_ATTEMPTS,
  retryDelayMs = CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
  logger,
}: {
  planner: CodexLaunchPlanner
  input: Parameters<CodexLaunchPlanner['planCreate']>[0]
  attempts?: number
  retryDelayMs?: number
  logger?: CodexLaunchRetryLogger
}): Promise<CodexLaunchPlan> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await planner.planCreate(input)
    } catch (error) {
      lastError = error
      if (error instanceof CodexLaunchConfigError || attempt >= attempts) break

      const delayMs = retryDelayMs * attempt
      logger?.warn({
        err: error,
        attempt,
        attempts,
        delayMs,
        cwd: input.cwd,
        hasResumeSessionId: Boolean(input.resumeSessionId),
      }, 'Codex launch planning failed; retrying')
      await delay(delayMs)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError))
}
