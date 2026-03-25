import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const { mockConnect, mockRegisterTool, mockMcpServer, mockStdioTransport, mockExecuteAction } = vi.hoisted(() => {
  const mockConnect = vi.fn().mockResolvedValue(undefined)
  const mockRegisterTool = vi.fn()
  const mockMcpServer = vi.fn().mockReturnValue({
    tool: mockRegisterTool,
    connect: mockConnect,
  })
  const mockStdioTransport = vi.fn()
  const mockExecuteAction = vi.fn().mockResolvedValue({ ok: true })
  return { mockConnect, mockRegisterTool, mockMcpServer, mockStdioTransport, mockExecuteAction }
})

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: mockMcpServer,
}))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: mockStdioTransport,
}))
vi.mock('../../../../server/mcp/freshell-tool.js', () => ({
  TOOL_DESCRIPTION: 'Test tool description',
  INSTRUCTIONS: 'Test instructions',
  INPUT_SCHEMA: {
    action: { _def: {} },
    params: { _def: {} },
  },
  executeAction: mockExecuteAction,
}))

describe('MCP server initialization', () => {
  beforeEach(() => {
    vi.resetModules()
    mockMcpServer.mockClear()
    mockRegisterTool.mockClear()
    mockConnect.mockClear()
    mockStdioTransport.mockClear()
    mockExecuteAction.mockClear()

    // Re-mock after resetModules
    mockMcpServer.mockReturnValue({
      tool: mockRegisterTool,
      connect: mockConnect,
    })
  })

  async function importServer() {
    // Re-register mocks after resetModules
    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: mockMcpServer,
    }))
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: mockStdioTransport,
    }))
    vi.doMock('../../../../server/mcp/freshell-tool.js', () => ({
      TOOL_DESCRIPTION: 'Test tool description',
      INSTRUCTIONS: 'Test instructions',
      INPUT_SCHEMA: {
        action: { _def: {} },
        params: { _def: {} },
      },
      executeAction: mockExecuteAction,
    }))
    return import('../../../../server/mcp/server.js')
  }

  it('creates McpServer with name "freshell"', async () => {
    await importServer()
    expect(mockMcpServer).toHaveBeenCalledOnce()
    const [info] = mockMcpServer.mock.calls[0]
    expect(info.name).toBe('freshell')
  })

  it('passes INSTRUCTIONS as server instructions', async () => {
    await importServer()
    const [, opts] = mockMcpServer.mock.calls[0]
    expect(opts.instructions).toBe('Test instructions')
  })

  it('registers exactly one tool named "freshell"', async () => {
    await importServer()
    expect(mockRegisterTool).toHaveBeenCalledOnce()
    const [toolName] = mockRegisterTool.mock.calls[0]
    expect(toolName).toBe('freshell')
  })

  it('tool registration includes correct description', async () => {
    await importServer()
    // server.tool(name, description, inputSchema, handler)
    const [, description] = mockRegisterTool.mock.calls[0]
    expect(description).toBe('Test tool description')
  })

  it('tool registration includes inputSchema with action and params', async () => {
    await importServer()
    // server.tool(name, description, inputSchema, handler)
    const [,, inputSchema] = mockRegisterTool.mock.calls[0]
    expect(inputSchema).toHaveProperty('action')
    expect(inputSchema).toHaveProperty('params')
  })

  it('tool handler calls executeAction and wraps result in MCP content format', async () => {
    await importServer()
    // server.tool(name, description, inputSchema, handler)
    const handler = mockRegisterTool.mock.calls[0][3]
    mockExecuteAction.mockResolvedValue({ ok: true })
    const result = await handler({ action: 'health', params: {} })
    expect(mockExecuteAction).toHaveBeenCalledWith('health', {})
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    })
  })

  it('tool handler handles undefined result gracefully (no invalid JSON)', async () => {
    await importServer()
    const handler = mockRegisterTool.mock.calls[0][3]
    mockExecuteAction.mockResolvedValue(undefined)
    const result = await handler({ action: 'navigate', params: { target: 'p1', url: 'https://example.com' } })
    // Must produce valid JSON, not the literal string "undefined"
    expect(result.content[0].type).toBe('text')
    const text = result.content[0].text
    // Text must be valid JSON (JSON.parse should not throw)
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('connects via StdioServerTransport', async () => {
    await importServer()
    expect(mockConnect).toHaveBeenCalledOnce()
    expect(mockStdioTransport).toHaveBeenCalled()
  })
})

describe('MCP server process-level smoke test', () => {
  it('spawns real MCP server and responds to JSON-RPC initialize', async () => {
    const { spawn } = await import('child_process')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(__dirname, '..', '..', '..', '..')
    const serverPath = resolve(repoRoot, 'server/mcp/server.ts')
    const tsxLoaderPath = resolve(repoRoot, 'node_modules/tsx/dist/esm/index.mjs')

    const child = spawn('node', ['--import', tsxLoaderPath, serverPath], {
      env: {
        ...process.env,
        FRESHELL_URL: 'http://localhost:3001',
        FRESHELL_TOKEN: 'test-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const cleanup = () => {
      try { child.kill() } catch { /* ignore */ }
    }

    try {
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      })

      // Write the JSON-RPC request (MCP stdio transport uses Content-Length framing like LSP)
      child.stdin!.write(initRequest + '\n')

      const response = await new Promise<string>((resolve, reject) => {
        let buffer = ''
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for MCP response')), 10000)
        child.stdout!.on('data', (data: Buffer) => {
          buffer += data.toString()
          // Try to find a complete JSON-RPC response in the buffer.
          // The SDK may or may not use Content-Length framing on stdout.
          // Try both: raw JSON line, and Content-Length framed.
          try {
            // Try raw JSON first (the line may contain just the JSON object)
            const lines = buffer.split('\n').filter(l => l.trim())
            for (const line of lines) {
              const trimmed = line.trim()
              if (trimmed.startsWith('{')) {
                JSON.parse(trimmed)
                clearTimeout(timeout)
                resolve(trimmed)
                return
              }
            }
          } catch {
            // Not complete JSON yet
          }
          // Also try Content-Length framed
          const headerEnd = buffer.indexOf('\r\n\r\n')
          if (headerEnd !== -1) {
            const body = buffer.slice(headerEnd + 4)
            try {
              JSON.parse(body)
              clearTimeout(timeout)
              resolve(body)
            } catch {
              // Not complete yet
            }
          }
        })
        child.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      const parsed = JSON.parse(response)
      expect(parsed.result).toBeDefined()
      expect(parsed.result.serverInfo.name).toBe('freshell')
    } finally {
      cleanup()
    }
  }, 15000)

  it('MCP server does not write to stdout outside JSON-RPC', async () => {
    const { spawn } = await import('child_process')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(__dirname, '..', '..', '..', '..')
    const serverPath = resolve(repoRoot, 'server/mcp/server.ts')
    const tsxLoaderPath = resolve(repoRoot, 'node_modules/tsx/dist/esm/index.mjs')

    const child = spawn('node', ['--import', tsxLoaderPath, serverPath], {
      env: {
        ...process.env,
        FRESHELL_URL: 'http://localhost:3001',
        FRESHELL_TOKEN: 'test-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    try {
      // Wait briefly, then check that no output was written to stdout
      // (only JSON-RPC frames should appear after initialization)
      await new Promise((resolve) => setTimeout(resolve, 1000))

      let stdoutData = ''
      child.stdout!.on('data', (data: Buffer) => {
        stdoutData += data.toString()
      })

      // Give it a moment to flush
      await new Promise((resolve) => setTimeout(resolve, 500))

      // If there is any output, it should only be valid JSON-RPC frames
      if (stdoutData) {
        // Each frame starts with Content-Length header
        const lines = stdoutData.split('\r\n')
        for (const line of lines) {
          if (line.trim() && !line.startsWith('Content-Length:') && !line.startsWith('{')) {
            throw new Error(`Unexpected stdout output: ${line}`)
          }
        }
      }
    } finally {
      child.kill()
    }
  }, 10000)
})
