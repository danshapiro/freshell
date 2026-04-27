export type CodexRecoveryState =
  | 'starting'
  | 'running_live_only'
  | 'running_durable'
  | 'recovering_pre_durable'
  | 'recovering_durable'
  | 'recovery_failed'

export type CodexWorkerCloseReason =
  | 'spontaneous_worker_failure'
  | 'recovery_retire'
  | 'user_final_close'

export type CodexWorkerFailureSource =
  | 'pty_exit'
  | 'sidecar_fatal'
  | 'app_server_exit'
  | 'app_server_client_disconnect'
  | 'remote_tui_fatal_output'
  | 'provider_thread_lifecycle_loss'
  | 'readiness_timeout'
  | 'replacement_launch_failure'
  | 'replacement_spawn_failure'

export type CodexRecoveryAttemptResult =
  | { ok: true; attempt: number; delayMs: number }
  | { ok: false; reason: 'exhausted' }

export type CodexRecoveryInputBufferResult =
  | { ok: true }
  | { ok: false; reason: 'overflow' | 'expired' }

export type CodexRecoveryInputDrainResult =
  | { ok: true; data: string }
  | { ok: false; reason: 'empty' | 'expired' }

const RETRY_DELAYS_MS = [0, 250, 1000, 2000, 5000] as const
const STABLE_RESET_MS = 10 * 60 * 1000
const INPUT_BUFFER_MAX_BYTES = 8 * 1024
const INPUT_BUFFER_TTL_MS = 10 * 1000

type CodexRecoveryPolicyOptions = {
  now?: () => number
}

export class CodexRecoveryPolicy {
  private readonly now: () => number
  private attemptsUsed = 0
  private stableSince: number | undefined
  private bufferedInput = ''
  private bufferedInputStartedAt: number | undefined

  constructor(options: CodexRecoveryPolicyOptions = {}) {
    this.now = options.now ?? Date.now
  }

  nextAttempt(): CodexRecoveryAttemptResult {
    this.resetIfStableWindowElapsed()
    this.stableSince = undefined

    if (this.attemptsUsed >= RETRY_DELAYS_MS.length) {
      return { ok: false, reason: 'exhausted' }
    }

    const attempt = this.attemptsUsed + 1
    const delayMs = RETRY_DELAYS_MS[this.attemptsUsed]
    this.attemptsUsed = attempt
    return { ok: true, attempt, delayMs }
  }

  markStableRunning(): void {
    this.stableSince = this.now()
  }

  noteRecoveryRetireCallback(): void {
    // Retire cleanup callbacks are expected and must not affect retry budget.
  }

  reset(): void {
    this.attemptsUsed = 0
    this.stableSince = undefined
    this.clearBufferedInput()
  }

  bufferInput(data: string): CodexRecoveryInputBufferResult {
    const expired = this.isBufferedInputExpired()
    if (expired) {
      this.clearBufferedInput()
      return { ok: false, reason: 'expired' }
    }

    const nextBytes = Buffer.byteLength(this.bufferedInput + data, 'utf8')
    if (nextBytes > INPUT_BUFFER_MAX_BYTES) {
      this.clearBufferedInput()
      return { ok: false, reason: 'overflow' }
    }

    if (this.bufferedInputStartedAt === undefined) {
      this.bufferedInputStartedAt = this.now()
    }
    this.bufferedInput += data
    return { ok: true }
  }

  drainBufferedInput(): CodexRecoveryInputDrainResult {
    if (!this.bufferedInput) {
      this.clearBufferedInput()
      return { ok: false, reason: 'empty' }
    }
    if (this.isBufferedInputExpired()) {
      this.clearBufferedInput()
      return { ok: false, reason: 'expired' }
    }
    const data = this.bufferedInput
    this.clearBufferedInput()
    return { ok: true, data }
  }

  clearBufferedInput(): void {
    this.bufferedInput = ''
    this.bufferedInputStartedAt = undefined
  }

  private resetIfStableWindowElapsed(): void {
    if (this.stableSince === undefined) {
      return
    }
    if (this.now() - this.stableSince >= STABLE_RESET_MS) {
      this.attemptsUsed = 0
      this.stableSince = undefined
    }
  }

  private isBufferedInputExpired(): boolean {
    return this.bufferedInputStartedAt !== undefined
      && this.now() - this.bufferedInputStartedAt > INPUT_BUFFER_TTL_MS
  }
}

export const CODEX_RECOVERY_INPUT_BUFFER_MAX_BYTES = INPUT_BUFFER_MAX_BYTES
export const CODEX_RECOVERY_INPUT_BUFFER_TTL_MS = INPUT_BUFFER_TTL_MS
export const CODEX_RECOVERY_STABLE_RESET_MS = STABLE_RESET_MS
export const CODEX_RECOVERY_RETRY_DELAYS_MS = RETRY_DELAYS_MS
