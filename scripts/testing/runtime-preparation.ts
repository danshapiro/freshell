import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

export const RUNTIME_PREPARATION_TIMEOUT_MS = 45 * 60_000

export type RuntimePreparationPolicy = {
  /** One total budget for this rig's source builds and run-owned copies. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** Required source work owned by one RuntimeHarness.prepare invocation. */
export class RuntimePreparation {
  private readonly controller = new AbortController()
  private readonly deadline: number
  private readonly timer: NodeJS.Timeout
  private readonly onCancel: () => void

  constructor(private readonly policy: RuntimePreparationPolicy = {}) {
    const timeoutMs = policy.timeoutMs ?? RUNTIME_PREPARATION_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('preparation budget must be positive')
    this.deadline = performance.now() + timeoutMs
    this.timer = setTimeout(() => this.controller.abort(new Error(`runtime preparation exceeded ${timeoutMs}ms deadline`)), timeoutMs)
    this.onCancel = () => this.controller.abort(policy.signal?.reason ?? new Error('runtime preparation cancelled'))
    policy.signal?.addEventListener('abort', this.onCancel, { once: true })
    if (policy.signal?.aborted) this.onCancel()
  }

  check(): void {
    this.controller.signal.throwIfAborted()
    if (performance.now() >= this.deadline) throw new Error('runtime preparation exceeded its deadline')
  }

  async run(command: string, args: string[], options: { cwd?: string; inherit?: boolean } = {}): Promise<string> {
    this.check()
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let output = ''
    let failure: unknown
    const stopOwnedCommand = () => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const cancel = () => {
      failure = this.controller.signal.reason
      try { stopOwnedCommand() } catch (error) { failure = error }
    }
    this.controller.signal.addEventListener('abort', cancel, { once: true })
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { process.stderr.write(chunk) })
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      if (failure || code !== 0) {
        // A failed command may exit while one of its compiler/build children
        // remains alive. Settle that exact spawned group before rig cleanup.
        stopOwnedCommand()
        if (child.pid && process.platform !== 'win32') {
          await this.waitForCommandGroupExit(child.pid)
        }
      }
      if (failure) throw failure
      this.check()
      if (code !== 0) throw new Error(`runtime preparation command failed (${code}): ${command} ${args.join(' ')}`)
      return output
    } finally {
      this.controller.signal.removeEventListener('abort', cancel)
    }
  }

  private async waitForCommandGroupExit(pid: number): Promise<void> {
    const cleanupDeadline = performance.now() + 2000
    for (;;) {
      try { process.kill(-pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw error
      }
      if (performance.now() >= cleanupDeadline) throw new Error(`preparation command group ${pid} did not exit after cancellation`)
      await delay(10)
    }
  }

  async copy(source: string, target: string): Promise<void> {
    this.check()
    await fs.copyFile(source, target)
    await fs.chmod(target, 0o755)
    this.check()
  }

  close(): void {
    clearTimeout(this.timer)
    this.policy.signal?.removeEventListener('abort', this.onCancel)
  }
}
