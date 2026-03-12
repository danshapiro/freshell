import fs from 'fs/promises'
import path from 'path'
import { parseAuditArgs } from '../test/e2e-browser/perf/audit-cli.js'
import {
  assertVisibleFirstAuditTrusted,
  VisibleFirstAuditSchema,
} from '../test/e2e-browser/perf/audit-contract.js'
import { runVisibleFirstAudit } from '../test/e2e-browser/perf/run-visible-first-audit.js'

async function main(): Promise<void> {
  const args = parseAuditArgs(process.argv.slice(2))
  const artifact = VisibleFirstAuditSchema.parse(await runVisibleFirstAudit({
    scenarioIds: args.scenarioIds,
    profileIds: args.profileIds,
  }))

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true })
  await fs.writeFile(args.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  assertVisibleFirstAuditTrusted(artifact)
}

await main()
