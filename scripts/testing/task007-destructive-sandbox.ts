import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeHarness } from './runtime-sandbox.js'

/** The fixed Task7 library-parent lane, never a caller-selected command runner. */
export async function runTask007DestructiveSandbox(repoRoot: string): Promise<void> {
  const runtime = new RuntimeHarness(fs.realpathSync(repoRoot), undefined, 3, { bootstrapProviders: [] })
  let cancellation: 'SIGINT' | 'SIGTERM' | undefined
  const cancel = (signal: 'SIGINT' | 'SIGTERM') => {
    cancellation ??= signal
    runtime.cancelTask007(signal)
  }
  const interrupt = () => cancel('SIGINT')
  const terminate = () => cancel('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let failure: unknown
  try {
    const result = await runtime.runTask007StoppedRepairParents()
    process.stdout.write(`${JSON.stringify({ candidateSha: runtime.candidateSha, runId: runtime.runId,
      imageRef: runtime.imageRef, evidenceDir: runtime.evidenceDir, ...result })}\n`)
  } catch (error) {
    failure = error
  } finally {
    try {
      const closure = await runtime.cleanup()
      const status = cancellation ? 'cancelled' : failure || !closure.ok ? 'failed' : 'passed'
      const receipt = { runId: runtime.runId, candidateSha: runtime.candidateSha, status,
        ...(cancellation ? { signal: cancellation } : {}), cleanup: closure }
      runtime.writeArtifact('task007-destructive-owner-result.json', receipt)
      process.stdout.write(`${JSON.stringify(receipt)}\n`)
      if (!closure.ok) throw new Error('Task7 destructive owner cleanup failed', { cause: failure })
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
  }
  if (cancellation) throw new Error(`Task7 destructive owner cancelled (${cancellation})`, { cause: failure })
  if (failure) throw failure
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Task7 destructive sandbox accepts no caller arguments')
  await runTask007DestructiveSandbox(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
}
