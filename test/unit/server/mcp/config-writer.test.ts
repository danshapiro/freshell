import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'

// Track all writeFileSync/mkdirSync/unlinkSync/existsSync/readFileSync calls
const mockFs = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  rmdirSync: vi.fn(),
  statSync: vi.fn(),
}))

vi.mock('fs', () => ({
  ...mockFs,
  default: mockFs,
}))

const mockTmpdir = vi.hoisted(() => vi.fn().mockReturnValue('/tmp'))
const mockHomedir = vi.hoisted(() => vi.fn().mockReturnValue('/home/testuser'))

vi.mock('os', () => ({
  tmpdir: mockTmpdir,
  homedir: mockHomedir,
  default: { tmpdir: mockTmpdir, homedir: mockHomedir },
}))

describe('generateMcpInjection -- per-agent config', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.unlinkSync.mockReset()
    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.readFileSync.mockReset()
    mockFs.rmdirSync.mockReset()
    mockFs.statSync.mockReset()
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('claude mode: returns args with --mcp-config pointing to temp file', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('claude', 'term-abc')
    expect(result.args).toContain('--mcp-config')
    const configIndex = result.args.indexOf('--mcp-config')
    expect(result.args[configIndex + 1]).toMatch(/freshell-mcp\/term-abc\.json$/)
    expect(result.env).toEqual({})
  })

  it('claude mode: temp file contains valid JSON with mcpServers.freshell.command', async () => {
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('claude', 'term-abc')
    expect(mockFs.writeFileSync).toHaveBeenCalled()
    const [, content] = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )!
    const parsed = JSON.parse(content)
    expect(parsed.mcpServers.freshell.command).toBe('node')
    expect(Array.isArray(parsed.mcpServers.freshell.args)).toBe(true)
  })

  it('codex mode: returns args with -c flags for MCP server config', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('codex', 'term-def')
    expect(result.args).toContain('-c')
    const mcpArg = result.args.find((a: string) => a.includes('mcp_servers.freshell.command'))
    expect(mcpArg).toBeDefined()
    expect(result.env).toEqual({})
  })

  it('codex mode: does not write a temp file', async () => {
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('codex', 'term-def')
    const mcpWrites = mockFs.writeFileSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(mcpWrites).toHaveLength(0)
  })

  it('gemini mode: returns env with GEMINI_CLI_SYSTEM_DEFAULTS_PATH', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('gemini', 'term-ghi')
    expect(result.args).toEqual([])
    expect(result.env).toHaveProperty('GEMINI_CLI_SYSTEM_DEFAULTS_PATH')
    expect(result.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toMatch(/freshell-mcp\/term-ghi\.json$/)
  })

  it('gemini mode: temp file contains valid JSON with mcpServers.freshell', async () => {
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('gemini', 'term-ghi')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    expect(parsed.mcpServers.freshell).toBeDefined()
  })

  it('kimi mode: returns args with --mcp-config-file pointing to temp file', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('kimi', 'term-jkl')
    expect(result.args).toContain('--mcp-config-file')
    const configIndex = result.args.indexOf('--mcp-config-file')
    expect(result.args[configIndex + 1]).toMatch(/freshell-mcp\/term-jkl\.json$/)
    expect(result.env).toEqual({})
  })

  it('kimi mode: temp file contains valid JSON with mcpServers.freshell', async () => {
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('kimi', 'term-jkl')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    expect(parsed.mcpServers.freshell).toBeDefined()
  })

  it('opencode mode: reads existing config and merges freshell entry', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: { existing: { type: 'local', command: ['echo'] } } })
      }
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-mno', '/tmp/test-cwd')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    expect(parsed.mcp.existing).toBeDefined()
    expect(parsed.mcp.freshell).toBeDefined()
    expect(parsed.mcp.freshell.type).toBe('local')
  })

  it('opencode mode: creates config if file does not exist', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-mno', '/tmp/test-cwd')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    expect(parsed.mcp.freshell).toBeDefined()
  })

  it('opencode mode: returns empty args and env', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('opencode', 'term-mno', '/tmp/test-cwd')
    expect(result.args).toEqual([])
    expect(result.env).toEqual({})
  })

  it('shell mode: returns empty args and env, no temp file', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('shell', 'term-pqr')
    expect(result).toEqual({ args: [], env: {} })
    const mcpWrites = mockFs.writeFileSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && (call[0].includes('freshell-mcp') || call[0].includes('opencode'))
    )
    expect(mcpWrites).toHaveLength(0)
  })

  it('unknown mode: returns empty args and env, no temp file', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('unknown-mode' as any, 'term-xyz')
    expect(result).toEqual({ args: [], env: {} })
  })

  describe('buildMcpServerCommandArgs (exported)', () => {
    it('returns array with server entry point path', async () => {
      const { buildMcpServerCommandArgs } = await importModule()
      const args = buildMcpServerCommandArgs()
      expect(Array.isArray(args)).toBe(true)
      expect(args.length).toBeGreaterThan(0)
      // In dev mode (NODE_ENV !== 'production'), includes tsx import
      expect(args.some((a: string) => a.includes('server') && a.includes('mcp'))).toBe(true)
    })

    it('returns production path when NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production'
      const { buildMcpServerCommandArgs } = await importModule()
      const args = buildMcpServerCommandArgs()
      expect(args).toHaveLength(1)
      expect(args[0]).toMatch(/dist\/server\/mcp\/server\.js$/)
    })
  })
})

describe('generateMcpInjection -- dev/production detection', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('uses built path when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production'
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('claude', 'term-prod')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    const args = parsed.mcpServers.freshell.args as string[]
    expect(args.some((a: string) => a.includes('dist/server/mcp/server.js'))).toBe(true)
    expect(args).not.toContain('--import')
  })

  it('uses tsx/esm loader path when NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('claude', 'term-dev')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    const args = parsed.mcpServers.freshell.args as string[]
    expect(args).toContain('--import')
    expect(args[args.indexOf('--import') + 1]).toContain('tsx')
    expect(args.some((a: string) => a.includes('server/mcp/server.ts'))).toBe(true)
  })
})

describe('cleanupMcpConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.existsSync.mockReset()
    mockFs.unlinkSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.writeFileSync.mockReset()
    mockFs.rmdirSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('deletes temp file when it exists', async () => {
    mockFs.existsSync.mockReturnValue(true)
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-abc')
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/freshell-mcp\/term-abc\.json$/))
  })

  it('does not throw when temp file does not exist', async () => {
    mockFs.existsSync.mockReturnValue(false)
    const { cleanupMcpConfig } = await importModule()
    expect(() => cleanupMcpConfig('nonexistent')).not.toThrow()
  })

  it('does not throw when unlinkSync fails', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.unlinkSync.mockImplementation(() => { throw new Error('EPERM') })
    const { cleanupMcpConfig } = await importModule()
    expect(() => cleanupMcpConfig('term-abc')).not.toThrow()
  })
})

describe('cleanupMcpConfig -- OpenCode sidecar', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.unlinkSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.writeFileSync.mockReset()
    mockFs.rmdirSync.mockReset()
    mockFs.mkdirSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode cleanup removes freshell key when sidecar refcount reaches 0', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: false })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: { freshell: { type: 'local', command: ['node'] }, other: { type: 'local', command: ['echo'] } } })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')
    // Should write opencode.json without freshell but with other
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    expect(parsed.mcp.other).toBeDefined()
    expect(parsed.mcp.freshell).toBeUndefined()
    // Sidecar should be deleted
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.freshell-mcp-state.json'))
  })

  it('opencode cleanup deletes opencode.json and dir when freshell was only entry and dir was created by Freshell', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: true, createdFile: true })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: { freshell: { type: 'local', command: ['node'] } } })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')
    // Should delete opencode.json
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('opencode.json'))
    // Should delete sidecar
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.freshell-mcp-state.json'))
    // Should attempt to remove dir
    expect(mockFs.rmdirSync).toHaveBeenCalledWith(expect.stringContaining('.opencode'))
  })

  it('opencode cleanup skips key removal when no sidecar exists (user-managed)', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockReturnValue(false)
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')
    // Should NOT modify opencode.json
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeUndefined()
  })

  it('opencode cleanup decrements refcount when > 1 but does not remove config', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 2, createdDir: false, createdFile: false })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')
    // Sidecar should be rewritten with refCount: 1
    const sidecarWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.json')
    )
    expect(sidecarWrite).toBeDefined()
    const parsed = JSON.parse(sidecarWrite![1])
    expect(parsed.refCount).toBe(1)
    // opencode.json should NOT be modified
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeUndefined()
  })

  it('generateMcpInjection for opencode writes no custom keys to opencode.json', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-test', '/tmp/test-cwd')
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    // No underscore-prefixed keys anywhere
    const allKeys = JSON.stringify(parsed)
    expect(allKeys).not.toContain('_freshell')
    expect(allKeys).not.toContain('_managed')
  })
})

describe('temp file security', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('temp files are written with mode 0o600', async () => {
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('claude', 'term-sec')
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(writeCall).toBeDefined()
    expect(writeCall![2]).toEqual(expect.objectContaining({ mode: 0o600 }))
  })

  it('temp directory is created with recursive option', async () => {
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('claude', 'term-dir')
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('freshell-mcp'),
      expect.objectContaining({ recursive: true }),
    )
  })
})

describe('cleanupMcpConfig -- OpenCode with non-MCP settings', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.unlinkSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.writeFileSync.mockReset()
    mockFs.rmdirSync.mockReset()
    mockFs.mkdirSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('does not delete opencode.json when non-MCP top-level keys exist even if createdFile is true', async () => {
    // The file has other top-level settings beyond "mcp" (e.g. "theme", "editor")
    // Even though sidecar says createdFile=true, we must not delete the whole file
    // because the user may have added these settings after Freshell created the file.
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: true, createdFile: true })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({
          mcp: { freshell: { type: 'local', command: ['node'] } },
          theme: 'dark',
          editor: { tabSize: 2 },
        })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')

    // opencode.json must NOT be deleted (unlinkSync should not be called for it)
    const unlinkCalls = mockFs.unlinkSync.mock.calls
      .filter((call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json'))
    expect(unlinkCalls).toHaveLength(0)

    // Instead, opencode.json should be rewritten without the freshell entry but preserving other keys
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    expect(parsed.mcp?.freshell).toBeUndefined()
    expect(parsed.theme).toBe('dark')
    expect(parsed.editor).toEqual({ tabSize: 2 })
  })

  it('does not delete opencode.json when mcp has other entries plus non-MCP top-level keys', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: true })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({
          mcp: { freshell: { type: 'local', command: ['node'] }, other: { type: 'local', command: ['echo'] } },
          settings: { autoSave: true },
        })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')

    // File should be rewritten, not deleted
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    expect(parsed.mcp.freshell).toBeUndefined()
    expect(parsed.mcp.other).toBeDefined()
    expect(parsed.settings).toEqual({ autoSave: true })
  })
})

describe('opencode malformed config', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode mode: throws a clear error when existing config is malformed JSON', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return 'not valid json{'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    // Must throw a clear, user-friendly error instead of silently replacing the file
    expect(() => generateMcpInjection('opencode', 'term-bad', '/tmp/test-cwd')).toThrow(
      /opencode\.json.*malformed|malformed.*JSON/i,
    )
    // Must NOT write to opencode.json (data loss prevention)
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeUndefined()
  })
})

describe('opencode valid-but-non-object JSON config', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode mode: throws a clear error when existing config is JSON null', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return 'null'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-null', '/tmp/test-cwd')).toThrow(
      /not a valid object|invalid.*config|expected.*object/i,
    )
  })

  it('opencode mode: throws a clear error when existing config is a JSON number', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return '42'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-num', '/tmp/test-cwd')).toThrow(
      /not a valid object|invalid.*config|expected.*object/i,
    )
  })

  it('opencode mode: throws a clear error when existing config is a JSON string', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return '"hello"'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-str', '/tmp/test-cwd')).toThrow(
      /not a valid object|invalid.*config|expected.*object/i,
    )
  })

  it('opencode mode: throws a clear error when existing config is a JSON array', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return '[1, 2, 3]'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-arr', '/tmp/test-cwd')).toThrow(
      /not a valid object|invalid.*config|expected.*object/i,
    )
  })

  it('opencode mode: throws a clear error when mcp field is not an object', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: 'bad' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-bad-mcp', '/tmp/test-cwd')).toThrow(
      /not a valid object|invalid.*mcp.*field|expected.*object/i,
    )
  })
})

describe('opencode sidecar lock contention', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
    mockFs.unlinkSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode injection acquires and releases a lock file to serialize sidecar access', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-lock', '/tmp/test-cwd')

    // A lock file should have been written (acquired) and then removed (released)
    const lockWrites = mockFs.writeFileSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockWrites.length).toBeGreaterThanOrEqual(1)
    const lockUnlinks = mockFs.unlinkSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockUnlinks.length).toBeGreaterThanOrEqual(1)
  })

  it('opencode cleanup acquires and releases a lock file', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: false })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: { freshell: { type: 'local', command: ['node'] }, other: { type: 'local', command: ['echo'] } } })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-lock', 'opencode', '/tmp/test-cwd')

    const lockWrites = mockFs.writeFileSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockWrites.length).toBeGreaterThanOrEqual(1)
    const lockUnlinks = mockFs.unlinkSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockUnlinks.length).toBeGreaterThanOrEqual(1)
  })

  it('lock retry exhaustion throws an error instead of proceeding without lock', async () => {
    // Simulate lock file always existing (held by another process, not stale)
    mockFs.writeFileSync.mockImplementation((filePath: string, _data: any, opts: any) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        const err: any = new Error('EEXIST')
        err.code = 'EEXIST'
        throw err
      }
    })
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() }) // Not stale
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    // Should throw when lock cannot be acquired rather than proceeding without lock
    expect(() => generateMcpInjection('opencode', 'term-lock-fail', '/tmp/test-cwd')).toThrow(/lock/i)
  })

  it('releaseLock only removes lock if this process acquired it', async () => {
    // If lock was acquired by this process, pid should match
    let lockAcquired = false
    mockFs.writeFileSync.mockImplementation((filePath: string, data: any, opts: any) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        if (opts?.flag === 'wx') {
          lockAcquired = true
          return
        }
      }
    })
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        return String(process.pid)
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-pid', '/tmp/test-cwd')
    // Lock should have been released (unlinkSync called for lock file)
    const lockUnlinks = mockFs.unlinkSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockUnlinks.length).toBeGreaterThanOrEqual(1)
  })
})

describe('opencode config read-inside-lock ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
    mockFs.unlinkSync.mockReset()
    mockFs.statSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode config read occurs inside the locked section (after lock acquisition)', async () => {
    // Track the order of operations to verify read happens after lock
    const operations: string[] = []
    mockFs.writeFileSync.mockImplementation((filePath: string, _data: any, opts: any) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        if (opts?.flag === 'wx') {
          operations.push('lock-acquired')
          return
        }
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        operations.push('config-write')
      }
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        operations.push('sidecar-write')
      }
    })
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        return String(process.pid)
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        operations.push('config-read')
        return JSON.stringify({ mcp: { existing: { type: 'local', command: ['echo'] } } })
      }
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    mockFs.unlinkSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        operations.push('lock-released')
      }
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-order', '/tmp/test-cwd')

    // Config read MUST happen after lock acquisition
    const lockIdx = operations.indexOf('lock-acquired')
    const readIdx = operations.indexOf('config-read')
    expect(lockIdx).toBeGreaterThanOrEqual(0)
    expect(readIdx).toBeGreaterThan(lockIdx)
  })
})

describe('opencode pre-existing freshell entry preservation', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
    mockFs.unlinkSync.mockReset()
    mockFs.rmdirSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('does not overwrite pre-existing user-managed freshell entry when no sidecar exists', async () => {
    // User already has mcp.freshell configured manually (no sidecar = user-managed).
    // Freshell must NOT overwrite it.
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({
          mcp: {
            freshell: { type: 'local', command: ['custom-server'] },
            other: { type: 'local', command: ['echo'] },
          },
        })
      }
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode') && !filePath.includes('.freshell-mcp-state')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-preserve', '/tmp/test-cwd')

    // opencode.json should NOT have been rewritten with Freshell's freshell entry
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    if (ocWrite) {
      // If it was written, the user's custom entry must be preserved
      const parsed = JSON.parse(ocWrite[1])
      expect(parsed.mcp.freshell.command).toEqual(['custom-server'])
    }
  })

  it('does not overwrite pre-existing user-managed freshell entry on second spawn (sidecar with createdEntry=false)', async () => {
    // Scenario: user had a pre-existing freshell entry → first spawn created a sidecar
    // with createdEntry=false → second spawn sees the sidecar but must still treat
    // the entry as user-managed and NOT overwrite it.
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({
          mcp: {
            freshell: { type: 'local', command: ['custom-server'] },
            other: { type: 'local', command: ['echo'] },
          },
        })
      }
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        // Sidecar exists from first spawn, but createdEntry=false means user owned the entry
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: false, createdEntry: false })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-second-spawn', '/tmp/test-cwd')

    // opencode.json should NOT be rewritten with Freshell's freshell entry
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    if (ocWrite) {
      // If it was written, the user's custom entry must be preserved
      const parsed = JSON.parse(ocWrite[1])
      expect(parsed.mcp.freshell.command).toEqual(['custom-server'])
    }

    // Sidecar refCount should be incremented
    const sidecarWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.json')
    )
    expect(sidecarWrite).toBeDefined()
    const sidecar = JSON.parse(sidecarWrite![1])
    expect(sidecar.refCount).toBe(2)
    expect(sidecar.createdEntry).toBe(false) // Must preserve createdEntry=false
  })

  it('overwrites freshell entry when sidecar exists (Freshell-managed)', async () => {
    // Sidecar exists = Freshell previously created this entry, safe to update
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({
          mcp: {
            freshell: { type: 'local', command: ['old-freshell-server'] },
            other: { type: 'local', command: ['echo'] },
          },
        })
      }
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: false })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-update', '/tmp/test-cwd')

    // opencode.json should be rewritten with Freshell's updated entry
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    // New entry must NOT be the old one
    expect(parsed.mcp.freshell.command).not.toEqual(['old-freshell-server'])
    // Other entries must be preserved
    expect(parsed.mcp.other).toBeDefined()
  })

  it('sidecar tracks createdEntry=true when Freshell creates the freshell key', async () => {
    // No pre-existing opencode.json or freshell entry
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true // cwd exists
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-new', '/tmp/test-cwd')

    const sidecarWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.json')
    )
    expect(sidecarWrite).toBeDefined()
    const sidecar = JSON.parse(sidecarWrite![1])
    expect(sidecar.createdEntry).toBe(true)
  })

  it('cleanup only removes freshell key when sidecar indicates Freshell created it', async () => {
    // Sidecar with createdEntry=true -> cleanup should remove the key
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: false, createdEntry: true })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: { freshell: { type: 'local', command: ['node'] }, other: { type: 'local', command: ['echo'] } } })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-ce', 'opencode', '/tmp/test-cwd')

    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    expect(parsed.mcp.freshell).toBeUndefined()
    expect(parsed.mcp.other).toBeDefined()
  })

  it('cleanup does not remove freshell key when sidecar has createdEntry=false (user entry preserved)', async () => {
    // Sidecar with createdEntry=false -> user had the entry first, don't remove it
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: false, createdFile: false, createdEntry: false })
      }
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return JSON.stringify({ mcp: { freshell: { type: 'local', command: ['custom-server'] } } })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && (filePath.includes('.freshell-mcp-state.json') || filePath.includes('opencode.json'))) return true
      return false
    })
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-user', 'opencode', '/tmp/test-cwd')

    // Should NOT rewrite opencode.json to remove the freshell key
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeUndefined()
  })
})

describe('opencode missing cwd error', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode mode throws a clear error when cwd is undefined', async () => {
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-nocwd')).toThrow(/cwd/i)
  })

  it('opencode mode throws a clear error when cwd is empty string', async () => {
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-nocwd', '')).toThrow(/cwd/i)
  })

  it('opencode mode throws a clear error when cwd directory does not exist', async () => {
    // existsSync returns false for the cwd itself -- means the directory doesn't exist on disk.
    // Per project philosophy: "Clear, user friendly errors are generally better than fallbacks."
    // mkdirSync({recursive:true}) should NOT silently create directories for invalid/mistyped cwd.
    mockFs.existsSync.mockImplementation((filePath: string) => {
      // The cwd itself does not exist
      if (filePath === '/nonexistent/project') return false
      // Nothing else exists either
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-bad-cwd', '/nonexistent/project')).toThrow(
      /cwd.*does not exist|does not exist.*cwd|directory.*not.*found/i,
    )
    // Must NOT create the .opencode directory inside a non-existent cwd
    const mkdirCalls = mockFs.mkdirSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.opencode')
    )
    expect(mkdirCalls).toHaveLength(0)
  })
})

describe('opencode WSL cwd path handling', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.readFileSync.mockReset()
    mockFs.existsSync.mockReset()
    mockFs.unlinkSync.mockReset()
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('opencode mode writes config to the cwd provided (Linux paths work from WSL)', async () => {
    // On WSL, cwd is a Linux path like /home/user/project.
    // OpenCode processes (even when spawned via Windows shells) access the same
    // filesystem, so writing .opencode/opencode.json under the Linux cwd is correct.
    // This test documents the design decision.
    const cwd = '/home/user/project'
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === cwd) return true
      return false
    })
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-wsl', cwd)

    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    // Config file path should be under the provided cwd
    expect(ocWrite![0]).toBe(path.join(cwd, '.opencode', 'opencode.json'))
  })

  it('opencode mode works with Windows-style cwd paths', async () => {
    // On native Windows, cwd is a Windows path. The config should be written there.
    const cwd = 'C:\\Users\\dev\\project'
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === cwd) return true
      return false
    })
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-win', cwd)

    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    // Config file path should be under the provided Windows cwd
    expect(ocWrite![0]).toBe(path.join(cwd, '.opencode', 'opencode.json'))
  })
})

describe('generateMcpInjection -- Windows platform path conversion', () => {
  const originalEnv = { ...process.env }
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.existsSync.mockReset().mockReturnValue(false)
    mockFs.readFileSync.mockReset()
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  async function importModule() {
    vi.doMock('fs', () => ({ ...mockFs, default: mockFs }))
    vi.doMock('os', () => ({ tmpdir: mockTmpdir, homedir: mockHomedir, default: { tmpdir: mockTmpdir, homedir: mockHomedir } }))
    return import('../../../../server/mcp/config-writer.js')
  }

  it('claude mode with platform=windows converts config file path to Windows format on WSL', async () => {
    // Simulate WSL environment
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // Mock child_process.execFileSync for wslpath conversion
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'wslpath' && args[0] === '-w') {
          // Convert /tmp/... to \\wsl.localhost\Ubuntu\tmp\...
          return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
        }
        throw new Error('unexpected execFileSync call')
      }),
      default: {
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === 'wslpath' && args[0] === '-w') {
            return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
          }
          throw new Error('unexpected execFileSync call')
        }),
      },
    }))

    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('claude', 'term-wsl-win', undefined, 'windows')
    expect(result.args).toContain('--mcp-config')
    const configIndex = result.args.indexOf('--mcp-config')
    const configPath = result.args[configIndex + 1]
    // Config path must be a Windows path (not a Linux path)
    expect(configPath).toContain('\\\\wsl.localhost\\')
    expect(configPath).not.toMatch(/^\/tmp\//)
  })

  it('claude mode with platform=windows writes Windows paths inside the config file on WSL', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'wslpath' && args[0] === '-w') {
          return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
        }
        throw new Error('unexpected execFileSync call')
      }),
      default: {
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === 'wslpath' && args[0] === '-w') {
            return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
          }
          throw new Error('unexpected execFileSync call')
        }),
      },
    }))

    const { generateMcpInjection } = await importModule()
    generateMcpInjection('claude', 'term-wsl-win2', undefined, 'windows')

    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('freshell-mcp')
    )
    expect(writeCall).toBeDefined()
    const parsed = JSON.parse(writeCall![1])
    // The args inside the config should be Windows paths
    const serverArgs = parsed.mcpServers.freshell.args as string[]
    for (const arg of serverArgs) {
      if (arg.startsWith('/')) {
        throw new Error(`Found Linux path inside Windows MCP config: ${arg}`)
      }
    }
  })

  it('gemini mode with platform=windows converts env var path to Windows format on WSL', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'wslpath' && args[0] === '-w') {
          return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
        }
        throw new Error('unexpected execFileSync call')
      }),
      default: {
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === 'wslpath' && args[0] === '-w') {
            return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
          }
          throw new Error('unexpected execFileSync call')
        }),
      },
    }))

    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('gemini', 'term-gem-win', undefined, 'windows')
    const envPath = result.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
    expect(envPath).toBeDefined()
    // Must be a Windows path on WSL
    expect(envPath).toContain('\\\\wsl.localhost\\')
    expect(envPath).not.toMatch(/^\/tmp\//)
  })

  it('claude mode with platform=unix returns Linux paths (no conversion)', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('claude', 'term-unix')
    expect(result.args).toContain('--mcp-config')
    const configIndex = result.args.indexOf('--mcp-config')
    const configPath = result.args[configIndex + 1]
    // Should remain a Linux path
    expect(configPath).toMatch(/^\/tmp\//)
  })

  it('codex mode with platform=windows converts TOML args to Windows paths on WSL', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'wslpath' && args[0] === '-w') {
          return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
        }
        throw new Error('unexpected execFileSync call')
      }),
      default: {
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === 'wslpath' && args[0] === '-w') {
            return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
          }
          throw new Error('unexpected execFileSync call')
        }),
      },
    }))

    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('codex', 'term-codex-win', undefined, 'windows')
    // Codex args should have Windows paths in the TOML values
    const argsStr = result.args.join(' ')
    expect(argsStr).toContain('mcp_servers.freshell')
    // Should not contain raw Linux paths in the TOML values
    const tomlArgsArg = result.args.find((a: string) => a.includes('mcp_servers.freshell.args'))
    expect(tomlArgsArg).toBeDefined()
    expect(tomlArgsArg).not.toMatch(/\["--import", "\//)
  })

  it('opencode mode with platform=windows writes Windows paths in config file on WSL', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // Mock cwd directory exists
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === '/home/testuser/project') return true
      if (p === path.join('/home/testuser/project', '.opencode')) return false
      if (p === path.join('/home/testuser/project', '.opencode', 'opencode.json')) return false
      return false
    })

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'wslpath' && args[0] === '-w') {
          return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
        }
        throw new Error('unexpected execFileSync call')
      }),
      default: {
        execFileSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === 'wslpath' && args[0] === '-w') {
            return `\\\\wsl.localhost\\Ubuntu${args[1].replace(/\//g, '\\')}\n`
          }
          throw new Error('unexpected execFileSync call')
        }),
      },
    }))

    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-oc-win', '/home/testuser/project', 'windows')

    // Find the opencode.json write
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    // The command array inside the config should contain Windows paths
    const command = parsed.mcp.freshell.command as string[]
    // command is ['node', '--import', '<tsx path>', '<server path>'] in dev mode
    // The paths (not 'node' or '--import') should be Windows paths on WSL
    for (const part of command) {
      if (part.startsWith('/') && !part.startsWith('/home')) {
        // Any absolute Linux path that isn't the cwd should have been converted
        throw new Error(`Found unconverted Linux path in OpenCode MCP config command: ${part}`)
      }
    }
    // At least one path should be a Windows UNC path
    const hasWindowsPath = command.some((p: string) => p.includes('\\\\wsl.localhost\\'))
    expect(hasWindowsPath).toBe(true)
  })
})
