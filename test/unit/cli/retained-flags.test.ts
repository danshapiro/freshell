// @vitest-environment node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const cliPath = resolve(process.cwd(), 'tools/freshell-cli/index.ts')
const tsxLoader = pathToFileURL(require.resolve('tsx')).href

async function invoke(args: string[]) {
  const requests: Array<{ url: string; body: unknown }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    requests.push({ url: request.url ?? '', body: text ? JSON.parse(text) : undefined })
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && request.url === '/api/tabs') {
      response.end(JSON.stringify({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' }))
    } else if (request.method === 'GET' && request.url === '/api/panes?tabId=t1') {
      response.end(JSON.stringify({ panes: [{ id: 'p1', index: 0, kind: 'terminal' }] }))
    } else {
      response.end(JSON.stringify({ status: 'ok', data: { tabId: 't1', paneId: 'p1' } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not listen')
  try {
    const child = spawn(process.execPath, ['--import', tsxLoader, cliPath, ...args], {
      env: { ...process.env, NODE_NO_WARNINGS: '1', FRESHELL_URL: `http://127.0.0.1:${address.port}`, FRESHELL_TOKEN: 'test-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const [code] = await once(child, 'close')
    return { code, stderr, requests }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

it.each(['--resume', '--resumeSessionId'])('resumes an OpenCode agent with %s and no terminal mode', async (flag) => {
  const result = await invoke(['new-tab', '--agent', 'opencode', flag, 'ses_existing'])
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  expect(result.requests).toEqual([{
    url: '/api/tabs',
    body: { agent: 'opencode', sessionRef: { provider: 'opencode', sessionId: 'ses_existing' } },
  }])
})

it.each(['new-tab', 'split-pane', 'respawn-pane'])('honors the advertised --sessionRef flag for %s', async (action) => {
  const result = await invoke([action, '--target', 'p1', '--mode', 'claude', '--sessionRef', 'claude:existing'])
  expect(result.code).toBe(0)
  expect(result.requests.at(-1)?.body).toMatchObject({ sessionRef: { provider: 'claude', sessionId: 'existing' } })
})

it('preserves explicit OpenCode session identity over resume sugar', async () => {
  const result = await invoke(['new-tab', '--agent', 'opencode', '--resume', 'ignored', '--session-ref', 'opencode:chosen'])
  expect(result.code).toBe(0)
  expect(result.requests.at(-1)?.body).toMatchObject({ sessionRef: { provider: 'opencode', sessionId: 'chosen' } })
})

it.each(['--session-ref', '--sessionRef'])('parses %s as an identity guard on send-keys', async (flag) => {
  const result = await invoke(['send-keys', '--target', 'p1', flag, 'claude:existing', '-l', 'hello'])
  expect(result.code).toBe(0)
  expect(result.requests.at(-1)?.body).toEqual({ data: 'hello', sessionRef: { provider: 'claude', sessionId: 'existing' } })
})

it('uses the advertised --with target when swapping panes', async () => {
  const result = await invoke(['swap-pane', '--target', 'p1', '--with', 'p2'])
  expect(result.code).toBe(0)
  expect(result.requests.at(-1)).toEqual({ url: '/api/panes/p1/swap', body: { target: 'p2', tabId: 't1' } })
})

it('passes advertised --sizes as a numeric pair to the resize endpoint', async () => {
  const result = await invoke(['resize-pane', '--target', 'p1', '--sizes', '[25,75]'])
  expect(result.code).toBe(0)
  expect(result.requests.at(-1)).toEqual({ url: '/api/panes/p1/resize', body: { tabId: 't1', sizes: [25, 75] } })
})

it.each(['no sizes', '{}', '[10]', '["bad",90]'])('rejects invalid resize --sizes %s without changing a pane', async (sizes) => {
  const result = await invoke(['resize-pane', '--target', 'p1', '--sizes', sizes])
  expect(result.code).toBe(1)
  expect(result.requests).toEqual([])
})

it('uses the advertised --keys string when sending a literal prompt', async () => {
  const result = await invoke(['send-keys', '--target', 'p1', '--keys', 'hello world', '--literal'])
  expect(result.code).toBe(0)
  expect(result.requests.at(-1)).toEqual({ url: '/api/panes/p1/send-keys', body: { data: 'hello world' } })
})
