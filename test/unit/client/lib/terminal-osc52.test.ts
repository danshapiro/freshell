import { describe, expect, it } from 'vitest'
import {
  createOsc52ParserState,
  extractOsc52Events,
  shouldAllowOsc52ClipboardWrite,
  shouldAllowOsc52Prompt,
} from '@/lib/terminal-osc52'
import { beginTerminalOutputWriteScope } from '@/lib/terminal-output-write-scope'

describe('terminal-osc52', () => {
  it('extracts OSC52 payload and returns cleaned output', () => {
    const input = `hello\u001b]52;c;${Buffer.from('copy', 'utf8').toString('base64')}\u0007world`
    const result = extractOsc52Events(input, createOsc52ParserState())

    expect(result.cleaned).toBe('helloworld')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.text).toBe('copy')
  })

  it('supports ST terminator', () => {
    const input = `a\u001b]52;c;${Buffer.from('clip', 'utf8').toString('base64')}\u001b\\b`
    const result = extractOsc52Events(input, createOsc52ParserState())

    expect(result.cleaned).toBe('ab')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.text).toBe('clip')
  })

  it('preserves non-OSC52 output', () => {
    const input = 'prefix\u001b]0;Window title\u0007suffix'
    const result = extractOsc52Events(input, createOsc52ParserState())

    expect(result.cleaned).toBe(input)
    expect(result.events).toEqual([])
  })

  it('handles chunked OSC52 sequences', () => {
    const state = createOsc52ParserState()
    const first = extractOsc52Events(`one\u001b]52;c;${Buffer.from('copy', 'utf8').toString('base64').slice(0, 4)}`, state)

    expect(first.cleaned).toBe('one')
    expect(first.events).toEqual([])

    const second = extractOsc52Events(`${Buffer.from('copy', 'utf8').toString('base64').slice(4)}\u0007two`, state)
    expect(second.cleaned).toBe('two')
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.text).toBe('copy')
  })

  it('strips invalid OSC52 payloads without emitting events', () => {
    const input = 'a\u001b]52;c;@@@\u0007b'
    const result = extractOsc52Events(input, createOsc52ParserState())

    expect(result.cleaned).toBe('ab')
    expect(result.events).toEqual([])
  })

  it('suppresses always-policy clipboard writes while the submitted write scope is replay', () => {
    const replayScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-osc52',
      source: 'replay',
      attachRequestId: 'attach-1',
      generation: 'attach-1',
      suppressExternalSideEffects: true,
    })

    expect(shouldAllowOsc52ClipboardWrite({
      terminalInstanceId: 'surface-osc52',
      mode: 'shell',
    })).toBe(false)
    expect(shouldAllowOsc52Prompt({
      terminalInstanceId: 'surface-osc52',
      mode: 'shell',
    })).toBe(false)
    replayScope.complete()

    const liveScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-osc52',
      source: 'live',
      attachRequestId: 'attach-2',
      generation: 'attach-2',
      suppressExternalSideEffects: false,
    })

    expect(shouldAllowOsc52ClipboardWrite({
      terminalInstanceId: 'surface-osc52',
      mode: 'shell',
    })).toBe(true)
    expect(shouldAllowOsc52Prompt({
      terminalInstanceId: 'surface-osc52',
      mode: 'shell',
    })).toBe(true)
    liveScope.complete()
  })
})
