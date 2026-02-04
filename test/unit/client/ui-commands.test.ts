import { describe, it, expect } from 'vitest'
import { handleUiCommand } from '../../../src/lib/ui-commands'

const dispatch = (action: any) => action

describe('handleUiCommand', () => {
  it('handles tab.create', () => {
    const action = handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't1', title: 'Alpha' } }, dispatch)
    expect(action.type).toBe('tabs/addTab')
  })
})
