import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Run under the shared artifact lock; a failed build never snapshots old output. */
export function runRuntimeCargoArtifactWorker({ command, args, copies, timeoutMs }, {
  execute = execFileSync,
  reportFailure = failure => fs.writeFileSync(3, JSON.stringify(failure)),
  log = message => process.stderr.write(message),
} = {}) {
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('runtime Cargo watchdog requires a positive finite millisecond budget')
    }
    execute(command, args, { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' })
    for (const { source, target } of copies) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      fs.chmodSync(target, 0o755)
    }
  } catch (error) {
    // Preserve native build interruption/spawn fields as well as actionable
    // copy errors across the child boundary. Cargo inherits only standard I/O,
    // never this private failure channel.
    const { message, code, errno, syscall, path: source, dest, status, signal, pid, killed } = error
    try { reportFailure({ message, code, errno, syscall, path: source, dest, status, signal, pid, killed }) }
    catch { /* A closed diagnostic pipe must not replace the original failure. */ }
    throw error
  }
  log(`${JSON.stringify({ severity: 'info', event: 'runtime.cargo.artifacts_snapshotted', artifactCount: copies.length })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRuntimeCargoArtifactWorker(JSON.parse(process.argv[2]))
}
