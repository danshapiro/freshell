// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAuditArgs } from '@test/e2e-browser/perf/audit-cli'

describe('parseAuditArgs', () => {
  it('defaults output to artifacts/perf/visible-first-audit.json', () => {
    expect(parseAuditArgs([]).outputPath).toContain('artifacts/perf/visible-first-audit.json')
  })
})
