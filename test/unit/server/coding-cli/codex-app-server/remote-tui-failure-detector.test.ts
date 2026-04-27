import { describe, expect, it } from 'vitest'
import {
  CodexRemoteTuiFailureDetector,
  detectCodexRemoteTuiFailure,
} from '../../../../../server/coding-cli/codex-app-server/remote-tui-failure-detector.js'

describe('Codex remote TUI failure detector', () => {
  it.each([
    'ERROR: remote app server at `ws://127.0.0.1:34025/` transport failed: WebSocket protocol error: Connection reset without closing handshake',
    'app-server event stream disconnected: channel closed',
    'Failed to attach to resumed app-server thread: thread is not yet available for replay or live attach.',
  ])('detects known remote TUI fatal output: %s', (line) => {
    expect(detectCodexRemoteTuiFailure(line)).toEqual(expect.objectContaining({
      fatal: true,
    }))
  })

  it('does not treat ordinary output as fatal', () => {
    expect(detectCodexRemoteTuiFailure('working on it')).toEqual({ fatal: false })
  })

  it('detects fatal output split across chunks with ANSI control sequences', () => {
    const detector = new CodexRemoteTuiFailureDetector()

    expect(detector.push('\u001b[31mERROR: remote app server at `ws://127.0.0.1:34025/` transport')).toEqual({ fatal: false })
    expect(detector.push(' failed: WebSocket protocol error: Connection reset without closing handshake\u001b[0m\n')).toEqual(expect.objectContaining({
      fatal: true,
    }))
  })
})
