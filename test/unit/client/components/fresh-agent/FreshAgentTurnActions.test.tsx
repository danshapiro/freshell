import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  buildTurnActionItems,
  FreshAgentTurnActions,
} from '@/components/fresh-agent/FreshAgentTurnActions'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(true),
}))

afterEach(() => cleanup())

function codexDisplayTurn(): FreshAgentTurn {
  return {
    id: 'codex-native-turn-1',
    turnId: 'codex-display:v1:opaque-user-row',
    role: 'assistant',
    summary: 'answer',
    items: [{ id: 'text-1', kind: 'text', text: 'done' }],
  }
}

describe('FreshAgentTurnActions', () => {
  it('passes the opaque display turn id to action callbacks', () => {
    const onForkFromTurn = vi.fn()
    const items = buildTurnActionItems(codexDisplayTurn(), {
      canFork: true,
      onForkFromTurn,
    })

    items.find((item) => item.label === 'Fork conversation from here')?.run()

    expect(onForkFromTurn).toHaveBeenCalledWith('codex-display:v1:opaque-user-row')
  })

  it('uses the display turn id from the hover toolbar', () => {
    const onForkFromTurn = vi.fn()
    render(
      <FreshAgentTurnActions
        turn={codexDisplayTurn()}
        canFork
        onForkFromTurn={onForkFromTurn}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Fork conversation from here' }))

    expect(onForkFromTurn).toHaveBeenCalledWith('codex-display:v1:opaque-user-row')
  })
})

describe('rollback affordance (kata 1wxv decisions 3, 8)', () => {
  function userTurn(): FreshAgentTurn {
    return {
      id: 'u2',
      turnId: 'u2',
      role: 'user',
      summary: 'prompt two',
      items: [{ id: 'i1', kind: 'text', text: 'prompt two' }],
    }
  }

  it('Undo to here runs the callback with the opaque display turn id', () => {
    const onRollbackToTurn = vi.fn()
    const items = buildTurnActionItems(userTurn(), { canFork: true, canRollback: true, onRollbackToTurn })

    const undo = items.find((i) => i.label === 'Undo to here')
    expect(undo?.disabled).toBe(false)
    undo?.run()

    expect(onRollbackToTurn).toHaveBeenCalledWith('u2')
  })

  it('is disabled for non-user turns and when busy, hidden when unsupported', () => {
    const assistant = { ...userTurn(), role: 'assistant' as const }
    const cb = { canFork: true, canRollback: true, onRollbackToTurn: vi.fn() }

    expect(buildTurnActionItems(assistant, cb).find((i) => i.label === 'Undo to here')?.disabled).toBe(true)
    expect(buildTurnActionItems(userTurn(), { ...cb, rollbackBusy: true }).find((i) => i.label === 'Undo to here')?.disabled).toBe(true)
    expect(buildTurnActionItems(userTurn(), { canFork: true, canRollback: false }).find((i) => i.label === 'Undo to here')?.disabled).toBe(true)
  })

  it('the hover toolbar renders the rollback icon beside the fork icon with a step-naming tooltip', () => {
    render(
      <FreshAgentTurnActions
        turn={userTurn()}
        canFork
        onForkFromTurn={() => {}}
        canRollback
        onRollbackToTurn={() => {}}
      />,
    )

    const button = screen.getByRole('button', { name: 'Undo to here' })
    expect(button).toHaveAttribute('title', expect.stringContaining('prompt two'))
  })

  it('hides the toolbar rollback icon entirely when the capability stamp is absent', () => {
    render(
      <FreshAgentTurnActions
        turn={userTurn()}
        canFork
        onForkFromTurn={() => {}}
        onRollbackToTurn={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Undo to here' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fork conversation from here' })).toBeInTheDocument()
  })
})
