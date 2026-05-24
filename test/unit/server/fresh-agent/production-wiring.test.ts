import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../../..')

describe('fresh-agent production wiring', () => {
  it('wires the runtime manager, REST router, and WebSocket handler in server/index.ts', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'server/index.ts'), 'utf8')

    expect(source).toContain('FreshAgentRuntimeManager')
    expect(source).toContain('createFreshAgentProviderRegistry')
    expect(source).toContain('createFreshAgentRouter')
    expect(source).toContain('createClaudeFreshAgentAdapter')
    expect(source).toContain('createCodexFreshAgentAdapter')
    expect(source).toContain('createOpencodeFreshAgentAdapter')
    expect(source).toMatch(/const freshAgentRuntimeManager = new FreshAgentRuntimeManager\(/)
    expect(source).toMatch(/freshAgentRuntimeManager,\s*\n/)
    expect(source).toMatch(/app\.use\('\/api', createFreshAgentRouter\(\{\s*runtimeManager: freshAgentRuntimeManager/)
    expect(source).toContain('codexFreshAgentRuntime')
    expect(source).toContain("sessionType: 'freshopencode'")
    expect(source).toMatch(/codexFreshAgentRuntime,\s*\n\s*terminalShutdownTimeoutMs/)
  })
})
