import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// This entire child runs under the shared harness lock. In particular, Cargo
// exiting does not allow another harness producer to replace its binaries
// before their run-private copies exist. OS lock ownership ends with the child.
const { command, args, copies } = JSON.parse(process.argv[2])
execFileSync(command, args, { stdio: 'inherit' })
for (const { source, target } of copies) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  fs.chmodSync(target, 0o755)
}
process.stderr.write(`${JSON.stringify({ severity: 'info', event: 'runtime.cargo.artifacts_snapshotted', artifactCount: copies.length })}\n`)
