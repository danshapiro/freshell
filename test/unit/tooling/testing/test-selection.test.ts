import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  buildVitestArgs,
  createStandardTestPlan,
} from '../../../../scripts/run-standard-tests.js'
import { classifyCommand } from '../../../../scripts/testing/coordinator-command-matrix.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(TEST_DIR, '../../../..')

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8')) as T
}

type PackageJson = {
  scripts?: Record<string, string>
}

describe('Rust-first build and test selection', () => {
  it('defines Rust source build/start scripts and removes Node-server scripts', () => {
    const scripts = readJson<PackageJson>('package.json').scripts ?? {}

    expect(scripts['dev:server']).toContain('cargo run -p freshell-server --locked')
    expect(scripts.dev).toContain('cargo run -p freshell-server --locked')
    expect(scripts['build:rust']).toContain('cargo build --release -p freshell-server --locked')
    expect(scripts['check:rust']).toContain('cargo check --workspace --locked')
    expect(scripts['test:rust']).toContain('scripts/testing/run-rust-tests.ts')
    expect(scripts.start).toContain('scripts/start-rust-server.ts')
    expect(scripts.build).toContain('build:tools')
    expect(scripts.build).toContain('build:rust')

    expect(scripts['typecheck:server']).toBeUndefined()
    expect(scripts['build:server']).toBeUndefined()
    expect(scripts['test:server:standard']).toBeUndefined()
    expect(scripts['test:server:aggressive']).toBeUndefined()
    expect(scripts[['test:real', 'coding-cli-contracts'].join(':')]).toBeUndefined()
    expect(scripts[['test:codex-real-provider', 'smoke'].join('-')]).toBeUndefined()
    expect(scripts[['test:opencode-serve', 'smoke'].join('-')]).toBeUndefined()
  })

  it('runs client, source-runtime, Rust, and Electron phases without vacuous Vitest flags', () => {
    const plan = createStandardTestPlan({
      availableParallelism: 8,
      ci: false,
      forwardedArgs: [],
    })
    const runs = plan.stages.flat()

    expect(runs.map((run) => run.name)).toEqual([
      'client',
      'source-runtime',
      'rust',
      'electron',
    ])
    expect(runs.find((run) => run.name === 'client')?.configPath).toBe('config/vitest/vitest.config.ts')
    expect(runs.find((run) => run.name === 'source-runtime')?.script).toBe('test:source-runtime')
    expect(runs.find((run) => run.name === 'rust')?.script).toBe('test:rust')
    expect(runs.find((run) => run.name === 'electron')?.configPath).toBe('config/vitest/vitest.electron.config.ts')
    expect(buildVitestArgs({ configPath: 'config/vitest/vitest.config.ts', forwardedArgs: [] })).not.toContain(['--pass', 'WithNoTests'].join(''))
  })

  it('maps server and integration public commands to explicit Rust cargo phases', () => {
    const server = classifyCommand({ commandKey: 'test:server', forwardedArgs: [] })
    expect(server.kind).toBe('coordinated')
    if (server.kind === 'coordinated') {
      expect(server.phases).toEqual([{ runner: 'cargo', args: ['test', '-p', 'freshell-server', '--locked'] }])
    }

    const integration = classifyCommand({ commandKey: 'test:integration', forwardedArgs: [] })
    expect(integration.kind).toBe('coordinated')
    if (integration.kind === 'coordinated') {
      expect(integration.phases).toEqual([{ runner: 'cargo', args: ['test', '--workspace', '--tests', '--locked'] }])
    }
  })

  it('selects the visible-first harness while excluding artifact-dependent integration trees', async () => {
    const configSource = readFileSync(path.join(PROJECT_ROOT, 'config/vitest/vitest.config.ts'), 'utf8')
    expect(configSource).not.toContain("'test/unit/visible-first/cli-command-harness.test.ts'")
    expect(configSource).toContain("'test/integration/tooling/**'")
    expect(configSource).toContain("'test/integration/electron/**'")
    expect(configSource).not.toContain(['vitest', 'server.config'].join('.'))

    const runtimeConfig = path.join(PROJECT_ROOT, 'config/vitest/vitest.runtime.config.ts')
    expect(readFileSync(runtimeConfig, 'utf8')).toContain('source-runtime-rust.test.ts')
  })

  it('keeps the runtime wrapper and launchers on the closed Rust contract', () => {
    const scripts = readJson<PackageJson>('package.json').scripts ?? {}
    expect(scripts['test:source-runtime']).toBe('tsx scripts/testing/run-source-runtime-tests.ts')
    expect(scripts['test:rust']).toContain('scripts/testing/run-rust-tests.ts')

    const launch = readFileSync(path.join(PROJECT_ROOT, 'scripts/launch.sh'), 'utf8')
    expect(launch).toContain('launch-rust.sh')
    expect(launch).not.toContain('npm start')
    expect(readFileSync(path.join(PROJECT_ROOT, 'run-rust-server.sh'), 'utf8')).not.toContain('Legacy server:')
  })
})
