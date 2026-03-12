import fs from 'fs/promises'
import { parseCompareArgs } from '../test/e2e-browser/perf/audit-cli.js'
import { VisibleFirstAuditSchema } from '../test/e2e-browser/perf/audit-contract.js'
import { compareVisibleFirstAudits } from '../test/e2e-browser/perf/compare-visible-first-audits.js'

async function readArtifact(filePath: string) {
  const raw = await fs.readFile(filePath, 'utf8')
  return VisibleFirstAuditSchema.parse(JSON.parse(raw))
}

async function main(): Promise<void> {
  const args = parseCompareArgs(process.argv.slice(2))
  const [base, candidate] = await Promise.all([
    readArtifact(args.basePath),
    readArtifact(args.candidatePath),
  ])
  process.stdout.write(`${JSON.stringify(compareVisibleFirstAudits(base, candidate), null, 2)}\n`)
}

await main()
