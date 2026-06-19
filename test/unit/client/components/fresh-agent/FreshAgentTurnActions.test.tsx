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
