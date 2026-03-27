/**
 * Path resolution tests for config-writer.ts.
 *
 * Uses the REAL filesystem (no fs mocking) to verify that generated MCP
 * config paths point to files that actually exist on disk.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Only mock os.tmpdir to use a test-safe temp directory
const testTmpDir = path.join(os.tmpdir(), 'freshell-mcp-test-' + process.pid)

describe('config-writer path verification', () => {
  afterEach(() => {
    // Clean up test temp files
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  const modes = ['claude', 'gemini', 'kimi'] as const

  for (const mode of modes) {
    it(`${mode} mode: MCP server command is "node" and paths exist`, async () => {
      // Import with real fs but mocked tmpdir
      vi.resetModules()
      vi.doMock('os', () => ({
        ...os,
        tmpdir: () => testTmpDir,
        homedir: os.homedir,
        default: { ...os, tmpdir: () => testTmpDir, homedir: os.homedir },
      }))

      const { generateMcpInjection } = await import('../../../../server/mcp/config-writer.js')
      const result = generateMcpInjection(mode, `test-${mode}`)

      // For claude/kimi, config is in args; for gemini, config is in env
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

      // Command is bare "node"
      expect(config.mcpServers.freshell.command).toBe('node')

      // Dev mode: args should include --import and paths should exist
      const args = config.mcpServers.freshell.args as string[]
      expect(args).toContain('--import')
      const tsxPath = args.find((a: string) => a.includes('tsx/dist/esm/index.mjs'))
      expect(tsxPath).toBeDefined()
      expect(fs.existsSync(tsxPath!)).toBe(true)

      const serverPath = args.find((a: string) => a.includes('server/mcp/server.ts'))
      expect(serverPath).toBeDefined()
      expect(fs.existsSync(serverPath!)).toBe(true)

      // Clean up
      try { fs.unlinkSync(configPath) } catch { /* ignore */ }
    })
  }

  it('codex mode: MCP server args contain valid paths', async () => {
    vi.resetModules()
    const { generateMcpInjection } = await import('../../../../server/mcp/config-writer.js')
    const result = generateMcpInjection('codex', 'test-codex')

    // Codex uses -c flags, no temp file
    const commandArg = result.args.find((a: string) => a.includes('mcp_servers.freshell.command'))
    expect(commandArg).toContain('"node"')

    const argsArg = result.args.find((a: string) => a.includes('mcp_servers.freshell.args'))
    expect(argsArg).toBeDefined()
    // Extract paths from TOML array
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

    // Clean up
    cleanupMcpConfig('test-opencode', 'opencode', testCwd)
  })
})
