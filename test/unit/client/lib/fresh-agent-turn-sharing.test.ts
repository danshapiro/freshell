import { describe, expect, it } from 'vitest'
import type { FreshAgentSnapshot, FreshAgentTurn } from '@shared/fresh-agent-contract'
import { shareUnchangedTurns, withSharedTurns } from '@/lib/fresh-agent-turn-sharing'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function text(id: string, value: string): FreshAgentTurn {
  return { id, turnId: id, role: 'assistant', summary: value, items: [{ id: `${id}-text`, kind: 'text', text: value }] }
}

const tool = (id: string, status: 'running' | 'completed'): FreshAgentTurn => ({
  id,
  turnId: id,
  role: 'assistant',
  summary: '',
  items: [
    { id: `${id}-note`, kind: 'text', text: 'Running the tests' },
    { id: `${id}-tool`, kind: 'tool_use', toolUseId: `toolu_${id}`, name: 'Bash', input: { command: 'pnpm test', nested: { flags: ['-v'] } }, ...(status === 'completed' ? { status } : {}) } as never,
  ],
})

describe('shareUnchangedTurns', () => {
  it('hands back the previous list itself when a fresh parse holds the same turns', () => {
    const previous = [text('a', 'one'), tool('b', 'running')]
    expect(shareUnchangedTurns(previous, clone(previous))).toBe(previous)
  })

  it('keeps every unchanged turn object and takes the changed and new ones', () => {
    const previous = [text('a', 'one'), text('b', 'two')]
    const next = [clone(previous[0]), text('b', 'two, edited'), text('c', 'three')]
    const shared = shareUnchangedTurns(previous, next)
    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).toEqual(next[1])
    expect(shared[1]).not.toBe(previous[1])
    expect(shared[2]).toBe(next[2])
  })

  it('keeps the unchanged items of a changed turn', () => {
    const previous = [tool('b', 'running')]
    const next = [tool('b', 'completed')]
    const [turn] = shareUnchangedTurns(previous, next)
    expect(turn).toEqual(next[0])
    expect(turn.items[0]).toBe(previous[0].items[0])
    expect(turn.items[1]).toBe(next[0].items[1])
  })

  it('tells apart values that differ only deep inside, in key sets, or in array length', () => {
    const base = tool('b', 'running')
    const deeper = clone(base)
    ;((deeper.items[1] as unknown as { input: { nested: { flags: string[] } } }).input.nested.flags).push('--watch')
    expect(shareUnchangedTurns([base], [deeper])[0].items[1]).not.toBe(base.items[1])

    const extraKey = clone(base)
    ;(extraKey as unknown as Record<string, unknown>).model = 'opus'
    expect(shareUnchangedTurns([base], [extraKey])[0]).not.toBe(base)

    const withNull = { ...clone(base), error: null } as unknown as FreshAgentTurn
    expect(shareUnchangedTurns([base], [withNull])[0]).not.toBe(base)
  })

  it('matches turns by id, not by position', () => {
    const previous = [text('a', 'one'), text('b', 'two')]
    const next = [clone(previous[1]), clone(previous[0])]
    const shared = shareUnchangedTurns(previous, next)
    expect(shared[0]).toBe(previous[1])
    expect(shared[1]).toBe(previous[0])
    expect(shared).not.toBe(previous)
  })
})

describe('withSharedTurns', () => {
  const snapshot = (turns: FreshAgentTurn[], revision: number) => ({ turns, revision }) as unknown as FreshAgentSnapshot

  it('is a new snapshot (its other fields may have changed) carrying the previous turns when they did not', () => {
    const previous = snapshot([text('a', 'one')], 1)
    const next = snapshot(clone(previous.turns), 2)
    const shared = withSharedTurns(previous, next)
    expect(shared).not.toBe(previous)
    expect(shared.revision).toBe(2)
    expect(shared.turns).toBe(previous.turns)
  })

  it('passes the snapshot through when there is nothing to share with', () => {
    const next = snapshot([text('a', 'one')], 1)
    expect(withSharedTurns(null, next)).toBe(next)
    expect(withSharedTurns(next, next)).toBe(next)
    const unrelated = snapshot([text('z', 'other')], 2)
    expect(withSharedTurns(next, unrelated)).toBe(unrelated)
  })
})
