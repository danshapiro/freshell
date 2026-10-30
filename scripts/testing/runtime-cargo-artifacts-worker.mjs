import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// This entire child runs under the shared harness lock. In particular, Cargo
// exiting does not allow another harness producer to replace its binaries
// before their run-private copies exist. OS lock ownership ends with the child.
const { command, args, copies, timeoutMs } = JSON.parse(process.argv[2])
execFileSync(command, args, { stdio: 'inherit', ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) })
try {
  for (const { source, target } of copies) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
  }
} catch (error) {
  // Keep actionable filesystem errors across the locked child boundary.
  // Cargo and its descendants inherit only normal stdout/stderr, not this pipe.
  const { message, code, errno, syscall, path: source, dest } = error
  fs.writeFileSync(3, JSON.stringify({ message, code, errno, syscall, path: source, dest }))
  throw error
}
process.stderr.write(`${JSON.stringify({ severity: 'info', event: 'runtime.cargo.artifacts_snapshotted', artifactCount: copies.length })}\n`)
