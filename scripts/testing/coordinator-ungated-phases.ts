import type { UpstreamPhase } from './coordinator-command-matrix.js'
import { logCoordinatorEvent } from './coordinator-log.js'
import type { UngatedPhaseStatus, UngatedRunRecord } from './coordinator-schema.js'
import { clearUngatedRunRecord, writeUngatedRunRecord } from './coordinator-store.js'
import { describeUpstreamPhase, startUpstreamPhase, type RunningPhase } from './coordinator-upstream.js'

/** Why a coordinated run stopped early. The first cause wins; every phase stops on it. */
export type StopCause =
  | { kind: 'phase-failed'; phase: string; ungated: boolean; exitCode: number }
  | { kind: 'signal'; signal: NodeJS.Signals; exitCode: number }
  | { kind: 'gate-timeout'; exitCode: number }
  | { kind: 'error'; message: string; exitCode: number }

/**
 * Fail-fast state shared by the gated and ungated sides of a run: whichever
 * side fails (or an interrupt or gate timeout) first stops the other.
 */
export class RunControl {
  readonly stopped: Promise<void>
  private currentCause: StopCause | undefined
  private resolveStopped: () => void = () => {}

  constructor() {
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve
    })
  }

  get cause(): StopCause | undefined {
    return this.currentCause
  }

  /**
   * A method rather than a truthiness check on `cause`, so TypeScript does not
   * carry a narrowed `cause` across the awaits where another side may stop.
   */
  isStopped(): boolean {
    return this.currentCause !== undefined
  }

  /** Interrupts are forwarded as received; every other stop terminates. */
  get stopSignal(): NodeJS.Signals {
    return this.currentCause?.kind === 'signal' ? this.currentCause.signal : 'SIGTERM'
  }

  /** Record the stop cause; returns false when an earlier cause already won. */
  stop(cause: StopCause): boolean {
    if (this.currentCause) return false
    this.currentCause = cause
    this.resolveStopped()
    return true
  }
}

export type UngatedRunIdentity = Omit<UngatedRunRecord, 'gate' | 'phases'>

type TrackedPhase = UngatedPhaseStatus & {
  running: RunningPhase
  stopRequested: boolean
  settled: Promise<void>
}

/**
 * Phases that need no local CPU/RAM protection (the cloud client Vitest lane)
 * run outside the coordinator gate for the whole run. Their progress is
 * published per run so `test:status` can show them next to the gate holder.
 */
export class UngatedPhaseSet {
  private readonly phases: TrackedPhase[] = []
  private gate: UngatedRunRecord['gate'] = 'waiting'
  private publishing: Promise<void> = Promise.resolve()

  constructor(
    private readonly storeDir: string,
    private readonly identity: UngatedRunIdentity,
    private readonly control: RunControl,
  ) {}

  get isEmpty(): boolean {
    return this.phases.length === 0
  }

  async start(phases: readonly UpstreamPhase[], env: NodeJS.ProcessEnv): Promise<void> {
    for (const phase of phases) {
      const label = ungatedPhaseLabel(phase)
      const running = startUpstreamPhase(phase, env, { outputPrefix: `[${label}] ` })
      const tracked: TrackedPhase = {
        label,
        selector: describeUpstreamPhase(phase),
        startedAt: new Date().toISOString(),
        state: 'running',
        running,
        stopRequested: false,
        settled: Promise.resolve(),
      }
      tracked.settled = running.exitCode.then(
        (exitCode) => this.finish(tracked, exitCode),
        (error: unknown) => this.finish(tracked, 1, error),
      )
      this.phases.push(tracked)
      logCoordinatorEvent('info', 'ungated_phase_started', {
        phase: label,
        selector: tracked.selector,
        pid: running.pid,
      })
    }
    await this.publish()
  }

  async setGate(gate: UngatedRunRecord['gate']): Promise<void> {
    if (this.isEmpty) return
    this.gate = gate
    await this.publish()
  }

  /** Wait for every ungated phase, stopping those still running once the run stops. */
  async settle(graceMs: number): Promise<void> {
    if (!this.control.isStopped()) {
      await Promise.race([this.allSettled(), this.control.stopped])
    }
    if (this.control.isStopped()) {
      await this.stopAll(graceMs)
    }
    await this.allSettled()
  }

  async stopAll(graceMs: number): Promise<void> {
    const signal = this.control.stopSignal
    await Promise.all(this.phases
      .filter((phase) => phase.state === 'running')
      .map(async (phase) => {
        phase.stopRequested = true
        logCoordinatorEvent('warn', 'ungated_phase_stopping', {
          phase: phase.label,
          signal,
          reason: this.control.cause?.kind,
        })
        await phase.running.stop(signal, graceMs)
      }))
    await this.allSettled()
  }

  async clear(): Promise<void> {
    if (this.isEmpty) return
    await this.allSettled()
    await this.publishing
    await clearUngatedRunRecord(this.storeDir, this.identity.runId)
  }

  private async allSettled(): Promise<void> {
    await Promise.all(this.phases.map((phase) => phase.settled))
  }

  private async finish(phase: TrackedPhase, exitCode: number, error?: unknown): Promise<void> {
    phase.exitCode = exitCode
    phase.finishedAt = new Date().toISOString()
    phase.state = phase.stopRequested ? 'stopped' : exitCode === 0 ? 'passed' : 'failed'
    if (phase.state === 'failed') {
      this.control.stop({ kind: 'phase-failed', phase: phase.label, ungated: true, exitCode })
    }
    await this.publish()
    logCoordinatorEvent(phase.state === 'passed' ? 'info' : phase.state === 'stopped' ? 'warn' : 'error', 'ungated_phase_finished', {
      phase: phase.label,
      selector: phase.selector,
      state: phase.state,
      exitCode,
      durationMs: Date.parse(phase.finishedAt) - Date.parse(phase.startedAt),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    })
  }

  private publish(): Promise<void> {
    const record: UngatedRunRecord = {
      ...this.identity,
      gate: this.gate,
      phases: this.phases.map(({ label, selector, startedAt, finishedAt, state, exitCode }) => ({
        label,
        selector,
        startedAt,
        finishedAt,
        state,
        exitCode,
      })),
    }
    this.publishing = this.publishing
      .then(() => writeUngatedRunRecord(this.storeDir, record))
      .catch((error: unknown) => {
        logCoordinatorEvent('warn', 'ungated_record_write_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return this.publishing
  }
}

function ungatedPhaseLabel(phase: UpstreamPhase): string {
  return phase.runner === 'cloud-vitest' ? 'cloud client' : describeUpstreamPhase(phase)
}
