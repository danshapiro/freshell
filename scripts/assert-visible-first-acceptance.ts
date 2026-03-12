import fs from 'node:fs/promises'
import path from 'node:path'
import { AUDIT_SCENARIOS } from '../test/e2e-browser/perf/scenarios.js'
import {
  evaluateVisibleFirstAcceptanceReport,
  type VisibleFirstAcceptanceAuditScenario,
  type VisibleFirstAcceptanceReport,
  type VisibleFirstAcceptanceSourceFile,
} from '../test/helpers/visible-first/acceptance-contract.js'

type ParsedArgs = {
  outputPath: string
}

const PRODUCTION_ROOTS = ['shared', 'server', 'src'] as const
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function parseArgs(args: string[], cwd = process.cwd()): ParsedArgs {
  let outputPath: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--output') {
      outputPath = path.resolve(cwd, requireValue(arg, args[index + 1]))
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!outputPath) {
    throw new Error('visible-first acceptance report requires --output')
  }

  return { outputPath }
}

async function readProductionFiles(root: string): Promise<VisibleFirstAcceptanceSourceFile[]> {
  const results: VisibleFirstAcceptanceSourceFile[] = []

  async function walk(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        continue
      }

      results.push({
        file: path.relative(process.cwd(), absolutePath).replaceAll(path.sep, '/'),
        content: await fs.readFile(absolutePath, 'utf8'),
      })
    }
  }

  await walk(path.resolve(process.cwd(), root))
  return results
}

function mapAuditScenarios(): VisibleFirstAcceptanceAuditScenario[] {
  return AUDIT_SCENARIOS.map((scenario) => ({
    scenarioId: scenario.id,
    allowedApiRouteIdsBeforeReady: scenario.allowedApiRouteIdsBeforeReady,
    allowedWsTypesBeforeReady: scenario.allowedWsTypesBeforeReady,
  }))
}

async function writeReport(outputPath: string, report: VisibleFirstAcceptanceReport): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const productionFiles = (
    await Promise.all(PRODUCTION_ROOTS.map((root) => readProductionFiles(root)))
  ).flat()
  const report = evaluateVisibleFirstAcceptanceReport({
    productionFiles,
    auditScenarios: mapAuditScenarios(),
  })

  await writeReport(args.outputPath, report)
  if (!report.ok) {
    process.exitCode = 1
  }
}

await main()
