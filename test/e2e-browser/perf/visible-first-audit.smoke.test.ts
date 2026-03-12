import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { runVisibleFirstAudit } from './run-visible-first-audit.js'
import { VisibleFirstAuditSchema } from './audit-contract.js'

describe('visible-first audit smoke', () => {
  it('writes a schema-valid artifact for a reduced auth-only run', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'visible-first-audit-'))
    const outputPath = path.join(outputDir, 'audit.json')

    const artifact = await runVisibleFirstAudit({
      scenarioIds: ['auth-required-cold-boot'],
      profileIds: ['desktop_local'],
    })
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)

    const parsed = VisibleFirstAuditSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')))
    expect(parsed.scenarios).toHaveLength(1)
  })
})
