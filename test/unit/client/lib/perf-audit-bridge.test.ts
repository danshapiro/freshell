import { describe, expect, it } from 'vitest'
import { createPerfAuditBridge } from '@/lib/perf-audit-bridge'

describe('createPerfAuditBridge', () => {
  it('records milestones and returns serializable snapshots', () => {
    const audit = createPerfAuditBridge()
    audit.mark('app.bootstrap_ready', { view: 'terminal' })
    expect(audit.snapshot().milestones['app.bootstrap_ready']).toBeTypeOf('number')
  })
})
