import net from 'node:net'

export interface OwnedServerReceipt {
  pid: number
  port: number
  /** Stable platform identity captured with the PID when the fixture starts. */
  identity?: string
}

export interface OwnedServerStopObservation {
  pid: number
  port: number
  host: '127.0.0.1'
  stop?: 'fulfilled' | 'rejected'
  pidGone?: boolean | 'probe-error'
  portBindable?: boolean | 'probe-error'
}

export interface OwnedServerHandle {
  stop(): Promise<void>
}

export interface OwnedServerTeardownProbes {
  waitForPidGone(pid: number): Promise<boolean>
  isPortFree(port: number): Promise<boolean>
}

/** An exact PID captured and ownership-proved by the fixture. */
export interface ExactOwnedServerProcess {
  pid: number
  isAlive(): boolean
  signal(signal: NodeJS.Signals): boolean
}

export interface OwnershipProofContext {
  /** Cancels I/O when this one ownership observation reaches its deadline. */
  signal: AbortSignal
  /** Absolute deadline (milliseconds since epoch) for the cooperative probe. */
  deadline: number
}

export interface ForcedOwnedServerTeardownProbes extends OwnedServerTeardownProbes {
  /**
   * Proves that the PID is still this fixture's Rust child immediately before
   * any signal is sent. A failed proof deliberately prevents signaling it.
   */
  proveOwnership(receipt: OwnedServerReceipt, context: OwnershipProofContext): Promise<void>
  sleep(ms: number): Promise<void>
  /** Bounds each cooperative ownership observation, including external I/O. */
  ownershipProofTimeoutMs?: number
}

const DEFAULT_OWNERSHIP_PROOF_TIMEOUT_MS = 2_000

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export async function waitForPidGone(pid: number, budgetMs = 10_000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    if (!isPidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isPidAlive(pid)
}

/** True only when a fresh loopback listener can bind the fixture's exact port. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = net.createServer()
    listener.once('error', () => resolve(false))
    listener.listen(port, '127.0.0.1', () => {
      listener.close(() => resolve(true))
    })
  })
}

function appendFailure(failures: Error[], message: string, error: unknown): void {
  failures.push(new Error(message, { cause: error }))
}

/**
 * Prove the fixture's recorded PID and port are both released. This is kept
 * separate from stopping so every caller gets the same non-vacuous proof.
 */
export async function verifyOwnedServerStopped(
  receipt: OwnedServerReceipt,
  probes: OwnedServerTeardownProbes = { waitForPidGone, isPortFree },
  observation?: OwnedServerStopObservation,
): Promise<void> {
  const failures: Error[] = []

  try {
    const gone = await probes.waitForPidGone(receipt.pid)
    if (observation) observation.pidGone = gone
    if (!gone) {
      failures.push(new Error(`owned server PID ${receipt.pid} is still alive after stop()`))
    }
  } catch (error) {
    if (observation) observation.pidGone = 'probe-error'
    appendFailure(failures, `could not verify owned server PID ${receipt.pid} stopped`, error)
  }

  try {
    const bindable = await probes.isPortFree(receipt.port)
    if (observation) observation.portBindable = bindable
    if (!bindable) {
      failures.push(new Error(`owned server port ${receipt.port} is still bound after stop()`))
    }
  } catch (error) {
    if (observation) observation.portBindable = 'probe-error'
    appendFailure(failures, `could not verify owned server port ${receipt.port} was released`, error)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `owned server teardown failed for PID ${receipt.pid}, port ${receipt.port}`)
  }
}

type ExactProcessState = { state: 'gone' | 'owned' | 'unproven'; error?: unknown }

async function proveOwnershipWithinBudget(
  receipt: OwnedServerReceipt,
  probes: ForcedOwnedServerTeardownProbes,
): Promise<void> {
  const timeoutMs = probes.ownershipProofTimeoutMs ?? DEFAULT_OWNERSHIP_PROOF_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`ownership proof timeout must be a positive finite duration, received ${timeoutMs}`)
  }

  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutError = new Error(`ownership proof timed out after ${timeoutMs}ms`)
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
  })
  const proof = Promise.resolve().then(() => probes.proveOwnership(receipt, {
    signal: controller.signal,
    deadline,
  }))

  try {
    await Promise.race([proof, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Cooperative probes receive an abort on every exit path, so a future
    // operation cannot outlive this observation's ownership decision.
    if (!controller.signal.aborted) controller.abort()
  }
}

async function observeExactProcess(
  process: ExactOwnedServerProcess,
  receipt: OwnedServerReceipt,
  probes: ForcedOwnedServerTeardownProbes,
): Promise<ExactProcessState> {
  if (!process.isAlive()) return { state: 'gone' }
  try {
    await proveOwnershipWithinBudget(receipt, probes)
    return { state: 'owned' }
  } catch (error) {
    // A natural exit between the liveness probe and /proc/handle inspection is
    // success, not a reason to keep a numeric PID in forced containment.
    if (!process.isAlive()) return { state: 'gone' }
    return { state: 'unproven', error }
  }
}

async function waitForExactProcessExit(
  process: ExactOwnedServerProcess,
  receipt: OwnedServerReceipt,
  probes: ForcedOwnedServerTeardownProbes,
  timeoutMs: number,
): Promise<ExactProcessState> {
  const deadline = Date.now() + timeoutMs
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / 25) + 1)
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const observed = await observeExactProcess(process, receipt, probes)
    if (observed.state !== 'owned') return observed
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { state: 'owned' }
    await probes.sleep(Math.min(25, remaining))
  }
  return observeExactProcess(process, receipt, probes)
}

async function verifyForcedOwnedServerStopped(
  process: ExactOwnedServerProcess,
  receipt: OwnedServerReceipt,
  probes: ForcedOwnedServerTeardownProbes,
): Promise<void> {
  const failures: Error[] = []
  const observed = await observeExactProcess(process, receipt, probes)
  if (observed.state === 'owned') {
    failures.push(new Error(`owned server PID ${receipt.pid} is still alive after forced teardown`))
  } else if (observed.state === 'unproven') {
    appendFailure(failures, `could not verify original identity of server PID ${receipt.pid} after forced teardown`, observed.error)
  }

  try {
    if (!await probes.isPortFree(receipt.port)) {
      failures.push(new Error(`owned server port ${receipt.port} is still bound after forced teardown`))
    }
  } catch (error) {
    appendFailure(failures, `could not verify owned server port ${receipt.port} was released`, error)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `forced owned server teardown verification failed for PID ${receipt.pid}, port ${receipt.port}`)
  }
}

/**
 * Contain only a receipt-backed fixture child. Ownership is checked before
 * signaling, then TERM and KILL each have a bounded, observed-exit wait.
 */
export async function forceStopExactOwnedServerAndVerify(
  process: ExactOwnedServerProcess,
  receipt: OwnedServerReceipt,
  probes: ForcedOwnedServerTeardownProbes,
  timeoutMs = 5_000,
): Promise<void> {
  const failures: Error[] = []
  if (process.pid !== receipt.pid) {
    failures.push(new Error(`captured process PID ${process.pid} does not match receipt PID ${receipt.pid}`))
  } else {
    const initial = await observeExactProcess(process, receipt, probes)
    if (initial.state === 'unproven') {
      appendFailure(failures, `could not prove ownership of server PID ${receipt.pid}`, initial.error)
    } else if (initial.state === 'owned') {
      try {
        const sentTerm = process.signal('SIGTERM')
        if (!sentTerm && process.isAlive()) {
          throw new Error(`owned server PID ${receipt.pid} rejected SIGTERM`)
        }
        const afterTerm = await waitForExactProcessExit(process, receipt, probes, timeoutMs)
        if (afterTerm.state === 'unproven') {
          throw new Error(`ownership of server PID ${receipt.pid} changed after SIGTERM`, { cause: afterTerm.error })
        }
        if (afterTerm.state === 'owned') {
          // PID liveness alone is insufficient: prove the same fixture child
          // again immediately before escalation so PID reuse can never receive
          // an unproven SIGKILL.
          await proveOwnershipWithinBudget(receipt, probes)
          const sentKill = process.signal('SIGKILL')
          if (!sentKill && process.isAlive()) {
            throw new Error(`owned server PID ${receipt.pid} rejected SIGKILL`)
          }
          const afterKill = await waitForExactProcessExit(process, receipt, probes, timeoutMs)
          if (afterKill.state === 'unproven') {
            throw new Error(`ownership of server PID ${receipt.pid} changed after SIGKILL`, { cause: afterKill.error })
          }
          if (afterKill.state === 'owned') {
            throw new Error(`owned server PID ${receipt.pid} did not exit within ${timeoutMs}ms after SIGKILL`)
          }
        }
      } catch (error) {
        appendFailure(failures, `force-stopping owned server PID ${receipt.pid}`, error)
      }
    }
  }

  try {
    await verifyForcedOwnedServerStopped(process, receipt, probes)
  } catch (error) {
    appendFailure(failures, `verifying forced teardown of owned server PID ${receipt.pid}`, error)
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `forced owned server teardown failed for PID ${receipt.pid}, port ${receipt.port}`,
    )
  }
}

/**
 * Stop the exact server the fixture spawned, then prove its exact PID and
 * bound port are gone. All probes run even if stop() fails so teardown never
 * trades cleanup completeness for error visibility.
 */
export async function stopOwnedServerAndVerify(
  server: OwnedServerHandle,
  receipt: OwnedServerReceipt,
  probes: OwnedServerTeardownProbes = { waitForPidGone, isPortFree },
  observation?: OwnedServerStopObservation,
): Promise<void> {
  const failures: Error[] = []

  try {
    await server.stop()
    if (observation) observation.stop = 'fulfilled'
  } catch (error) {
    if (observation) observation.stop = 'rejected'
    failures.push(
      new Error(`owned server PID ${receipt.pid} stop failed`, {
        cause: error,
      }),
    )
  }

  try {
    await verifyOwnedServerStopped(receipt, probes, observation)
  } catch (error) {
    appendFailure(failures, `verifying owned server PID ${receipt.pid} stopped`, error)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `owned server teardown failed for PID ${receipt.pid}, port ${receipt.port}`)
  }
}
