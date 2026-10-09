import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeHarness } from './runtime-sandbox.js'

/** The fixed Task7 library-parent lane, never a caller-selected command runner. */
export async function runTask007DestructiveSandbox(repoRoot: string): Promise<void> {
  const runtime = new RuntimeHarness(fs.realpathSync(repoRoot), undefined, 3, { bootstrapProviders: [] })
  let failure: unknown
  try {
    const result = await runtime.runTask007StoppedRepairParents()
    process.stdout.write(`${JSON.stringify({ candidateSha: runtime.candidateSha, runId: runtime.runId,
      imageRef: runtime.imageRef, evidenceDir: runtime.evidenceDir, ...result })}\n`)
  } catch (error) {
    failure = error
  } finally {
    const closure = await runtime.cleanup()
    process.stdout.write(`${JSON.stringify({ runId: runtime.runId, cleanup: closure })}\n`)
    if (!closure.ok) throw new Error('Task7 destructive owner cleanup failed', { cause: failure })
  }
  if (failure) throw failure
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Task7 destructive sandbox accepts no caller arguments')
  await runTask007DestructiveSandbox(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
}
