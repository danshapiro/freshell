// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..')

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8')
}

function runContainerLayoutFixture(fixture: string) {
  return spawnSync(
    'bash',
    [path.join(PROJECT_ROOT, 'scripts/verify-container-layout.sh'), '--fixture', path.join(PROJECT_ROOT, fixture)],
    { cwd: PROJECT_ROOT, encoding: 'utf8' },
  )
}

function diagnostics(output: string): Array<Record<string, unknown>> {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const NODE_PTY_RETIREMENT_TERM = /node-pty/

const FORBIDDEN_DISTRIBUTION_TERMS = [
  /node dist\/server/,
  /build:server/,
  /dist\/server/,
  /server-node-modules/,
  /vitest\.server/,
  /--passWithNoTests/,
  /legacy-chromium/,
  NODE_PTY_RETIREMENT_TERM,
]

describe('Rust-only distribution runtime contracts', () => {
  it('builds and launches the example image with the Rust server', () => {
    const dockerfile = readProjectFile('examples/docker/Dockerfile')

    expect(dockerfile).toMatch(/FROM rust:[^\n]+ AS rust-builder/)
    expect(dockerfile).toContain('cargo build --release -p freshell-server --locked')
    expect(dockerfile).toContain('npm run build:client')
    expect(dockerfile).toContain('CMD ["\/app\/freshell-server"]')
    expect(dockerfile).not.toMatch(/node\s+dist\//)
    for (const term of FORBIDDEN_DISTRIBUTION_TERMS) expect(dockerfile).not.toMatch(term)
  })

  it('builds the Cloud Run image with only Rust/client/tools runtime artifacts', () => {
    const dockerfile = readProjectFile('docker/cloud-run/Dockerfile')

    expect(dockerfile).toMatch(/FROM rust:[^\n]+ AS rust-builder/)
    expect(dockerfile).toContain('cargo build --release -p freshell-server --locked')
    expect(dockerfile).toContain('npm ci --ignore-scripts')
    expect(dockerfile).toContain('npm run build:client && npm run build:tools')
    expect(dockerfile).toContain('target/release/freshell-server')
    expect(dockerfile).toContain('dist/client')
    expect(dockerfile).toContain('dist/tools')
    expect(dockerfile).toContain('RETIRED_BACKEND_DIRECTORIES')
    expect(dockerfile).toContain('node_modules/node-pty')
    expect(dockerfile).toContain('test ! -e "/app/$relative"')
    expect(dockerfile).toMatch(
      /RETIRED_BACKEND_DIRECTORIES[\s\S]*node_modules\/node-pty[\s\S]*test ! -e "\/app\/\$relative"/,
    )
    for (const term of FORBIDDEN_DISTRIBUTION_TERMS) {
      if (term === NODE_PTY_RETIREMENT_TERM) continue
      expect(dockerfile).not.toMatch(term)
    }
  })

  it('fails closed when Cloud Run discovery cannot produce a nonempty selection', () => {
    const entrypoint = readProjectFile('docker/cloud-run/entrypoint.sh')

    expect(entrypoint).toContain('playwright test --config "$CONFIG" --list')
    expect(entrypoint).toContain('No spec files discovered')
    expect(entrypoint).toMatch(/No spec files discovered[\s\S]*exit 1/)
    expect(entrypoint).not.toMatch(/falling back to glob/)
    expect(entrypoint).not.toMatch(/No spec files found\. Running all tests/)
    for (const term of FORBIDDEN_DISTRIBUTION_TERMS) expect(entrypoint).not.toMatch(term)
  })

  it('keeps duration estimates tied to the single Chromium browser project', () => {
    const durations = readProjectFile('docker/cloud-run/test-durations.txt')

    expect(durations).toContain('single Chromium project')
    expect(durations).not.toMatch(/legacy-chromium|rust-chromium/)
  })

  it('owns Rust formatting, linting, workspace tests, and source-runtime smoke in CI', () => {
    const workflow = readProjectFile('.github/workflows/rust-clippy.yml')

    expect(workflow).toContain('toolchain: 1.96.0')
    expect(workflow).toContain('cargo fmt --all --check')
    expect(workflow).toContain('cargo clippy --workspace --all-targets --locked')
    expect(workflow).toContain('cargo build -p freshell-server --locked')
    expect(workflow).toContain('cargo test --workspace --locked')
    expect(workflow).toContain('npm run test:source-runtime')
    expect(workflow).toContain('FRESHELL_SERVER_BIN:')
    expect(workflow.indexOf('cargo build -p freshell-server --locked')).toBeLessThan(
      workflow.indexOf('npm run test:source-runtime'),
    )
    for (const term of FORBIDDEN_DISTRIBUTION_TERMS) expect(workflow).not.toMatch(term)
  })

  it('requires checkout-free Electron acceptance to prove an authenticated PTY round trip', () => {
    const acceptance = readProjectFile('test/integration/electron/checkout-free-runtime.test.ts')

    expect(acceptance).toContain("import WebSocket from 'ws'")
    expect(acceptance).toContain("type: 'terminal.create'")
    expect(acceptance).toContain("message.type === 'terminal.created'")
    expect(acceptance).toContain("type: 'terminal.input'")
    expect(acceptance).toContain('FRESHELL_ELECTRON_PTY_ROUNDTRIP_MARKER')
    expect(acceptance).toContain("message.type === 'terminal.output'")
    expect(acceptance).toContain("type: 'terminal.detach'")
    expect(acceptance).toMatch(/await closeWebSocket\(ws\)/)
  })

  it('runs the nonempty default Vitest lane without artifact prerequisites', () => {
    const workflow = readProjectFile('.github/workflows/typecheck-client.yml')
    const vitestConfig = readProjectFile('config/vitest/vitest.config.ts')

    expect(workflow).toContain('npm run typecheck:client')
    expect(workflow).toContain('npm run test:vitest')
    expect(workflow).toContain('config/vitest/vitest.config.ts')
    expect(workflow).not.toContain('cargo build')
    expect(workflow).not.toContain('prepare:electron-runtime')
    expect(vitestConfig).toContain("'test/integration/tooling/**'")
    expect(vitestConfig).toContain("'test/integration/electron/**'")
  })

  for (const workflowPath of ['.github/workflows/electron-build.yml', '.github/workflows/electron-release.yml']) {
    it(`${workflowPath} builds and verifies native artifacts on every required OS`, () => {
      const workflow = readProjectFile(workflowPath)

      for (const target of ['macos-15-intel', 'macos-latest', 'ubuntu-latest', 'windows-2022']) {
        expect(workflow).toContain(target)
      }
      if (workflowPath.endsWith('electron-build.yml')) {
        expect(workflow).toContain("'crates/**'")
        expect(workflow).toContain("'Cargo.toml'")
        expect(workflow).toContain("'Cargo.lock'")
        expect(workflow).toContain("'scripts/bundled-node-version.json'")
        expect(workflow).toContain("'tools/**'")
      }
      expect(workflow).toContain('toolchain: 1.96.0')
      expect(workflow).toContain('cargo build --release -p freshell-server --locked')
      expect(workflow).toContain('npm run verify:electron-artifact')
      expect(workflow).toContain('npm run test:electron:runtime')
      expect(workflow).toContain('release/*.dmg')
      expect(workflow).toContain('release/*.AppImage')
      expect(workflow).toContain('release/*.deb')
      expect(workflow).toContain('release/*.exe')
      for (const term of FORBIDDEN_DISTRIBUTION_TERMS) expect(workflow).not.toMatch(term)
    })
  }

  it('accepts the Rust/client/tools fixture and emits sorted JSONL evidence', () => {
    const result = runContainerLayoutFixture('test/fixtures/distribution/rust-only')

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const entries = diagnostics(result.stdout)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ severity: 'info', event: 'container_layout_verified' })
    expect(entries[0].evidence).toEqual([...(entries[0].evidence as string[])].sort())
  })

  it('rejects a staged legacy server artifact and reports sorted evidence', () => {
    const result = runContainerLayoutFixture('test/fixtures/distribution/node-server')

    expect(result.status).toBe(1)
    const entries = diagnostics(result.stdout)
    expect(entries.some((entry) => entry.event === 'container_layout_forbidden_artifacts')).toBe(true)
    const forbidden = entries.find((entry) => entry.event === 'container_layout_forbidden_artifacts')
    expect(forbidden?.evidence).toEqual([...(forbidden?.evidence as string[])].sort())
    expect(forbidden?.evidence).toEqual(expect.arrayContaining([
      'dist/server/index.js',
      'node_modules/node-pty/index.js',
    ]))
  })

})
