// Real use requires independent guest qualification and a separately admitted
// bounded driver; the shared preflight is only a second check.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import { requireQualifiedGuest, runCaptureBudgetCase } from './codex-real-volume-lifecycle.js'
export { runCaptureBudgetCase }

async function main(): Promise<void> {
  const { repo, daemonId } = requireQualifiedGuest()
  const socket = process.env.FRESHELL_TASK4_DOCKER_SOCKET
  const privateRoot = process.env.FRESHELL_TASK4_PRIVATE_ROOT
  const dockerCli = process.env.FRESHELL_TASK4_DOCKER_CLI
  assert.ok(socket && privateRoot && dockerCli)
  await runCaptureBudgetCase({ repo, daemonId, socket, privateRoot, dockerCli })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ severity: 'error', event: 'real_capture_budget.failed', phase: 'driver', kind: 'operation' })}\n`)
    process.exitCode = 1
  })
}
