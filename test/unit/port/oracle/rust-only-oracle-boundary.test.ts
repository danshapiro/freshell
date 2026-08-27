// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd())

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

describe('Rust-only oracle boundary', () => {
  it('contains no retired Node target, proxy, listener, or generator path', () => {
    const activePaths = [
      'port/oracle/harness/external-server.ts',
      'port/oracle/harness/normalize.ts',
      'port/oracle/harness/invariants.ts',
      'port/oracle/harness/t2-live.ts',
      'port/oracle/harness/t2-live-claude.ts',
      'port/oracle/harness/t2-live-codex.ts',
      'config/vitest/vitest.oracle.config.ts',
      ...fs.readdirSync(path.join(root, 'test/unit/port/oracle'))
        .filter((entry) => entry.endsWith('.test.ts') && entry !== 'rust-only-oracle-boundary.test.ts')
        .map((entry) => path.join('test/unit/port/oracle', entry)),
    ]
    const source = activePaths.map((file) => `${file}\n${read(file)}`).join('\n')
    const forbidden = [
      /target\s*:\s*['"]node['"]/,
      /FRESHELL_ORACLE_TARGET/,
      /legacy-node-server/,
      /opencode-warm-proxy/,
      /(?:npm run )?build:server/,
      /dist\/server\/index/,
      /new\s+TestServer/,
      /warmProxy/,
      /baselines\/t2/,
      /listenersOn3001/,
      /ss\s+[^\n]*3001/,
      /generate-(?:manifest-oracle|batch-goldens|pty-goldens|handshake-fixture)/,
    ]
    for (const pattern of forbidden) {
      expect(source, `active oracle source contains retired pattern ${pattern}`).not.toMatch(pattern)
    }
  })

  it('keeps the ownership boundary on an allocated non-production port', () => {
    const source = read('port/oracle/harness/external-server.ts')
    expect(source).toMatch(/findFreePort\(\)/)
    expect(source).toMatch(/port\)\.not\.toBe\(3001\)|port !== 3001|(?:requestedPort|port)\s*===\s*3001/)
  })
})
