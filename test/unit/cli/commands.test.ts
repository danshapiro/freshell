import { describe, it, expect, vi } from 'vitest'
import { runCommand } from '../../../tools/freshell-cli/commands/sendKeys'
import {
  runListSessionsCommand,
  runSearchSessionsCommand,
} from '../../../tools/freshell-cli/index.js'
import { createCliCommandHarness } from '../../helpers/visible-first/cli-command-harness.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const cliPath = resolve(process.cwd(), 'tools/freshell-cli/index.ts')
const tsxLoader = pathToFileURL(require.resolve('tsx')).href

describe('Freshcodex creation through the real CLI', () => {
  it('keeps an uncertain send receipt without replaying or exposing unrelated error payloads', async () => {
    const receipt = { status: 'error', code: 'CODEX_DELIVERY_AMBIGUOUS', message: 'delivery is uncertain', retryable: false, requestId: 'uncertain-request', sessionId: 'native-session', incarnationId: 'owned-incarnation', answer: 'do-not-log-this-answer' }
    const result = await invokeCli(['new-tab', '--agent', 'codex', '--prompt', 'recoverable prompt'], { sendError: receipt })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.requests.map((request) => request.url)).toEqual(['/api/tabs', '/api/panes/p1/send-keys'])
    const diagnostics = result.stderr.trim().split('\n').map((line) => JSON.parse(line))
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_DELIVERY_AMBIGUOUS', retryable: false, requestId: 'uncertain-request', sessionId: 'native-session', incarnationId: 'owned-incarnation' }))
    expect(result.stderr).not.toContain('do-not-log-this-answer')
  })
  it('promotes canonical resume identity and sends the initial prompt separately', async () => {
    const result = await invokeCli(['new-tab', '--agent', 'codex', '--resume', '550e8400-e29b-41d4-a716-446655440000', '--model', 'provider-current', '--effort', 'xhigh', '--prompt', 'initial Codex prompt'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.requests).toEqual([
      { url: '/api/tabs', body: expect.objectContaining({ agent: 'codex', model: 'provider-current', effort: 'xhigh', sessionRef: { provider: 'codex', sessionId: '550e8400-e29b-41d4-a716-446655440000' } }) },
      { url: '/api/panes/p1/send-keys', body: { data: 'initial Codex prompt\r' } },
    ])
    expect(result.requests[0].body).not.toHaveProperty('resumeSessionId')
  })

  it.each(['new-tab', 'split-pane'])('%s still refuses terminal-mode raw Codex resume before HTTP', async (action) => {
    const result = await invokeCli([action, '--mode', 'codex', '--resume', 'raw-codex-id'])
    expect(result.code).toBe(1)
    expect(result.requests).toHaveLength(0)
    expect(result.stderr).toContain('Restore requires sessionRef')
  })
})

/** Spawns the real CLI (retained-flags.test.ts pattern) against a stub HTTP
 * server and records every resulting HTTP call. `outcome` (name-reliability
 * Task 4) is the rename outcome the stub's accepted update carries. */
async function invokeCli(args: string[], opts: { outcome?: unknown; sendError?: Record<string, unknown> } = {}) {
  const requests: Array<{ url: string; body: any }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    requests.push({ url: request.url ?? '', body: text ? JSON.parse(text) : undefined })
    response.setHeader('content-type', 'application/json')
    if (request.method === 'POST' && request.url?.endsWith('/send-keys') && opts.sendError) {
      response.statusCode = 409
      response.end(JSON.stringify(opts.sendError))
    } else if (request.method === 'GET' && request.url === '/api/tabs') {
      response.end(JSON.stringify({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' }))
    } else if (request.method === 'GET' && request.url === '/api/panes?tabId=t1') {
      response.end(JSON.stringify({ panes: [{ id: 'p1', index: 0, kind: 'terminal' }] }))
    } else {
      response.end(JSON.stringify({
        status: 'ok',
        data: {
          tabId: 't1',
          paneId: 'p1',
          sessionName: {
            record: { ref: { kind: 'session', provider: 'claude', sessionId: 's1' }, name: 'Accepted server name', source: 'automatic-provider', revision: 2 },
            documentGeneration: 9,
            redirects: [],
            changed: true,
            ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
          },
        },
      }))
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
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const [code] = await once(child, 'close')
    return { code, stderr, stdout, requests }
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  }
}

describe('CLI commands', () => {
  it('calls api send-keys endpoint', async () => {
    const client = { post: vi.fn().mockResolvedValue({ status: 'ok' }) }
    await runCommand({ target: 'pane_1', keys: ['Enter'] }, client as any)
    expect(client.post).toHaveBeenCalled()
  })

  it('list-sessions calls the session-directory contract and keeps grouped output', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/repo/alpha',
            lastActivityAt: 100,
            title: 'Alpha',
          },
        ],
        nextCursor: null,
        revision: 7,
      }),
    }
    const harness = createCliCommandHarness()

    const result = await harness.run(async ({ stdout, stderr, setExitCode }) => {
      await runListSessionsCommand(client as any, {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(client.get).toHaveBeenCalledWith('/api/session-directory?priority=visible')
    expect(result.exitCode).toBe(0)
    expect(result.json).toEqual([
      {
        projectPath: '/repo/alpha',
        sessions: [
          expect.objectContaining({
            provider: 'claude',
            sessionId: 'session-1',
            lastActivityAt: 100,
            title: 'Alpha',
          }),
        ],
      },
    ])
  })

  it('follows every session-directory cursor for list and search output', async () => {
    const listClient = {
      get: vi.fn()
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'page-one', projectPath: '/repo', lastActivityAt: 2 }],
          nextCursor: 'cursor-page-two', revision: 11,
        })
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'page-two', projectPath: '/repo', lastActivityAt: 1 }],
          nextCursor: null, revision: 11,
        }),
    }
    const listHarness = createCliCommandHarness()
    const listResult = await listHarness.run(async ({ stdout, stderr, setExitCode }) => {
      await runListSessionsCommand(listClient as any, {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(listClient.get).toHaveBeenNthCalledWith(1, '/api/session-directory?priority=visible')
    expect(listClient.get).toHaveBeenNthCalledWith(2, '/api/session-directory?priority=visible&cursor=cursor-page-two')
    expect(listResult.json[0].sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(['page-one', 'page-two'])

    const searchClient = {
      get: vi.fn()
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'search-one', projectPath: '/repo', lastActivityAt: 2, matchedIn: 'title' }],
          nextCursor: 'search-page-two', revision: 12,
        })
        .mockResolvedValueOnce({
          items: [{ provider: 'claude', sessionId: 'search-two', projectPath: '/repo', lastActivityAt: 1, matchedIn: 'summary' }],
          nextCursor: null, revision: 12,
        }),
    }
    const searchHarness = createCliCommandHarness()
    const searchResult = await searchHarness.run(async ({ stdout, stderr, setExitCode }) => {
      await runSearchSessionsCommand(searchClient as any, 'needle', {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(searchClient.get).toHaveBeenNthCalledWith(1, '/api/session-directory?priority=visible&query=needle')
    expect(searchClient.get).toHaveBeenNthCalledWith(2, '/api/session-directory?priority=visible&query=needle&cursor=search-page-two')
    expect(searchResult.json.results.map((session: { sessionId: string }) => session.sessionId)).toEqual(['search-one', 'search-two'])
    expect(searchResult.json.totalScanned).toBe(2)
  })

  it('search-sessions calls the session-directory contract family and keeps search-style output', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        items: [
          {
            provider: 'claude',
            sessionId: 'session-1',
            projectPath: '/repo/alpha',
            lastActivityAt: 100,
            title: 'Alpha deploy',
            snippet: 'Alpha deploy',
            matchedIn: 'title',
          },
        ],
        nextCursor: null,
        revision: 9,
      }),
    }
    const harness = createCliCommandHarness()

    const result = await harness.run(async ({ stdout, stderr, setExitCode }) => {
      await runSearchSessionsCommand(client as any, 'alpha', {
        writeJson: (value) => stdout(`${JSON.stringify(value)}\n`),
        writeError: (value) => stderr(String(value)),
        setExitCode,
      })
    })

    expect(client.get).toHaveBeenCalledWith('/api/session-directory?priority=visible&query=alpha')
    expect(result.exitCode).toBe(0)
    expect(result.json).toEqual({
      results: [
        expect.objectContaining({
          sessionId: 'session-1',
          lastActivityAt: 100,
          matchedIn: 'title',
          snippet: 'Alpha deploy',
        }),
      ],
      tier: 'title',
      query: 'alpha',
      totalScanned: 1,
    })
  })

  describe('rename/create name intent', () => {
    it('rename-pane defaults the intent to automatic on the wire', async () => {
      const result = await invokeCli(['rename-pane', '--target', 'p1', 'Agent suggested name'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const patch = result.requests.find((request) => request.url === '/api/panes/p1')
      expect(patch).toBeDefined()
      expect(patch!.body).toMatchObject({ name: 'Agent suggested name', nameIntent: 'automatic' })
    })

    it('rename-pane forwards an explicit user intent', async () => {
      const result = await invokeCli(['rename-pane', '--target', 'p1', '--name-intent', 'user', 'Human name'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const patch = result.requests.find((request) => request.url === '/api/panes/p1')
      expect(patch!.body).toMatchObject({ name: 'Human name', nameIntent: 'user' })
    })

    it('rename-tab defaults the intent to automatic on the wire', async () => {
      const result = await invokeCli(['rename-tab', '--target', 't1', 'Suggested tab name'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const patch = result.requests.find((request) => request.url === '/api/tabs/t1')
      expect(patch).toBeDefined()
      expect(patch!.body).toMatchObject({ name: 'Suggested tab name', nameIntent: 'automatic' })
    })

    it('rename-tab forwards an explicit user intent', async () => {
      const result = await invokeCli(['rename-tab', '--target', 't1', '--name-intent', 'user', 'Human tab name'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const patch = result.requests.find((request) => request.url === '/api/tabs/t1')
      expect(patch!.body).toMatchObject({ name: 'Human tab name', nameIntent: 'user' })
    })

    it('new-tab seeds the create name with automatic intent by default', async () => {
      const result = await invokeCli(['new-tab', '--name', 'Fresh conversation', '--mode', 'claude'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const post = result.requests.find((request) => request.url === '/api/tabs')
      expect(post).toBeDefined()
      expect(post!.body).toMatchObject({ name: 'Fresh conversation', nameIntent: 'automatic' })
    })

    it('new-tab forwards an explicit user intent for the create name', async () => {
      const result = await invokeCli(['new-tab', '--name', 'Named by a human', '--name-intent', 'user'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const post = result.requests.find((request) => request.url === '/api/tabs')
      expect(post!.body).toMatchObject({ name: 'Named by a human', nameIntent: 'user' })
    })

    it('rejects an unknown name intent without issuing any request', async () => {
      const result = await invokeCli(['rename-tab', '--target', 't1', '--name-intent', 'bogus', 'X'])
      expect(result.code).toBe(1)
      expect(result.requests).toEqual([])
      expect(result.stderr).toContain('--name-intent')
    })

    it('rename-tab reports a refused automation rename on stderr', async () => {
      const result = await invokeCli(['rename-tab', '--target', 't1', 'Bot name'], {
        outcome: { applied: false, reason: 'protected_name' },
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('name not applied: protected_name')
      // The accepted (unchanged) record is still printed.
      expect(result.stdout).toContain('Accepted server name')
    })

    it('rename-pane reports a refused default label on stderr', async () => {
      const result = await invokeCli(['rename-pane', '--target', 'p1', 'Tab 3'], {
        outcome: { applied: false, reason: 'default_label' },
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('name not applied: default_label')
    })

    it('an applied or unchanged rename prints nothing on stderr', async () => {
      const applied = await invokeCli(['rename-tab', '--target', 't1', 'Good name'], {
        outcome: { applied: true },
      })
      expect(applied.stderr).toBe('')
      const unchanged = await invokeCli(['rename-pane', '--target', 'p1', 'Same name'], {
        outcome: { applied: true, reason: 'unchanged' },
      })
      expect(unchanged.stderr).toBe('')
    })

    it('reflects the server-accepted name in the response, not the submitted string', async () => {
      const result = await invokeCli(['rename-pane', '--target', 'p1', 'Losing suggestion', '--name-intent', 'user'])
      expect(result.code).toBe(0)
      // The stub server always answers with its accepted winner; the CLI
      // output reports that accepted record verbatim.
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Accepted server name')
    })
  })
})
