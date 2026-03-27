// Tests for the MCP config writer module.
// Validates per-agent MCP config generation, cleanup, and OpenCode sidecar management.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'

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

  it('kimi mode: returns args with --mcp-config-file pointing to temp file', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('kimi', 'term-jkl')
    expect(result.args).toContain('--mcp-config-file')
    const configIndex = result.args.indexOf('--mcp-config-file')
    expect(result.args[configIndex + 1]).toMatch(/freshell-mcp\/term-jkl\.json$/)
    expect(result.env).toEqual({})
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
      if (filePath === '/tmp/test-cwd') return true
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
      if (filePath === '/tmp/test-cwd') return true
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
      if (filePath === '/tmp/test-cwd') return true
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
  })

  it('unknown mode: returns empty args and env', async () => {
    const { generateMcpInjection } = await importModule()
    const result = generateMcpInjection('unknown-mode' as any, 'term-xyz')
    expect(result).toEqual({ args: [], env: {} })
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
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeDefined()
    const parsed = JSON.parse(ocWrite![1])
    expect(parsed.mcp.other).toBeDefined()
    expect(parsed.mcp.freshell).toBeUndefined()
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.freshell-mcp-state.json'))
  })

  it('opencode cleanup deletes file and dir when freshell was only entry and both were created by Freshell', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.json')) {
        return JSON.stringify({ managedKey: 'freshell', refCount: 1, createdDir: true, createdFile: true, createdEntry: true })
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
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('opencode.json'))
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.freshell-mcp-state.json'))
    expect(mockFs.rmdirSync).toHaveBeenCalledWith(expect.stringContaining('.opencode'))
  })

  it('opencode cleanup skips key removal when no sidecar exists (user-managed)', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockReturnValue(false)
    const { cleanupMcpConfig } = await importModule()
    cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeUndefined()
  })

  it('opencode cleanup decrements refcount when > 1', async () => {
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
    const sidecarWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.json')
    )
    expect(sidecarWrite).toBeDefined()
    const parsed = JSON.parse(sidecarWrite![1])
    expect(parsed.refCount).toBe(1)
  })

  it('cleanup does not remove freshell key when sidecar has createdEntry=false', async () => {
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
    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    expect(ocWrite).toBeUndefined()
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

  it('throws clear error when existing config is malformed JSON', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) {
        return 'not valid json{'
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
    expect(() => generateMcpInjection('opencode', 'term-bad', '/tmp/test-cwd')).toThrow(
      /opencode\.json.*malformed|malformed.*JSON/i,
    )
  })

  it('throws clear error when config is JSON null', async () => {
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return 'null'
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
      /not a valid object/i,
    )
  })

  it('throws clear error when mcp field is not an object', async () => {
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
      /not a valid object/i,
    )
  })
})

describe('opencode lock contention', () => {
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

  it('acquires and releases a lock file', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-lock', '/tmp/test-cwd')

    const lockWrites = mockFs.writeFileSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockWrites.length).toBeGreaterThanOrEqual(1)
    const lockUnlinks = mockFs.unlinkSync.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('.freshell-mcp-state.lock')
    )
    expect(lockUnlinks.length).toBeGreaterThanOrEqual(1)
  })

  it('throws when lock cannot be acquired after retries', async () => {
    mockFs.writeFileSync.mockImplementation((filePath: string, _data: any, opts: any) => {
      if (typeof filePath === 'string' && filePath.includes('.freshell-mcp-state.lock')) {
        const err: any = new Error('EEXIST')
        err.code = 'EEXIST'
        throw err
      }
    })
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() })
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-lock-fail', '/tmp/test-cwd')).toThrow(/lock/i)
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
      if (filePath === '/tmp/test-cwd') return true
      if (typeof filePath === 'string' && filePath.includes('opencode.json')) return true
      if (typeof filePath === 'string' && filePath.includes('.opencode') && !filePath.includes('.freshell-mcp-state')) return true
      return false
    })
    const { generateMcpInjection } = await importModule()
    generateMcpInjection('opencode', 'term-preserve', '/tmp/test-cwd')

    const ocWrite = mockFs.writeFileSync.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('opencode.json')
    )
    if (ocWrite) {
      const parsed = JSON.parse(ocWrite[1])
      expect(parsed.mcp.freshell.command).toEqual(['custom-server'])
    }
  })

  it('sidecar tracks createdEntry=true when Freshell creates the freshell key', async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockFs.existsSync.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/test-cwd') return true
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

  it('throws when cwd is undefined', async () => {
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-nocwd')).toThrow(/cwd/i)
  })

  it('throws when cwd directory does not exist', async () => {
    mockFs.existsSync.mockReturnValue(false)
    const { generateMcpInjection } = await importModule()
    expect(() => generateMcpInjection('opencode', 'term-bad-cwd', '/nonexistent/project')).toThrow(
      /cwd.*does not exist/i,
    )
  })
})
