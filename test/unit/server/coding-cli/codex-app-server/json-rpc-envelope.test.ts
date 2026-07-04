import { describe, expect, it, vi } from 'vitest'

import {
  MAX_SCANNED_TOKEN_BYTES,
  scanJsonRpcEnvelope,
} from '../../../../../server/coding-cli/codex-app-server/json-rpc-envelope.js'

function slicedArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

function expectedJsonRpcEnvelope(json: string): { id?: string | number; method?: string } {
  const parsed = JSON.parse(json) as { id?: unknown; method?: unknown }
  const expected: { id?: string | number; method?: string } = {}
  if (typeof parsed.id === 'string' || (typeof parsed.id === 'number' && Number.isInteger(parsed.id))) {
    expected.id = parsed.id
  }
  if (typeof parsed.method === 'string') {
    expected.method = parsed.method
  }
  return expected
}

describe('scanJsonRpcEnvelope', () => {
  it('extracts top-level method and string or integer ids regardless of field order', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"jsonrpc":"2.0","id":"abc","method":"turn/start","params":{}}'))).toEqual({
      ok: true,
      root: 'object',
      id: 'abc',
      method: 'turn/start',
      duplicateTopLevelKeys: [],
    })

    expect(scanJsonRpcEnvelope('{"params":{},"method":"thread/fork","id":7}')).toEqual({
      ok: true,
      root: 'object',
      id: 7,
      method: 'thread/fork',
      duplicateTopLevelKeys: [],
    })

    expect(scanJsonRpcEnvelope('{"method":"initialize","params":{},"id":-12}')).toEqual({
      ok: true,
      root: 'object',
      id: -12,
      method: 'initialize',
      duplicateTopLevelKeys: [],
    })
  })

  it('uses only top-level ids even when nested ids appear first or after large results', () => {
    const largeResult = 'x'.repeat(128 * 1024)
    expect(scanJsonRpcEnvelope(Buffer.from(`{"result":{"id":"nested-before"},"params":{"id":"nested-param"},"id":"top","method":"turn/start"}`))).toMatchObject({
      ok: true,
      id: 'top',
      method: 'turn/start',
    })
    expect(scanJsonRpcEnvelope(Buffer.from(`{"result":{"payload":"${largeResult}"},"id":42}`))).toMatchObject({
      ok: true,
      id: 42,
    })
  })

  it('skips adversarially deep nested values without overflowing the call stack', () => {
    const depth = 20_000
    const nestedResult = `${'['.repeat(depth)}0${']'.repeat(depth)}`
    expect(scanJsonRpcEnvelope(Buffer.from(`{"result":${nestedResult},"id":"deep","method":"turn/start"}`))).toEqual({
      ok: true,
      root: 'object',
      id: 'deep',
      method: 'turn/start',
      duplicateTopLevelKeys: [],
    })
  })

  it('decodes escaped top-level property names and escaped string values', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"meth\\u006fd":"turn\\/start","\\u0069d":"request-1"}'))).toEqual({
      ok: true,
      root: 'object',
      id: 'request-1',
      method: 'turn/start',
      duplicateTopLevelKeys: [],
    })
  })

  it('reports duplicate top-level keys while matching bounded JSON.parse last-wins semantics', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"id":1,"method":"initialize","id":2,"method":"turn/start"}'))).toEqual({
      ok: true,
      root: 'object',
      id: 2,
      method: 'turn/start',
      duplicateTopLevelKeys: ['id', 'method'],
    })

    expect(scanJsonRpcEnvelope(Buffer.from('{"\\u0069d":1,"id":null,"meth\\u006fd":false,"method":"turn/start"}'))).toEqual({
      ok: true,
      root: 'object',
      method: 'turn/start',
      duplicateTopLevelKeys: ['id', 'method'],
    })
  })

  it('ignores invalid JSON-RPC id types without coercion', () => {
    for (const id of ['null', '1.25', 'true', '{"nested":1}', '[1]']) {
      expect(scanJsonRpcEnvelope(Buffer.from(`{"id":${id},"method":"initialize"}`))).toEqual({
        ok: true,
        root: 'object',
        method: 'initialize',
        duplicateTopLevelKeys: [],
      })
    }
  })

  it('matches JS number parsing for bounded large integer ids', () => {
    for (const id of ['999999999999999999999', '9223372036854775807']) {
      const expectedId = Number(id)
      expect(scanJsonRpcEnvelope(Buffer.from(`{"id":${id},"method":"initialize"}`))).toEqual({
        ok: true,
        root: 'object',
        id: expectedId,
        method: 'initialize',
        duplicateTopLevelKeys: [],
      })
    }
  })

  it('accepts Buffer, Buffer array, ArrayBuffer, and string inputs', () => {
    const json = '{"id":9,"method":"initialize"}'
    for (const input of [
      Buffer.from(json),
      [Buffer.from('{"id":'), Buffer.from('9,"method":"initialize"}')],
      slicedArrayBuffer(json),
      json,
    ]) {
      expect(scanJsonRpcEnvelope(input)).toMatchObject({ ok: true, id: 9, method: 'initialize' })
    }
  })

  it('classifies root arrays as unsupported batches, not non-state traffic', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('[{"id":1,"method":"thread/fork","params":{"threadId":"parent"}}]'))).toEqual({
      ok: false,
      reason: 'batch_unsupported',
    })
  })

  it('classifies malformed JSON and scalar roots as unsafe', () => {
    expect(scanJsonRpcEnvelope(Buffer.from('{"id":1'))).toEqual({ ok: false, reason: 'malformed_json' })
    expect(scanJsonRpcEnvelope(Buffer.from('{"method":"bad\\q"}'))).toEqual({ ok: false, reason: 'malformed_json' })
    expect(scanJsonRpcEnvelope(Buffer.from('"not-an-object"'))).toEqual({ ok: false, reason: 'non_object_root' })
  })

  it('rejects overlarge top-level tokens that would need to be decoded', () => {
    const tooLargeMethod = 'x'.repeat(MAX_SCANNED_TOKEN_BYTES + 1)
    expect(scanJsonRpcEnvelope(Buffer.from(`{"id":1,"method":"${tooLargeMethod}"}`))).toEqual({
      ok: false,
      reason: 'token_too_large',
    })
  })

  it('does not use JSON.parse or Buffer.toString when scanning a large frame', () => {
    const largeResult = 'x'.repeat(256 * 1024)
    const raw = Buffer.from(`{"result":{"payload":"${largeResult}"},"id":42,"method":"turn/start"}`)
    const parseSpy = vi.spyOn(JSON, 'parse')
    const toStringSpy = vi.spyOn(Buffer.prototype, 'toString')

    const result = scanJsonRpcEnvelope(raw)
    const parseCalls = parseSpy.mock.calls.length
    const toStringCalls = toStringSpy.mock.calls.length
    parseSpy.mockRestore()
    toStringSpy.mockRestore()

    expect(result).toEqual({
      ok: true,
      root: 'object',
      id: 42,
      method: 'turn/start',
      duplicateTopLevelKeys: [],
    })
    expect(parseCalls).toBe(0)
    expect(toStringCalls).toBe(0)
  })

  it('matches bounded JSON.parse semantics for a deterministic corpus of top-level envelopes', () => {
    const random = seededRandom(0xc0de)
    const keySources = {
      id: ['"id"', '"\\u0069d"'],
      method: ['"method"', '"meth\\u006fd"'],
      params: ['"params"'],
      result: ['"result"'],
      other: ['"jsonrpc"', '"meta"', '"nested"'],
    } as const
    const idValues = ['0', '1', '-2', '"request-1"', '"escaped\\\\id"', 'null', 'false', '1.25', '{"id":"nested"}', '[1]']
    const methodValues = ['"initialize"', '"turn\\/start"', '"thread/fork"', 'null', 'true', '7', '{"name":"nested"}']
    const nestedValues = [
      '{"id":"nested","method":"nested/method"}',
      '{"items":[{"id":1},{"method":"ignored"}]}',
      '["id","method",{"id":"array-nested"}]',
    ]

    for (let index = 0; index < 96; index += 1) {
      const entries: string[] = []
      const entryCount = 5 + Math.floor(random() * 5)
      for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
        const slot = pick(random, ['id', 'method', 'params', 'result', 'other'] as const)
        if (slot === 'id') {
          entries.push(`${pick(random, keySources.id)}:${pick(random, idValues)}`)
        } else if (slot === 'method') {
          entries.push(`${pick(random, keySources.method)}:${pick(random, methodValues)}`)
        } else if (slot === 'params') {
          entries.push(`${pick(random, keySources.params)}:${pick(random, nestedValues)}`)
        } else if (slot === 'result') {
          entries.push(`${pick(random, keySources.result)}:${pick(random, nestedValues)}`)
        } else {
          entries.push(`${pick(random, keySources.other)}:${pick(random, ['"2.0"', '{"id":"not-top"}', '3'])}`)
        }
      }

      const json = `{${entries.join(',')}}`
      const expected = expectedJsonRpcEnvelope(json)
      const result = scanJsonRpcEnvelope(Buffer.from(json))

      expect(result).toMatchObject({ ok: true, root: 'object' })
      if (!result.ok) return
      expect({ id: result.id, method: result.method }).toEqual({
        id: expected.id,
        method: expected.method,
      })
    }
  })
})
