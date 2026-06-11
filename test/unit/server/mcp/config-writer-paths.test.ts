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
const toPosixPath = (value: string) => value.replace(/\\/g, '/')

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
      const loaderPath = args[args.indexOf('--import') + 1]
      expect(loaderPath).toContain('tsx')
      expect(fs.existsSync(loaderPath)).toBe(true)

      const serverPath = args.find((a: string) => toPosixPath(a).includes('server/mcp/server.ts'))
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
    const pathMatches = argsArg!.match(/"((?:\\.|[^"])*)"/g)
    expect(pathMatches).toBeTruthy()
    for (const quoted of pathMatches!) {
      const p = JSON.parse(quoted) as string
      if (p.includes('/') || p.includes('\\')) {
        expect(fs.existsSync(p)).toBe(true)
      }
    }
  })

  it('opencode mode treats cwd as an already-resolved host filesystem path and cleans up only the injected state', async () => {
    vi.resetModules()
    vi.doMock('os', () => ({
      ...os,
      tmpdir: () => testTmpDir,
      homedir: os.homedir,
      default: { ...os, tmpdir: () => testTmpDir, homedir: os.homedir },
    }))
    const hostRoot = path.join(testTmpDir, 'opencode-host-native')
    const testCwd = process.platform === 'win32'
      ? path.join(hostRoot, 'Users', 'Dan', 'repo')
      : path.join(hostRoot, String.raw`C:\Users\Dan\repo`)
    const expectedConfigPath = path.join(testCwd, '.opencode', 'opencode.json')
    const expectedSidecarPath = path.join(testCwd, '.opencode', '.freshell-mcp-state.json')
    const unexpectedRemappedConfigPath = path.join(hostRoot, 'C:', 'Users', 'Dan', 'repo', '.opencode', 'opencode.json')
    fs.mkdirSync(testCwd, { recursive: true })
    fs.mkdirSync(path.dirname(expectedConfigPath), { recursive: true })
    fs.writeFileSync(
      expectedConfigPath,
      JSON.stringify({
        mcp: {
          other: {
            type: 'local',
            command: ['node', 'other-server.js'],
          },
        },
        theme: 'dark',
      }, null, 2),
      { mode: 0o600 },
    )

    const { generateMcpInjection, cleanupMcpConfig } = await import('../../../../server/mcp/config-writer.js')
    const result = generateMcpInjection('opencode', 'test-opencode', testCwd)

    expect(result).toEqual({ args: [], env: {} })
    expect(fs.existsSync(expectedConfigPath)).toBe(true)
    expect(fs.existsSync(expectedSidecarPath)).toBe(true)
    expect(fs.existsSync(unexpectedRemappedConfigPath)).toBe(false)

    const config = JSON.parse(fs.readFileSync(expectedConfigPath, 'utf-8'))
    expect(config.mcp.freshell).toBeDefined()
    expect(config.mcp.freshell.type).toBe('local')
    expect(config.mcp.other).toEqual({
      type: 'local',
      command: ['node', 'other-server.js'],
    })
    expect(config.theme).toBe('dark')

    cleanupMcpConfig('test-opencode', 'opencode', testCwd)

    const cleanedConfig = JSON.parse(fs.readFileSync(expectedConfigPath, 'utf-8'))
    expect(cleanedConfig.mcp.freshell).toBeUndefined()
    expect(cleanedConfig.mcp.other).toEqual({
      type: 'local',
      command: ['node', 'other-server.js'],
    })
    expect(cleanedConfig.theme).toBe('dark')
    expect(fs.existsSync(expectedSidecarPath)).toBe(false)
  })
})
