// Standalone test adapter; production owners import the shared retained driver.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeHarness, newSoul, type RuntimeWebFactory } from './runtime-sandbox.js'
import { RustServer } from '../../test/e2e-browser/helpers/rust-server.js'
import { exercisePhase3StartupReplacementCrash } from '../../test/runtime/gates/phase-3.test.js'
import { runTask2RetainedFixture as runSharedRetainedFixture,
  task2FixtureData as data, task2FixtureInventory as inventory,
  task2FixtureOwnedRecord as ownedRecord, TASK2_FIXTURE_CASES as selected,
  type Task2RetainedBrowserHooks } from './task002-retained-fixture.js'
export type { Task2RetainedBrowserContext, Task2RetainedBrowserHooks, Task2RetainedBrowserPhase } from './task002-retained-fixture.js'

export async function runTask2RetainedFixture(
  h: RuntimeHarness, legacy: boolean, browser?: Task2RetainedBrowserHooks, tuiFormat: 'json' | 'jsonc' = 'jsonc',
  webFactory: RuntimeWebFactory = options => new RustServer(options),
): Promise<void> {
  return runSharedRetainedFixture(h, legacy, webFactory, browser, tuiFormat)
}

export async function runTask2Fixtures(h: RuntimeHarness): Promise<void> {
  const executed: string[] = [], failed: string[] = []
  const cases: [string, () => Promise<void>][] = [
    [selected[0], async () => { await runTask2RetainedFixture(h, false, undefined, 'json'); await runTask2RetainedFixture(h, false, undefined, 'jsonc') }], [selected[1], () => runTask2RetainedFixture(h, true)],
    [selected[2], async () => {
      const s = await h.startSupervisor({ scenarioId: 'task2-onewriter' }), soulId = newSoul()
      const launch = data(await h.adminOk(s, h.launchBody({ soulId, provider: 'native-session-fixture', fixture: 'native_session' })), 'launch')
      const made = await h.nativeFixtureCall(s, launch.view.incarnationId, { method: 'create' })
      h.assert(selected[2], made.ok && typeof made.sessionId === 'string', 'existing fixture materializes one synthetic identity')
      await h.adminOk(s, h.probeRecoveryBody(soulId)); h.killOwnedRuntimeExact(launch.view.containerId)
      const results = await Promise.all([h.adminOk(s, h.recoverBody(soulId, 'provider_exit')), h.adminOk(s, h.recoverBody(soulId, 'provider_exit'))])
      h.assert(selected[2], results.filter(r => data(r, 'recovery').outcome === 'replaced').length === 1, 'concurrent requests create one replacement')
      h.assert(selected[2], (await inventory(h, s)).filter(r => r.soulId === soulId && r.launchState === 'running').length === 1 && ownedRecord(h, s, soulId).writerClaims === 1, 'one running incarnation and writer claim')
    }],
    [selected[3], async () => { await exercisePhase3StartupReplacementCrash(h) }],
  ]
  try {
    for (const [name, run] of cases) {
      h.recordLifecycle('task2.case.started', { severity: 'info', name })
      try { await run(); executed.push(name) }
      catch (error) { failed.push(name); h.writeIncident(name, { severity: 'error', reason: String(error) }); throw error }
    }
  } finally {
    const receipts = h.broker.receipts(), ids = h.transferOwnedIds()
    const cleanup = await h.cleanup()
    h.verifyTransferCleanup({ containers: [...new Set([...ids.containers, ...receipts.map(r => r.containerId)])], volumes: [...new Set([...ids.volumes, ...receipts.flatMap(r => r.providerVolumeName ? [r.providerVolumeName] : [])])] })
    h.writeArtifact('task002-synthetic-receipt.json', { kind: 'synthetic-task2', candidateSha: h.candidateSha, imageDigest: h.imageRef,
      nativeQualified: false, browserExecuted: false, selectedCount: selected.length, executedCount: executed.length,
      failedCount: failed.length, skippedCount: selected.length - executed.length - failed.length, executed, failed, cleanup })
    if (!cleanup.ok || executed.length !== selected.length || failed.length) throw new Error('finite Task2 fixture matrix incomplete')
  }
}

// Main supplies this manifest only after final immutable candidate admission.
// It contains references/hashes, no credentials or real transcript data.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    if (process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1') throw new Error('exact synthetic fixture gate is required')
    const file = process.argv[2]
    if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('exact private artifact manifest required')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('manifest must be private and owned')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!/^[a-f0-9]{40}$/.test(manifest.candidateSha) || !/^[a-f0-9-]{36}$/.test(manifest.runId)
      || manifest.repoRoot !== fs.realpathSync(process.cwd())) throw new Error('exact task worktree/run identity required')
    const harness = new RuntimeHarness(manifest.repoRoot, manifest.runId, 3)
    await harness.prepareTask2FixtureArtifactsForCurrentCandidate(manifest)
    await runTask2Fixtures(harness)
  })().catch(() => {
    process.stderr.write(JSON.stringify({ severity: 'error', event: 'task2.synthetic_fixture.refused', reasonCode: 'fixture_matrix_failed' })+'\n')
    process.exitCode = 1
  })
}
