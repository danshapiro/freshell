import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createAmplifierReducerState,
  reduceAmplifierEvent,
  type AmplifierParsedRecord,
  type AmplifierReducerEffect,
  type AmplifierReducerState,
} from '../../../../server/coding-cli/amplifier-events-reducer.js'

const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures/coding-cli/amplifier/events')

function loadFixture(name: string): AmplifierParsedRecord[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AmplifierParsedRecord)
}

function reduceAll(
  records: AmplifierParsedRecord[],
  initial: AmplifierReducerState = createAmplifierReducerState(),
): { state: AmplifierReducerState; effects: AmplifierReducerEffect[] } {
  let state = initial
  const effects: AmplifierReducerEffect[] = []
  for (const record of records) {
    const result = reduceAmplifierEvent(state, record)
    state = result.state
    effects.push(...result.effects)
  }
  return { state, effects }
}

function kinds(effects: AmplifierReducerEffect[]): string[] {
  return effects.map((effect) => effect.kind)
}

function record(overrides: Partial<AmplifierParsedRecord> & { event: string }): AmplifierParsedRecord {
  return {
    ts: '2026-07-08T15:50:50.757003704+00:00',
    schema: { name: 'amplifier.log', ver: '1.0.0' },
    session_id: 'test-session',
    data: { parent_id: null },
    ...overrides,
  }
}

describe('amplifier events reducer', () => {
  it('starts idle, not degraded, with no subagent indicator (empty input)', () => {
    const state = createAmplifierReducerState()
    expect(state.phase).toBe('idle')
    expect(state.degraded).toBe(false)
    expect(state.subagent).toBe(false)
  })

  describe('fixture: normal-turn (E2)', () => {
    it('emits session.identified, one turn.began, exactly one turn.completed, ends idle', () => {
      const { state, effects } = reduceAll(loadFixture('normal-turn.jsonl'))

      expect(kinds(effects)).toEqual(['session.identified', 'turn.began', 'turn.completed'])
      expect(state.phase).toBe('idle')
      expect(state.degraded).toBe(false)
      expect(state.sessionId).toBe('1326337c-f0fb-49ff-9ff6-06722c5e0bab')
    })

    it('session.identified carries sessionId and cwd from session:config data.raw', () => {
      const { effects } = reduceAll(loadFixture('normal-turn.jsonl'))
      const identified = effects.find((effect) => effect.kind === 'session.identified')
      expect(identified).toEqual({
        kind: 'session.identified',
        sessionId: '1326337c-f0fb-49ff-9ff6-06722c5e0bab',
        cwd: '/tmp/amp-p0-b',
      })
    })

    it('turn.completed fires on prompt:complete, not session:end (session:end at idle is ignored)', () => {
      const records = loadFixture('normal-turn.jsonl')
      const completeIndex = records.findIndex((r) => r.event === 'prompt:complete')
      const endIndex = records.findIndex((r) => r.event === 'session:end')
      expect(completeIndex).toBeGreaterThan(0)
      expect(endIndex).toBeGreaterThan(completeIndex)

      let state = createAmplifierReducerState()
      for (const [index, rec] of records.entries()) {
        const result = reduceAmplifierEvent(state, rec)
        state = result.state
        if (index === completeIndex) {
          expect(kinds(result.effects)).toEqual(['turn.completed'])
        }
        if (index === endIndex) {
          expect(result.effects).toEqual([])
        }
      }
    })
  })

  describe('fixture: pty-hangup-completes (E7 first clause, synthesized)', () => {
    it('turn completes on prompt:complete; the hangup-written session:end at idle is ignored', () => {
      const { state, effects } = reduceAll(loadFixture('pty-hangup-completes.jsonl'))

      // Exactly one completion for the turn — session:end after prompt:complete
      // (PTY hangup lets amplifier finish the turn, E7) never double-ends it.
      expect(kinds(effects)).toEqual(['session.identified', 'turn.began', 'turn.completed'])
      expect(state.phase).toBe('idle')
      expect(state.degraded).toBe(false)
    })

    it('the session:end record itself emits no effects (turn already idle)', () => {
      const records = loadFixture('pty-hangup-completes.jsonl')
      const endIndex = records.findIndex((r) => r.event === 'session:end')
      const completeIndex = records.findIndex((r) => r.event === 'prompt:complete')
      expect(endIndex).toBeGreaterThan(completeIndex)

      let state = createAmplifierReducerState()
      for (const [index, rec] of records.entries()) {
        const result = reduceAmplifierEvent(state, rec)
        state = result.state
        if (index === endIndex) {
          expect(result.effects).toEqual([])
        }
      }
    })
  })

  describe('fixture: tool-turn-out-of-order-end (E3)', () => {
    it('tool loop provider:request iterations stay one turn; post-complete records never re-busy', () => {
      const { state, effects } = reduceAll(loadFixture('tool-turn-out-of-order-end.jsonl'))

      expect(kinds(effects)).toEqual(['session.identified', 'turn.began', 'turn.completed'])
      expect(state.phase).toBe('idle')
    })

    it('stays idle across post-complete llm:request, provider:retry and out-of-order session:end tail', () => {
      const records = loadFixture('tool-turn-out-of-order-end.jsonl')
      const completeIndex = records.findIndex((r) => r.event === 'prompt:complete')

      let state = createAmplifierReducerState()
      for (const [index, rec] of records.entries()) {
        const result = reduceAmplifierEvent(state, rec)
        state = result.state
        if (index > completeIndex) {
          expect(state.phase).toBe('idle')
          expect(result.effects).toEqual([])
        }
      }
    })
  })

  describe('fixture: kill9-orphan (E6)', () => {
    it('ends busy with no turn.completed when the file dies at tool:pre', () => {
      const { state, effects } = reduceAll(loadFixture('kill9-orphan.jsonl'))

      expect(kinds(effects)).toEqual(['session.identified', 'turn.began'])
      expect(state.phase).toBe('busy')
    })
  })

  describe('fixture: resume-append (E7)', () => {
    it('session:resume causes no phase change; one full turn; duplicate session:end records emit nothing extra', () => {
      const records = loadFixture('resume-append.jsonl')
      expect(records[0]?.event).toBe('session:resume')

      const first = reduceAmplifierEvent(createAmplifierReducerState(), records[0])
      expect(first.state.phase).toBe('idle')
      expect(first.effects).toEqual([])

      const { state, effects } = reduceAll(records)
      expect(kinds(effects)).toEqual(['session.identified', 'turn.began', 'turn.completed'])
      expect(state.phase).toBe('idle')
    })

    it('session:resume while busy does not change phase', () => {
      const busy = reduceAll([record({ event: 'prompt:submit' })]).state
      expect(busy.phase).toBe('busy')

      const result = reduceAmplifierEvent(busy, record({ event: 'session:resume' }))
      expect(result.state.phase).toBe('busy')
      expect(result.effects).toEqual([])
    })
  })

  describe('fixture: steering-injection (E5)', () => {
    it('orchestrator:steering_injected stays inside a single submit/complete pair', () => {
      const records = loadFixture('steering-injection.jsonl')
      expect(records.some((r) => r.event === 'orchestrator:steering_injected')).toBe(true)

      const { state, effects } = reduceAll(records)
      expect(kinds(effects)).toEqual(['session.identified', 'turn.began', 'turn.completed'])
      expect(state.phase).toBe('idle')
    })
  })

  describe('fixture: continue-attach-orphan-end (E7)', () => {
    it('orphan session:end with no start/resume is a legal no-op from idle', () => {
      const { state, effects } = reduceAll(loadFixture('continue-attach-orphan-end.jsonl'))
      expect(effects).toEqual([])
      expect(state.phase).toBe('idle')
      expect(state.degraded).toBe(false)
    })
  })

  describe('transition table (§6)', () => {
    it('prompt:submit is the only record input that enters busy', () => {
      const nonSubmit = [
        'session:start',
        'session:config',
        'session:resume',
        'execution:start',
        'provider:request',
        'llm:request',
        'llm:response',
        'tool:pre',
        'tool:post',
        'orchestrator:steering_injected',
        'content_block:start',
        'cleanup:finally_begin',
      ]
      let state = createAmplifierReducerState()
      for (const event of nonSubmit) {
        state = reduceAmplifierEvent(state, record({ event })).state
        expect(state.phase).toBe('idle')
      }

      const result = reduceAmplifierEvent(state, record({ event: 'prompt:submit' }))
      expect(result.state.phase).toBe('busy')
      expect(kinds(result.effects)).toEqual(['turn.began'])
    })

    it('prompt:submit while busy stays busy without a second turn.began', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const result = reduceAmplifierEvent(busy, record({ event: 'prompt:submit' }))
      expect(result.state.phase).toBe('busy')
      expect(result.effects).toEqual([])
    })

    it('session:end while busy goes idle and emits turn.completed (PTY hangup / quit mid-turn)', () => {
      const { state, effects } = reduceAll([
        record({ event: 'session:start' }),
        record({ event: 'prompt:submit' }),
        record({ event: 'session:end' }),
      ])
      expect(kinds(effects)).toEqual(['turn.began', 'turn.completed'])
      expect(state.phase).toBe('idle')
    })

    it('prompt:complete while idle is ignored (any non-prompt:submit record at idle)', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:complete' }))
      expect(result.state.phase).toBe('idle')
      expect(result.effects).toEqual([])
    })

    it('turn effects carry the record ts through (at), never used for ordering', () => {
      const submit = reduceAmplifierEvent(
        createAmplifierReducerState(),
        record({ event: 'prompt:submit', ts: '2026-07-08T15:50:50.768798476+00:00' }),
      )
      expect(submit.effects).toEqual([
        { kind: 'turn.began', at: '2026-07-08T15:50:50.768798476+00:00' },
      ])

      // Completion record whose ts predates the submit: still completes (keyed on type, E3).
      const complete = reduceAmplifierEvent(
        submit.state,
        record({ event: 'prompt:complete', ts: '2026-07-08T15:50:40.000000000+00:00' }),
      )
      expect(complete.state.phase).toBe('idle')
      expect(complete.effects).toEqual([
        { kind: 'turn.completed', at: '2026-07-08T15:50:40.000000000+00:00' },
      ])
    })
  })

  describe('subagent indicators', () => {
    it('session:start with parent_id set marks subagent, no phase change, no effects', () => {
      const result = reduceAmplifierEvent(
        createAmplifierReducerState(),
        record({ event: 'session:start', data: { parent_id: 'parent-session-id' } }),
      )
      expect(result.state.subagent).toBe(true)
      expect(result.state.phase).toBe('idle')
      expect(result.effects).toEqual([])
    })

    it('session:fork marks subagent, no phase change, no effects', () => {
      const busy = reduceAmplifierEvent(createAmplifierReducerState(), record({ event: 'prompt:submit' })).state
      const result = reduceAmplifierEvent(busy, record({ event: 'session:fork' }))
      expect(result.state.subagent).toBe(true)
      expect(result.state.phase).toBe('busy')
      expect(result.effects).toEqual([])
    })

    it('top-level session:start (parent_id null) does not mark subagent', () => {
      const result = reduceAmplifierEvent(
        createAmplifierReducerState(),
        record({ event: 'session:start', data: { parent_id: null } }),
      )
      expect(result.state.subagent).toBe(false)
    })
  })

  describe('session.identified (§5 step 4)', () => {
    it('prefers working_dir, falls back to project_dir', () => {
      const withBoth = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'session:config',
        data: { parent_id: null, raw: { project_dir: '/tmp/proj', working_dir: '/tmp/work' } },
      }))
      expect(withBoth.effects).toEqual([
        { kind: 'session.identified', sessionId: 'test-session', cwd: '/tmp/work' },
      ])

      const projectOnly = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'session:config',
        data: { parent_id: null, raw: { project_dir: '/tmp/proj' } },
      }))
      expect(projectOnly.effects).toEqual([
        { kind: 'session.identified', sessionId: 'test-session', cwd: '/tmp/proj' },
      ])
    })

    it('session:config without project_dir/working_dir emits nothing', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'session:config',
        data: { parent_id: null, raw: {} },
      }))
      expect(result.effects).toEqual([])
    })
  })

  describe('schema gate (E10)', () => {
    it('degrades on schema name mismatch', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'session:start',
        schema: { name: 'other.log', ver: '1.0.0' },
      }))
      expect(result.state.degraded).toBe(true)
      expect(result.effects).toEqual([
        { kind: 'lane.degrade', reason: 'schema_name_mismatch' },
      ])
    })

    it('degrades on unsupported major version', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'session:start',
        schema: { name: 'amplifier.log', ver: '2.0.0' },
      }))
      expect(result.state.degraded).toBe(true)
      expect(result.effects).toEqual([
        { kind: 'lane.degrade', reason: 'schema_version_unsupported' },
      ])
    })

    it('degrades on missing schema', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), {
        event: 'prompt:submit',
        session_id: 'test-session',
      })
      expect(result.state.degraded).toBe(true)
      expect(result.effects).toEqual([
        { kind: 'lane.degrade', reason: 'schema_missing' },
      ])
    })

    it('accepts any 1.x version (major-version gate)', () => {
      const result = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'prompt:submit',
        schema: { name: 'amplifier.log', ver: '1.4.2' },
      }))
      expect(result.state.degraded).toBe(false)
      expect(result.state.phase).toBe('busy')
    })

    it('degrade is sticky: further records are ignored with no effects', () => {
      const degraded = reduceAmplifierEvent(createAmplifierReducerState(), record({
        event: 'session:start',
        schema: { name: 'amplifier.log', ver: '2.0.0' },
      })).state

      const result = reduceAmplifierEvent(degraded, record({ event: 'prompt:submit' }))
      expect(result.state).toEqual(degraded)
      expect(result.effects).toEqual([])
    })
  })
})
