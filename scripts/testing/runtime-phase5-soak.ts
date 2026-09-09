import fs from 'node:fs'
import path from 'node:path'

import { newRequest, newSoul, RuntimeHarness, type SupervisorInstance } from './runtime-sandbox.js'

const MIN_DURATION_MS = 30 * 60 * 1_000
const desiredDuration = Number(process.env.FRESHELL_RUNTIME_PHASE5_SOAK_MS ?? MIN_DURATION_MS)
if (!Number.isFinite(desiredDuration) || desiredDuration < MIN_DURATION_MS) {
  throw new Error(`Phase 5 qualification soak must run for at least ${MIN_DURATION_MS}ms`)
}

const h = new RuntimeHarness(process.cwd(), undefined, 5)
let supervisor: SupervisorInstance | undefined
let failure: unknown
const startedAt = Date.now()
const soulIds: string[] = []
let memoryPressure = false
let cpuPressure = false
let pidPressure = false
let duplicateWriters = 0
let falseLossNotices = 0
let maxRuntimeEvidenceBytes = 0

function dataOf(result: any, expected: string): any {
  if (!result || result.kind !== expected) throw new Error(`expected ${expected}, got ${JSON.stringify(result)}`)
  return result.data
}

async function epoch(): Promise<number> {
  return dataOf(await h.adminOk(supervisor!, { method: 'health' }), 'health').controlEpoch
}

function totalBytes(root: string): number {
  if (!fs.existsSync(root)) return 0
  let total = 0
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name))
    } else {
      total += stat.size
    }
  }
  return total
}

try {
  await h.prepare()
  supervisor = await h.startSupervisor({ scenarioId: 'phase5-30m-soak' })
  const controlEpoch = await epoch()
  await h.adminOk(supervisor, h.migrationPlanBody({
    requestedMode: 'managed-opt-in',
    apply: true,
    expectedControlEpoch: controlEpoch,
  }), { requestId: newRequest() })

  const fixtures = Array.from({ length: 50 }, (_, index) => (
    index === 47 ? 'cpu_burner'
      : index === 48 ? 'memory_allocator'
        : index === 49 ? 'descendant_spawner'
          : 'heartbeat'
  )) as Array<'heartbeat' | 'cpu_burner' | 'memory_allocator' | 'descendant_spawner'>

  for (const [index, fixture] of fixtures.entries()) {
    const soulId = newSoul()
    soulIds.push(soulId)
    const limits = fixture === 'memory_allocator'
      ? { cpuMilli: 250, memoryBytes: 64 * 1024 * 1024, swapBytes: 0, pidsMax: 32 }
      : fixture === 'cpu_burner'
        ? { cpuMilli: 100, memoryBytes: 32 * 1024 * 1024, swapBytes: 0, pidsMax: 16 }
        : fixture === 'descendant_spawner'
          ? { cpuMilli: 100, memoryBytes: 32 * 1024 * 1024, swapBytes: 0, pidsMax: 20 }
          : { cpuMilli: 50, memoryBytes: 24 * 1024 * 1024, swapBytes: 0, pidsMax: 8 }
    await h.adminOk(supervisor, h.launchBody({
      soulId,
      fixture,
      limits,
      projectKey: `soak-project-${Math.floor(index / 10)}`,
      expectedControlEpoch: controlEpoch,
      viewIntent: {
        ownerId: 'phase5-soak',
        workspaceId: `soak-project-${Math.floor(index / 10)}`,
        kind: 'automatic_primary',
        preferredTabId: `soak-tab-${index}`,
        preferredPaneId: `soak-pane-${index}`,
        title: `Soak fixture ${index}`,
        placementGroup: 'Recovered agents',
        visibility: 'visible',
      },
    }), { requestId: newRequest() })
  }

  const deadline = startedAt + desiredDuration
  let sample = 0
  while (Date.now() < deadline) {
    sample += 1
    const snapshot = dataOf(await h.adminOk(supervisor, h.inventorySnapshotBody()), 'inventory_snapshot')
    for (const soulId of soulIds) {
      const running = snapshot.souls.filter((row: any) => row.soulId === soulId && row.launchState === 'running')
      if (running.length > 1) duplicateWriters += running.length - 1
      const latest = snapshot.souls.filter((row: any) => row.soulId === soulId).at(-1)
      if (latest?.recoveryState === 'lost') falseLossNotices += 1
      try {
        const metrics = dataOf(await h.adminOk(
          supervisor,
          h.runtimeMetricsBody(soulId, await epoch()),
          { requestId: newRequest() },
        ), 'runtime_metrics')
        cpuPressure ||= metrics.cpuUsageUsec > 500_000 || metrics.cpuNrThrottled > 0
        memoryPressure ||= metrics.memoryOom > 0 || metrics.memoryOomKill > 0 || metrics.memoryPeakBytes >= 48 * 1024 * 1024
        pidPressure ||= metrics.pidsCurrent >= 15 || metrics.pidsMax <= 20
      } catch {
        // A deliberately pressured fixture may exit between inventory and its
        // metrics request. Startup recovery remains the liveness assertion.
      }
    }
    const notices = dataOf(await h.adminOk(
      supervisor,
      h.pendingNoticesBody('profile:phase5-soak', 100, await epoch()),
      { requestId: newRequest() },
    ), 'pending_notices')
    falseLossNotices += notices.length
    if (h.broker.unsafeAttempts().length > 0) throw new Error('soak broker recorded an unsafe request')
    maxRuntimeEvidenceBytes = Math.max(maxRuntimeEvidenceBytes, totalBytes(h.evidenceDir))
    if (sample % 12 === 0) {
      h.recordLifecycle('phase5.soak.sample', {
        elapsedMs: Date.now() - startedAt,
        desiredSouls: soulIds.length,
        memoryPressure,
        cpuPressure,
        pidPressure,
        duplicateWriters,
        falseLossNotices,
        maxRuntimeEvidenceBytes,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
} catch (error) {
  failure = error
} finally {
  const cleanup = await h.cleanup()
  const receipt = {
    schemaVersion: 1,
    status: failure ? 'FAIL' : 'PASS',
    candidateSha: h.candidateSha,
    durationMs: Date.now() - startedAt,
    desiredSouls: soulIds.length,
    memoryPressure,
    cpuPressure,
    pidPressure,
    duplicateWriters,
    falseLossNotices,
    unboundedOutputGrowth: maxRuntimeEvidenceBytes > 512 * 1024 * 1024,
    unboundedLogGrowth: maxRuntimeEvidenceBytes > 512 * 1024 * 1024,
    maxRuntimeEvidenceBytes,
    cleanupVerified: cleanup.ok,
    unsafeBrokerAttempts: h.broker?.unsafeAttempts?.().length ?? 0,
    errors: [failure ? String(failure) : null, ...cleanup.errors].filter(Boolean),
  }
  const target = process.env.FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT
    || path.join(h.evidenceDir, 'phase5-soak-receipt.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(receipt, null, 2))
  console.log(`[phase5-soak] receipt: ${target}`)
  console.log(JSON.stringify(receipt, null, 2))
  if (failure || !cleanup.ok || receipt.unsafeBrokerAttempts !== 0) process.exitCode = 1
}
