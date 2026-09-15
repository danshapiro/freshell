import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const payload = JSON.parse(process.argv[2] ?? '{}')
const behaviorMap = JSON.parse(process.env.FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR ?? '{}')
const captureFile = process.env.FRESHELL_TEST_COORDINATOR_CAPTURE_FILE
const behavior = behaviorMap[payload.selector] ?? behaviorMap.default ?? {}

// A long-lived descendant stands in for the processes real phases launch
// (gcloud under vitest-cloud.sh, Cargo test binaries, Vitest workers), so
// tests can prove that stopping a phase leaves no orphaned descendants.
let grandchildPid
if (typeof behavior.grandchildHoldMs === 'number' && behavior.grandchildHoldMs > 0) {
  const grandchild = spawn(
    process.execPath,
    ['-e', `setTimeout(() => {}, ${behavior.grandchildHoldMs})`],
    { stdio: 'ignore' },
  )
  grandchildPid = grandchild.pid
}

if (captureFile) {
  await fs.mkdir(path.dirname(captureFile), { recursive: true }).catch(() => {})
  await fs.appendFile(
    captureFile,
    `${JSON.stringify({
      selector: payload.selector,
      command: payload.command,
      args: payload.args,
      active: process.env.FRESHELL_TEST_COORDINATOR_ACTIVE,
      pid: process.pid,
      grandchildPid,
    })}\n`,
  )
}

if (behavior.stdout) {
  process.stdout.write(String(behavior.stdout))
}

if (behavior.stderr) {
  process.stderr.write(String(behavior.stderr))
}

if (typeof behavior.holdMs === 'number' && behavior.holdMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, behavior.holdMs))
}

if (typeof behavior.waitForFile === 'string') {
  while (!(await fs.stat(behavior.waitForFile).then(() => true, () => false))) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

if (behavior.signal) {
  process.kill(process.pid, String(behavior.signal))
  await new Promise(() => {})
}

process.exit(Number.isInteger(behavior.exitCode) ? behavior.exitCode : 0)
