// @vitest-environment node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  ACTION_CAPABILITIES,
  unsupportedInvocationResult,
  validateActionCapabilities,
} from '../../../tools/node-client-runtime/action-capabilities.js'

const require = createRequire(import.meta.url)
const cliPath = resolve(process.cwd(), 'tools/freshell-cli/index.ts')
const tsxLoader = pathToFileURL(require.resolve('tsx')).href
const capabilityFixture = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../fixtures/tools/rust-action-capability-matrix.json'),
  'utf8',
)) as {
  canonicalActions: number
  aliases: number
  unsupported: string[]
  acceptedNoOpCaptureParams: string[]
}

async function runCli(args: string[], url: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', tsxLoader, cliPath, ...args], {
    env: { ...process.env, NODE_NO_WARNINGS: '1', FRESHELL_URL: url, FRESHELL_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  // Wait for stdio to finish draining too; `exit` can arrive while buffered
  // stderr diagnostics are still being delivered to these listeners.
  const [code] = await once(child, 'close') as [number | null]
  return { code, stdout, stderr }
}

describe('standalone CLI capability contract', () => {
  it('contains precisely 33 unique canonical actions and 14 unique aliases', () => {
    validateActionCapabilities(ACTION_CAPABILITIES)
    expect(ACTION_CAPABILITIES).toHaveLength(capabilityFixture.canonicalActions)
    expect(ACTION_CAPABILITIES.flatMap((capability) => capability.aliases ?? [])).toHaveLength(capabilityFixture.aliases)
    expect(ACTION_CAPABILITIES.filter((capability) => !capability.supported).map((capability) => capability.action)).toEqual(
      capabilityFixture.unsupported,
    )
    expect(ACTION_CAPABILITIES.find((capability) => capability.action === 'capture-pane')?.params.optional).toEqual(
      expect.arrayContaining(capabilityFixture.acceptedNoOpCaptureParams),
    )
  })

  it('fails duplicate and unclassified capability entries at initialization', () => {
    expect(() => validateActionCapabilities([
      ...ACTION_CAPABILITIES.slice(0, 32),
      { ...ACTION_CAPABILITIES[32], action: 'new-tab' },
    ])).toThrow("Duplicate action or alias 'new-tab'")
    expect(() => validateActionCapabilities([
      ...ACTION_CAPABILITIES.slice(0, 32),
      { action: '', supported: true, params: { required: [], optional: [] } },
    ])).toThrow('Every action capability must be classified')
  })

  it('does not treat the CLI-only -p alias as a shared wait-for parameter', () => {
    expect(unsupportedInvocationResult('wait-for', { p: 'ready' })).toEqual({
      error: 'wait-for requires pattern with the Rust Freshell server.',
      hint: 'Use a literal output pattern.',
    })
  })

  it.each([
    ['new-tab', 'claude'],
    ['new-tab', 'kilroy'],
    ['split-pane', 'claude'],
    ['split-pane', 'kilroy'],
  ])('%s sends %s fresh-agent options and canonical Claude resume identity', async (action, agent) => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        let text = ''
        for await (const chunk of request) text += String(chunk)
        bodies.push({ url: request.url ?? '', body: JSON.parse(text) })
        response.end(JSON.stringify({ status: 'ok', data: { tabId: 't1', paneId: 'new-pane' } }))
      } else if (request.url === '/api/tabs') {
        response.end(JSON.stringify({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' }))
      } else {
        response.end(JSON.stringify({ panes: [{ id: 'p1', index: 0, kind: 'terminal' }] }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not listen')
    try {
      const args = [action, '--agent', agent, '--model', 'catalog-model', '--effort', 'max', '--resume', '550e8400-e29b-41d4-a716-446655440000']
      if (action === 'split-pane') args.push('--target', 'p1')
      const result = await runCli(args, `http://127.0.0.1:${address.port}`)
      expect(result.code, result.stderr).toBe(0)
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
        url: action === 'new-tab' ? '/api/tabs' : '/api/panes/p1/split',
        body: {
          agent, model: 'catalog-model', effort: 'max',
          sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
        },
      })
      expect(bodies[0].body).not.toHaveProperty('resumeSessionId')
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it.each([
    ['run', 'echo', 'blocked'],
    ['fresh-send', 'blocked'],
    ['attach', '--terminal', 'term-1'],
    ['new-tab', '--agent', 'unknown'],
    ['split-pane', '--agent', 'unknown'],
    ['wait-for'],
    ['wait-for', '--pattern', 'ready', '--stable', '1'],
    ['wait-for', '--pattern', 'ready', '--exit'],
    ['wait-for', '--pattern', 'ready', '--prompt'],
  ])('rejects unsupported %j locally with no HTTP request and JSONL stderr', async (...args: string[]) => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.statusCode = 500
      response.end('unexpected request')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not listen')
    try {
      const result = await runCli(args, `http://127.0.0.1:${address.port}`)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
      expect(requests).toBe(0)
      const diagnostics = result.stderr.trim().split('\n').map((line) => JSON.parse(line))
      expect(diagnostics).not.toHaveLength(0)
      for (const diagnostic of diagnostics) {
        expect(diagnostic).toMatchObject({ severity: 'error', event: 'cli.error' })
      }
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it.each([
    ['new-tab', '--agent', 'codex', '--resume', 'raw-thread'],
    ['new-tab', '--agent', 'codex', '--resumeSessionId', 'raw-thread'],
    ['split-pane', '--agent', 'codex', '--resume', 'raw-thread'],
    ['split-pane', '--agent', 'codex', '--resumeSessionId', 'raw-thread'],
    ['new-tab', '--agent', 'kilroy', '--sessionRef', 'kilroy:wrong-provider'],
    ['split-pane', '--agent', 'kilroy', '--sessionRef', 'kilroy:wrong-provider'],
    ['new-tab', '--agent', 'claude', '--sessionRef', 'codex:wrong-provider'],
    ['split-pane', '--agent', 'claude', '--sessionRef', 'codex:wrong-provider'],
  ])('preserves local restore identity refusal for %j', async (...args: string[]) => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.statusCode = 500
      response.end('unexpected request')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not listen')
    try {
      const result = await runCli(args, `http://127.0.0.1:${address.port}`)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(requests).toBe(0)
      expect(result.stderr.trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', event: 'cli.error' })]))
    } finally {
      const closed = once(server, 'close')
      server.close()
      await closed
      expect(server.listening).toBe(false)
    }
  })

  for (const action of ['new-tab', 'split-pane']) {
    it.each([
      { agent: 'claude', provider: 'claude', model: 'haiku', effort: 'low' },
      { agent: 'kilroy', provider: 'claude', model: 'haiku', effort: 'low' },
      { agent: 'codex', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
      { agent: 'opencode', provider: 'opencode', model: 'opencode/big-pickle', effort: undefined },
    ])('forwards an actual ' + action + ' $agent profile and canonical root', async profile => {
      const posts: { path: string; body: any }[] = []
      const server = createServer((request, response) => {
        let body = ''
        request.on('data', chunk => { body += String(chunk) })
        request.on('end', () => {
          response.setHeader('content-type', 'application/json')
          if (request.method === 'POST') {
            posts.push({ path: request.url ?? '', body: JSON.parse(body) })
            response.end(JSON.stringify({ status: 'ok', data: { paneId: 'alias-pane', sessionId: 'native-root' } }))
          } else if (request.url === '/api/tabs') {
            response.end(JSON.stringify({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' }))
          } else if (request.url === '/api/panes?tabId=t1') {
            response.end(JSON.stringify({ panes: [{ id: 'p1', index: 0, kind: 'fresh-agent' }] }))
          } else {
            response.statusCode = 404
            response.end(JSON.stringify({ error: 'unexpected loopback route' }))
          }
        })
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not listen')
      try {
        const result = await runCli([action, '--agent', profile.agent, '--model', profile.model,
          ...(profile.effort ? ['--effort', profile.effort] : []), '--permissionMode', 'default',
          '--cwd', '/workspace', '--sessionRef', profile.provider + ':native-root',
          ...(action === 'split-pane' ? ['--target', 'p1'] : []),
        ], `http://127.0.0.1:${address.port}`)
        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', data: { paneId: 'alias-pane', sessionId: 'native-root' } })
        expect(posts).toHaveLength(1)
        expect(posts[0].path).toBe(action === 'new-tab' ? '/api/tabs' : '/api/panes/p1/split')
        expect(posts[0].body).toMatchObject({
          agent: profile.agent, model: profile.model, permissionMode: 'default', cwd: '/workspace',
          sessionRef: { provider: profile.provider, sessionId: 'native-root' },
        })
        if (profile.effort) expect(posts[0].body.effort).toBe(profile.effort)
        else expect(posts[0].body).not.toHaveProperty('effort')
      } finally {
        const closed = once(server, 'close')
        server.close()
        server.closeAllConnections()
        await closed
        expect(server.listening).toBe(false)
      }
    })
  }

  it('accepts the short -p alias for a Rust pattern wait-for request', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/tabs') {
        response.end(JSON.stringify({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' }))
        return
      }
      if (request.url === '/api/panes?tabId=t1') {
        response.end(JSON.stringify({ panes: [{ id: 'p1', index: 0, kind: 'terminal' }] }))
        return
      }
      if (request.url?.startsWith('/api/panes/p1/wait-for?')) {
        response.end(JSON.stringify({ matched: true }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'unexpected request' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not listen')

    try {
      const result = await runCli(['wait-for', '-p', 'ready'], `http://127.0.0.1:${address.port}`)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ matched: true })
      expect(requests).toContain('/api/panes/p1/wait-for?pattern=ready')
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
