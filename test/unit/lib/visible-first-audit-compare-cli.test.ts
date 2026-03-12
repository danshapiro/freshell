// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseCompareArgs } from '@test/e2e-browser/perf/audit-cli'

describe('parseCompareArgs', () => {
  it('requires both base and candidate artifact paths', () => {
    expect(() => parseCompareArgs(['--base', 'base.json'])).toThrow(/candidate/i)
  })
})
