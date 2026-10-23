// @vitest-environment node

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PINNED_CLI_VERSION, PINNED_SDK_VERSION } from './claude-local-provider.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const HARNESS = path.join(__dirname, 'claude-freshell-mcp.mjs')
const children = new Set<ChildProcess>()

afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

// G19 (api-hosted-ops plan §2.4, §3.2): a freshclaude pane's Freshell MCP
// server reaches the server through the inherited environment, never the
// CLI's argv. Against the pinned SDK and CLI: the real sidecar hands the CLI
// the recipe the Rust server resolved; the CLI starts the stdio MCP child with
// the endpoint, the token and the pane context the sidecar merged in; the
// server connects (its tool is listed and callable); and the token is nowhere
// on the CLI's command line, where the MCP config itself travels.
describe('Freshell MCP in a Claude sidecar against the pinned CLI and a local provider', () => {
  it('connects the MCP child with the endpoint, token and pane in its environment and keeps the token off the CLI argv', async () => {
    const child = spawn(process.execPath, [HARNESS, REPO_ROOT], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Freshell MCP contract timed out; stderr=${stderr.slice(-2000)}`))
      }, 150_000)
      timer.unref()
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    children.delete(child)

    const lines = stdout.trim().split('\n').filter(Boolean)
    expect(lines, stderr).toHaveLength(1)
    const receipt = JSON.parse(lines[0]!) as Record<string, any>
    expect(receipt, `${lines[0]}\n${stderr}`).toMatchObject({
      sdkVersion: PINNED_SDK_VERSION,
      bundledCliVersion: PINNED_CLI_VERSION,
      cliArgvHasMcpConfig: true,
      cliArgvHasToken: false,
      probeToolListed: true,
      probeSawContext: true,
      toolCallReturnedReport: true,
      probe: {
        FRESHELL: '1',
        FRESHELL_URL: 'http://127.0.0.1:9/freshell-probe-endpoint',
        FRESHELL_TOKEN_SHA256: 'matches',
        FRESHELL_TAB_ID: 'tab-g19',
        FRESHELL_PANE_ID: 'pane-g19',
        FRESHELL_TERMINAL_ID: null,
      },
      verdict: 'PASS',
    })
    expect(exit, stderr).toEqual({ code: 0, signal: null })
  }, 160_000)
})
