export type PerfAuditSnapshot = {
  milestones: Record<string, number>
  metadata: Record<string, unknown>
  perfEvents: Array<Record<string, unknown>>
  terminalLatencySamplesMs: number[]
}

export type PerfAuditBridge = {
  mark: (name: string, data?: Record<string, unknown>) => void
  addPerfEvent: (event: Record<string, unknown>) => void
  addTerminalLatencySample: (latencyMs: number) => void
  snapshot: () => PerfAuditSnapshot
}

let installedPerfAuditBridge: PerfAuditBridge | null = null

export function createPerfAuditBridge(): PerfAuditBridge {
  const milestones: Record<string, number> = {}
  const metadata: Record<string, unknown> = {}
  const perfEvents: Array<Record<string, unknown>> = []
  const terminalLatencySamplesMs: number[] = []

  return {
    mark(name, data) {
      if (!milestones[name]) {
        milestones[name] = typeof performance !== 'undefined' ? performance.now() : Date.now()
      }
      if (data) {
        metadata[name] = { ...(metadata[name] as Record<string, unknown> | undefined), ...data }
      }
    },
    addPerfEvent(event) {
      perfEvents.push({ ...event })
    },
    addTerminalLatencySample(latencyMs) {
      terminalLatencySamplesMs.push(latencyMs)
    },
    snapshot() {
      return {
        milestones: { ...milestones },
        metadata: { ...metadata },
        perfEvents: perfEvents.map((event) => ({ ...event })),
        terminalLatencySamplesMs: [...terminalLatencySamplesMs],
      }
    },
  }
}

export function installPerfAuditBridge(bridge: PerfAuditBridge | null): void {
  installedPerfAuditBridge = bridge
}

export function getInstalledPerfAuditBridge(): PerfAuditBridge | null {
  return installedPerfAuditBridge
}
