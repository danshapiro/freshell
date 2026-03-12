import fs from 'node:fs/promises'
import { parseCompareArgs } from '../test/e2e-browser/perf/audit-cli.js'
import { VisibleFirstAuditSchema } from '../test/e2e-browser/perf/audit-contract.js'
import {
  evaluateVisibleFirstAuditGate,
  type VisibleFirstAuditGateResult,
} from '../test/e2e-browser/perf/visible-first-audit-gate.js'

async function readArtifact(filePath: string) {
  const raw = await fs.readFile(filePath, 'utf8')
  return VisibleFirstAuditSchema.parse(JSON.parse(raw))
}

function writeResult(result: VisibleFirstAuditGateResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

async function main(): Promise<void> {
  try {
    const args = parseCompareArgs(process.argv.slice(2))
    const [base, candidate] = await Promise.all([
      readArtifact(args.basePath),
      readArtifact(args.candidatePath),
    ])
    const result = evaluateVisibleFirstAuditGate(base, candidate)
    writeResult(result)
    if (!result.ok) {
      process.exitCode = 1
    }
  } catch {
    writeResult({ ok: false, violations: [] })
    process.exitCode = 1
  }
}

await main()
