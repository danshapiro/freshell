import { describe, expect, it } from 'vitest'

import { isNativeReadinessDiagnosticEvent, safeNativeReadinessProviderStartCause } from '../../helpers/native-readiness-diagnostics.js'

describe('native readiness parity diagnostics', () => {
  it('retains superseded preparation, resume, and replacement causes in captured incidents', () => {
    const records = [
      { event: 'host.native_identity.readiness_failed', data: { nativeReadinessProviderStartCause: 'preparation_superseded' } },
      { event: 'host.fresh_agent.open_failed', data: { nativeReadinessProviderStartCause: 'exact_resume_superseded' } },
      { event: 'host.fresh_agent.open_failed', data: { nativeReadinessProviderStartCause: 'replacement_superseded' } },
      { event: 'unrelated_private_event', data: { nativeReadinessProviderStartCause: 'private provider output' } },
    ]
    const captured = records.filter(row => isNativeReadinessDiagnosticEvent(row.event)).map(row => ({
      nativeReadinessProviderStartCause: safeNativeReadinessProviderStartCause(row.data.nativeReadinessProviderStartCause),
    }))

    expect(JSON.parse(JSON.stringify(captured))).toEqual([
      { nativeReadinessProviderStartCause: 'preparation_superseded' },
      { nativeReadinessProviderStartCause: 'exact_resume_superseded' },
      { nativeReadinessProviderStartCause: 'replacement_superseded' },
    ])
  })

  it('retains existing failure causes while omitting arbitrary provider output', () => {
    expect(isNativeReadinessDiagnosticEvent('host.native_identity.readiness_receipt_committed')).toBe(true)
    expect(isNativeReadinessDiagnosticEvent('host.grant_timing')).toBe(true)
    expect(safeNativeReadinessProviderStartCause('exact_resume_app_server_start')).toBe('exact_resume_app_server_start')
    expect(safeNativeReadinessProviderStartCause('replacement_thread_start')).toBe('replacement_thread_start')
    for (const value of ['private provider output', 'replacement_superseded secret', null, {}, 42]) {
      expect(safeNativeReadinessProviderStartCause(value)).toBeUndefined()
    }
  })
})
