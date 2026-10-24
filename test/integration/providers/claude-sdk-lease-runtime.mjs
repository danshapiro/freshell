// Lifecycle faults at the SDK query boundary for Rust lease integration tests.
// The production sidecar owns every protocol frame and response.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { query as recordedQuery } from './claude-sdk-for-rust-runtime.mjs'

export function query(params) {
  let first = false
  try {
    fs.closeSync(fs.openSync(process.env.FRESHELL_TEST_CLAUDE_FIRST_LAUNCH, 'wx'))
    first = true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const runtime = recordedQuery(params)
  if (first && process.env.FRESHELL_TEST_CLAUDE_DECOY === '1') {
    // A tagged detached descendant ignores TERM so the lease expiry must
    // confirm its SIGKILL sweep before allowing a replacement writer.
    const child = spawn('sh', ['-c', 'trap "" TERM; echo armed; exec sleep 300 >/dev/null'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout.once('data', () => {
      child.stdout.destroy()
      fs.appendFileSync(process.env.FRESHELL_CLAUDE_SIM_LEDGER, `${JSON.stringify({
        kind: 'decoy', pid: process.pid, childPid: child.pid,
      })}\n`)
    })
    child.unref()
  }
  const initialize = runtime.initializationResult.bind(runtime)
  runtime.initializationResult = async () => {
    if (first && process.env.FRESHELL_TEST_CLAUDE_CRASH_FIRST === '1') process.exit(1)
    const gate = process.env.FRESHELL_TEST_CLAUDE_INITIALIZATION_GATE
    while (first && gate && fs.existsSync(gate)) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return initialize()
  }
  return runtime
}
