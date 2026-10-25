// Model-wire fixture only: all app-server events originate in the release CLI.
import http from 'node:http'
import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

export const MCP_LARGE_TEXT = 'F1_MCP_HEAD\n' + 'm'.repeat(128 * 1024) + '\nF1_MCP_TAIL'
export const MCP_FORM_CONTENT = { name: 'fixture', count: 2.5, enabled: true, color: 'blue' }
export const CODEX_NETWORK_REQUIREMENTS = '[experimental_network]\nenabled = true\nallow_local_binding = true\nallow_upstream_proxy = false\n'
const FORM_SCHEMA = { type: 'object', properties: { name: { type: 'string', title: 'Name' }, count: { type: 'number', title: 'Count' }, enabled: { type: 'boolean', title: 'Enabled' }, color: { type: 'string', title: 'Color', enum: ['blue', 'green'] } }, required: ['name', 'count', 'enabled', 'color'] }

function serveMcpFixture(tracePath, url, holdStartup = false) {
  const pending = new Map()
  let nextId = 1
  const trace = record => fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  const send = frame => { trace({ direction: 'server', frame }); process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`) }
  const request = (method, params) => {
    const number = nextId++
    const id = number % 2 ? number : `mcp-${number}`
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }) })
  }
  const handle = async frame => {
    trace({ direction: 'native', frame })
    if (!frame.method && frame.id !== undefined) {
      const waiter = pending.get(frame.id)
      if (waiter) { pending.delete(frame.id); if (frame.error) waiter.reject(new Error(frame.error.message)); else waiter.resolve(frame.result) }
      return
    }
    if (frame.method === 'notifications/cancelled') {
      for (const [id, waiter] of pending) { pending.delete(id); waiter.resolve({ action: 'cancel', cancelledByNative: true }) }
      return
    }
    if (frame.id === undefined) return
    if (frame.method === 'initialize' && holdStartup) { trace({ event: 'startup_initialize_held', id: frame.id }); return }
    if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'freshell-contract', version: '1' } } })
    else if (frame.method === 'ping') send({ id: frame.id, result: {} })
    else if (frame.method === 'tools/list') send({ id: frame.id, result: { tools: [{ name: 'large_result', description: 'Return a bounded native persistence fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } }, { name: 'elicit', description: 'Run the selected native elicitation fixture.', inputSchema: { type: 'object', properties: { route: { type: 'string', enum: ['form', 'openai/form', 'openaiForm', 'url'] }, sequence: { type: 'string', enum: ['matrix', 'hold'] } }, required: ['route', 'sequence'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } }] } })
    else if (frame.method === 'tools/call' && frame.params.name === 'large_result') {
      send({ id: frame.id, result: { content: [{ type: 'text', text: MCP_LARGE_TEXT }], structuredContent: { fixture: 'F1_MCP_STRUCTURED', count: 1 }, isError: false, _meta: { 'fixture/result': 'F1_MCP_META' } } })
    }
    else if (frame.method === 'tools/call') {
      const { route, sequence } = frame.params.arguments
      const results = []
      for (const action of sequence === 'hold' ? ['cancel'] : ['accept', 'decline', 'cancel']) {
        const method = route === 'openai/form' ? 'openai/form' : route === 'openaiForm' ? 'openai/elicitation/create' : 'elicitation/create'
        const params = route === 'url' ? { mode: 'url', message: 'Open the fixture page, then choose an action.', url: `${url}/elicitation/example`, elicitationId: `fixture-url-${nextId}` } : { ...(route === 'openai/form' ? {} : { mode: 'form' }), message: 'Fixture form', requestedSchema: FORM_SCHEMA }
        const result = await request(method, params)
        trace({ event: 'elicitation_result', route, sequence, expectedAction: action, result })
        if (result.action !== action) throw new Error(`MCP route ${route} returned the wrong action`)
        if (action === 'accept' && route !== 'url') assert.deepEqual(result.content, MCP_FORM_CONTENT, 'MCP form content must preserve typed native answers')
        results.push(result)
      }
      send({ id: frame.id, result: { content: [{ type: 'text', text: 'Fixture sequence completed' }], isError: false } })
    } else send({ id: frame.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
  createInterface({ input: process.stdin }).on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    handle(frame).catch(error => {
      trace({ event: frame.params?.arguments?.sequence === 'hold' ? 'fixture_request_cancelled' : 'fixture_error', message: error.message })
      if (frame.id !== undefined) send({ id: frame.id, error: { code: -32603, message: error.message } })
    })
  })
}

export async function createCodexLocalProvider(handler) {
  const traffic = []
  let sequence = 0
  const sockets = new Set()
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const parsed = body ? JSON.parse(body) : null
      const record = { index: traffic.length, method: request.method, path: request.url, loopback: request.socket.remoteAddress === '127.0.0.1', body: parsed }
      traffic.push(record)
      if (request.method !== 'POST' || request.url !== '/v1/responses' || !record.loopback) {
        response.writeHead(404).end(); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const emit = (type, fields = {}) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`)
      const id = `resp_contract_${record.index}`
      const base = { id, object: 'response', created_at: 1, status: 'in_progress', output: [] }
      emit('response.created', { response: base })
      const plan = await handler(record, { emit, response })
      if (!plan || response.destroyed || response.writableEnded) return
      const items = plan.items ?? [{ id: `msg_contract_${record.index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: plan.text ?? 'First fragment and final fragment', annotations: [] }] }]
      for (let outputIndex = 0; outputIndex < items.length; outputIndex++) {
        const item = items[outputIndex]
        emit('response.output_item.added', { output_index: outputIndex, item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : { ...item, arguments: '' } })
        if (item.type === 'message') {
          for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
            const content = item.content[contentIndex]
            emit('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { ...content, text: '' } })
            for (const delta of plan.deltas ?? [content.text.slice(0, 14), content.text.slice(14)]) {
              emit('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta })
            }
            if (plan.pauseAfterDelta) await plan.pauseAfterDelta()
            if (response.destroyed) return
            emit('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: content.text })
            emit('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: content })
          }
        } else if (item.type === 'function_call') {
          emit('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments })
          emit('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments })
        }
        emit('response.output_item.done', { output_index: outputIndex, item })
      }
      emit('response.completed', { response: { ...base, status: 'completed', output: items, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } })
      response.end()
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, traffic,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && ['--mcp-fixture', '--mcp-startup-fixture'].includes(process.argv[2])) serveMcpFixture(process.argv[3], process.argv[4], process.argv[2] === '--mcp-startup-fixture')
