import { nativeProtocolRequest } from './native-protocol.js'
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

it('preserves a native denied tool result before system init and its successful terminal result as distinct evidence', async () => {
  const child = spawn(process.execPath, [resolve('crates/freshell-claude-sidecar/index.mjs')], {
    env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: resolve('test/unit/claude-sidecar/fixtures/native-result-query.mjs') }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
  const frames: any[] = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n')
      frames.push(JSON.parse(buffer.slice(0, boundary)))
      buffer = buffer.slice(boundary + 1)
    }
  })
  const send = (value: unknown) => child.stdin.write(JSON.stringify(nativeProtocolRequest(value)) + '\n')
  const wait = async (type: string) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const frame = frames.find((frame) => frame.type === type)
      if (frame) return frame
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`missing ${type}`)
  }
  try {
    send({ type: 'create', requestId: 'result-create' })
    const created = await wait('created')
    send({ type: 'send', sessionId: created.sessionId, text: 'controlled-result' })
    const result = await wait('sdk.result')
    const toolResult = frames.find((frame) => frame.type === 'sdk.tool.result')
    expect(toolResult?.nativeSessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(toolResult?.uuid).toBe('native-user-uuid')
    expect(toolResult?.content[0]).toMatchObject({ tool_use_id: 'toolu-original', is_error: true })
    const init = frames.find((frame) => frame.type === 'sdk.session.init')
    expect(init).toMatchObject({ cliSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cliVersion: '2.1.237' })
    expect(frames.indexOf(toolResult)).toBeLessThan(frames.indexOf(init))
    expect(result).toMatchObject({ result: 'success', nativeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', uuid: 'native-result-uuid', isError: false, stopReason: 'end_turn', permissionDenials: [{ tool_use_id: 'toolu-original' }] })
    expect(frames.indexOf(toolResult)).toBeLessThan(frames.indexOf(result))
  } finally { send({ type: 'shutdown' }); await exited }
})
