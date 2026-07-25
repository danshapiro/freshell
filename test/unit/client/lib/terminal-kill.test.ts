import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendTerminalKill } from '@/lib/terminal-kill'
import {
  consumeTerminalReleaseMark,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

describe('sendTerminalKill', () => {
  beforeEach(() => {
    mockSend.mockClear()
    resetTerminalReleaseMarks()
  })

  it('sends the terminal.kill message', () => {
    sendTerminalKill('term-1')
    expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
  })

  it('marks the terminal released before sending', () => {
    sendTerminalKill('term-1')
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
  })
})
