// @vitest-environment node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACTION_CAPABILITIES,
  validateActionCapabilities,
} from '../../../tools/node-client-runtime/action-capabilities.js'

const require = createRequire(import.meta.url)
const cliPath = resolve(process.cwd(), 'tools/freshell-cli/index.ts')
const tsxLoader = pathToFileURL(require.resolve('tsx')).href

async function runCli(args: string[], url: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', tsxLoader, cliPath, ...args], {
    env: { ...process.env, NODE_NO_WARNINGS: '1', FRESHELL_URL: url, FRESHELL_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const [code] = await once(child, 'exit') as [number | null]
  return { code, stdout, stderr }
}

describe('standalone CLI capability contract', () => {
  it('contains precisely 33 unique canonical actions and 14 unique aliases', () => {
    validateActionCapabilities(ACTION_CAPABILITIES)
    expect(ACTION_CAPABILITIES).toHaveLength(33)
    expect(ACTION_CAPABILITIES.flatMap((capability) => capability.aliases ?? [])).toHaveLength(14)
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

  it.each([
    ['run', 'echo', 'blocked'],
    ['fresh-send', 'blocked'],
    ['attach', '--terminal', 'term-1'],
    ['new-tab', '--agent', 'codex'],
    ['split-pane', '--agent', 'opencode'],
    ['split-pane', '--model', 'model'],
    ['split-pane', '--effort', 'high'],
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
})
