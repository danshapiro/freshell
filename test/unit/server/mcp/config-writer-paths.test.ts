// Path resolution tests for config-writer.ts.
// Uses the REAL filesystem to verify generated MCP config paths point to files that exist.

import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const testTmpDir = path.join(os.tmpdir(), 'freshell-mcp-test-' + process.pid)

describe.skipIf(
  // In git worktrees, node_modules may not be present locally — skip path verification
  !fs.existsSync(path.join(path.resolve(import.meta.dirname || '.', '../../../..'), 'node_modules', 'tsx')),
)('config-writer path verification', () => {
  afterEach(() => {
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  const modes = ['claude', 'gemini', 'kimi'] as const

  for (const mode of modes) {
    it(`${mode} mode: MCP server command is "node" and paths exist`, async () => {
      vi.resetModules()
      vi.doMock('os', () => ({
        ...os,
        tmpdir: () => testTmpDir,
        homedir: os.homedir,
        default: { ...os, tmpdir: () => testTmpDir, homedir: os.homedir },
      }))

      const { generateMcpInjection } = await import('../../../../server/mcp/config-writer.js')
      const result = generateMcpInjection(mode, `test-${mode}`)

      let configPath: string
      if (mode === 'claude') {
        const idx = result.args.indexOf('--mcp-config')
        configPath = result.args[idx + 1]
      } else if (mode === 'kimi') {
        const idx = result.args.indexOf('--mcp-config-file')
        configPath = result.args[idx + 1]
      } else {
        configPath = result.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
      }

      expect(fs.existsSync(configPath)).toBe(true)
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

      expect(config.mcpServers.freshell.command).toBe('node')

      const args = config.mcpServers.freshell.args as string[]
      expect(args).toContain('--import')
      const tsxPath = args.find((a: string) => a.includes('tsx/dist/esm/index.mjs'))
      expect(tsxPath).toBeDefined()
      expect(fs.existsSync(tsxPath!)).toBe(true)

      const serverPath = args.find((a: string) => a.includes('server/mcp/server.ts'))
      expect(serverPath).toBeDefined()
      expect(fs.existsSync(serverPath!)).toBe(true)

      try { fs.unlinkSync(configPath) } catch { /* ignore */ }
    })
  }

  it('codex mode: MCP server args contain valid paths', async () => {
    vi.resetModules()
    const { generateMcpInjection } = await import('../../../../server/mcp/config-writer.js')
    const result = generateMcpInjection('codex', 'test-codex')

    const commandArg = result.args.find((a: string) => a.includes('mcp_servers.freshell.command'))
    expect(commandArg).toContain('"node"')

    const argsArg = result.args.find((a: string) => a.includes('mcp_servers.freshell.args'))
    expect(argsArg).toBeDefined()
    const pathMatches = argsArg!.match(/"([^"]+)"/g)
    expect(pathMatches).toBeTruthy()
    for (const quoted of pathMatches!) {
      const p = quoted.replace(/^"|"$/g, '')
      if (p.includes('/') || p.includes('\\')) {
        expect(fs.existsSync(p)).toBe(true)
      }
    }
  })

  it('opencode mode: writes to project-local config path', async () => {
    vi.resetModules()
    vi.doMock('os', () => ({
      ...os,
      tmpdir: () => testTmpDir,
      homedir: os.homedir,
      default: { ...os, tmpdir: () => testTmpDir, homedir: os.homedir },
    }))
    const testCwd = path.join(testTmpDir, 'opencode-test-project')
    fs.mkdirSync(testCwd, { recursive: true })

    const { generateMcpInjection, cleanupMcpConfig } = await import('../../../../server/mcp/config-writer.js')
    generateMcpInjection('opencode', 'test-opencode', testCwd)

    const configPath = path.join(testCwd, '.opencode', 'opencode.json')
    expect(fs.existsSync(configPath)).toBe(true)
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(config.mcp.freshell).toBeDefined()
    expect(config.mcp.freshell.type).toBe('local')

    cleanupMcpConfig('test-opencode', 'opencode', testCwd)
  })
})
