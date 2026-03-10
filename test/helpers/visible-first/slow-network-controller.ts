export type SlowNetworkLane = 'critical' | 'visible' | 'background'

export type SlowNetworkRequestLogEntry = {
  lane: SlowNetworkLane
  label: string
  requestedAt: number
  releasedAt?: number
}

type PendingGate = {
  entry: SlowNetworkRequestLogEntry
  resolve: () => void
  promise: Promise<void>
}

function createDeferred(): PendingGate {
  let resolve = () => undefined
  const entry = {
    lane: 'visible' as SlowNetworkLane,
    label: '',
    requestedAt: Date.now(),
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { entry, resolve, promise }
}

function waitForCondition(predicate: () => boolean, timeoutMs: number, errorMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    const tick = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(errorMessage))
        return
      }
      setTimeout(tick, 5)
    }

    tick()
  })
}

export function createSlowNetworkController() {
  const pending = {
    critical: [] as PendingGate[],
    visible: [] as PendingGate[],
    background: [] as PendingGate[],
  }
  const requestLog: SlowNetworkRequestLogEntry[] = []
  const wsReadyGate = createDeferred()
  let wsReadyReleasedAt: number | undefined

  return {
    async waitForLane(lane: SlowNetworkLane, label: string): Promise<void> {
      const gate = createDeferred()
      gate.entry = {
        lane,
        label,
        requestedAt: Date.now(),
      }
      pending[lane].push(gate)
      requestLog.push(gate.entry)
      await gate.promise
      gate.entry.releasedAt = Date.now()
    },

    releaseNext(lane: SlowNetworkLane): boolean {
      const next = pending[lane].shift()
      if (!next) return false
      next.resolve()
      return true
    },

    waitForPending(lane: SlowNetworkLane, count = 1, timeoutMs = 2_000): Promise<void> {
      return waitForCondition(
        () => pending[lane].length >= count,
        timeoutMs,
        `Timed out waiting for ${count} pending ${lane} request(s)`,
      )
    },

    getRequestLog(): SlowNetworkRequestLogEntry[] {
      return requestLog.slice()
    },

    async waitForWsReady(): Promise<void> {
      await wsReadyGate.promise
    },

    releaseWsReady(): void {
      if (wsReadyReleasedAt !== undefined) return
      wsReadyReleasedAt = Date.now()
      wsReadyGate.resolve()
    },

    isWsReadyReleased(): boolean {
      return wsReadyReleasedAt !== undefined
    },
  }
}
