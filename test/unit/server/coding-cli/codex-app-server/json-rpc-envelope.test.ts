import { describe, expect, it } from 'vitest'

import { scanJsonRpcEnvelope } from '../../../../../server/coding-cli/codex-app-server/json-rpc-envelope.js'

function slicedArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
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
    expect(scanJsonRpcEnvelope(Buffer.from('"not-an-object"'))).toEqual({ ok: false, reason: 'non_object_root' })
  })
})
