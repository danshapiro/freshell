import { describe, expect, it } from 'vitest'
import { automaticResumeHistoryPreservesIdentity, supervisorCrashEvent } from '../../../runtime/gates/phase-3.test.js'


describe('Phase 3 automatic-resume history evidence', () => {
  const sessionId = 'fixture-native-exact-session'

  it('accepts exactly one automatic continuation of the materialized identity', () => {
    expect(automaticResumeHistoryPreservesIdentity({
      ok: true,
      sessionId,
      history: ['create', 'automatic_resume'],
    }, sessionId)).toBe(true)
  })

  it.each([
    { ok: true, sessionId, history: ['create', 'resume'] },
    { ok: true, sessionId, history: ['create', 'automatic_resume', 'automatic_resume'] },
    { ok: true, sessionId, history: ['create', 'create', 'automatic_resume'] },
    { ok: true, sessionId: 'different-session', history: ['create', 'automatic_resume'] },
    { ok: false, sessionId, history: ['create', 'automatic_resume'] },
  ])('rejects manual, duplicate, fresh, foreign, or failed history %#', (history) => {
    expect(automaticResumeHistoryPreservesIdentity(history, sessionId)).toBe(false)
  })
})


describe('Phase 3 named supervisor crash evidence', () => {
  it('accepts only the exact structured crash event and point', () => {
    const logs = [
      'ordinary diagnostic output',
      JSON.stringify({ event: 'supervisor.test_crash', point: 'after_docker_create' }),
    ].join('\n')

    expect(supervisorCrashEvent(logs, 'after_docker_create')).toEqual({
      event: 'supervisor.test_crash',
      point: 'after_docker_create',
    })
    expect(supervisorCrashEvent(logs, 'after_prepare')).toBeNull()
  })

  it.each([
    'Aborted',
    'supervisor.test_crash after_docker_create',
    '{"event":"supervisor.test_crash","point":"after_docker_create"',
    '{"event":"different","point":"after_docker_create"}',
  ])('does not mistake arbitrary process disappearance for the named event: %s', (logs) => {
    expect(supervisorCrashEvent(logs, 'after_docker_create')).toBeNull()
  })
})
