// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..')

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8')
}

function runContainerLayoutFixture(fixture: string, runtimeOnly = false) {
  const fixturePath = path.isAbsolute(fixture) ? fixture : path.join(PROJECT_ROOT, fixture)
  const runtimeFlag = runtimeOnly ? ['--runtime-root'] : []
  return spawnSync(
    'bash',
    [path.join(PROJECT_ROOT, 'scripts/verify-container-layout.sh'), '--fixture', fixturePath, ...runtimeFlag],
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

const FORBIDDEN_DISTRIBUTION_TERMS = [
  /node dist\/server/,
  /build:server/,
  /dist\/server/,
  /server-node-modules/,
  /vitest\.server/,
  /--passWithNoTests/,
  /legacy-chromium/,
]

const RETIRED_BACKEND_PACKAGES = [
  '@ai-sdk/google',
  '@anthropic-ai/claude-agent-sdk',
  'ai',
  'cookie-parser',
  'express',
  'express-rate-limit',
  'pino',
  'rotating-file-stream',
  'is-port-reachable',
  '@types/cookie-parser',
  '@types/express',
  '@types/supertest',
  'supertest',
  'superwstest',
  'pino-pretty',
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
    const sourceCopy = dockerfile.lastIndexOf('COPY . .')
    const runtimeGuard = dockerfile.indexOf('RUN scripts/verify-container-layout.sh --fixture /app --runtime-root')
    expect(sourceCopy).toBeGreaterThanOrEqual(0)
    expect(runtimeGuard).toBeGreaterThan(sourceCopy)
    expect(dockerfile).not.toContain('RETIRED_BACKEND_DIRECTORIES')
    expect(dockerfile).not.toContain('rm -rf "/app/$relative"')
    expect(dockerfile).not.toContain('node_modules/chokidar')
    expect(dockerfile).not.toContain('node_modules/dotenv')
    for (const term of FORBIDDEN_DISTRIBUTION_TERMS) expect(dockerfile).not.toMatch(term)
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
    expect(forbidden).toMatchObject({ count: 2, evidence_truncated: false })
    expect(forbidden?.evidence).toEqual([...(forbidden?.evidence as string[])].sort())
    expect(forbidden?.evidence).toEqual(expect.arrayContaining([
      'dist/server/index.js',
      'node_modules/node-pty/index.js',
    ]))
  })

  it('rejects direct retired backend packages but permits nested generic dependencies', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-direct-retired-'))
    const directRetiredPackages = RETIRED_BACKEND_PACKAGES
    const nestedRetainedPackages = ['express', 'glob', 'pino']

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      for (const dependency of directRetiredPackages) {
        const dependencyPath = path.join(fixtureRoot, 'node_modules', dependency, 'index.js')
        mkdirSync(path.dirname(dependencyPath), { recursive: true })
        writeFileSync(dependencyPath, 'retired backend package')
      }
      for (const dependency of nestedRetainedPackages) {
        const dependencyPath = path.join(fixtureRoot, 'node_modules/retained/node_modules', dependency, 'index.js')
        mkdirSync(path.dirname(dependencyPath), { recursive: true })
        writeFileSync(dependencyPath, 'nested retained package')
      }

      const result = runContainerLayoutFixture(fixtureRoot, true)

      expect(result.status).toBe(1)
      const forbidden = diagnostics(result.stdout).find(
        (entry) => entry.event === 'container_layout_forbidden_artifacts',
      )
      expect(forbidden).toMatchObject({ count: directRetiredPackages.length, evidence_truncated: false })
      expect(forbidden?.evidence).toEqual(expect.arrayContaining(
        directRetiredPackages.map((dependency) => `node_modules/${dependency}/index.js`),
      ))
      for (const dependency of nestedRetainedPackages) {
        expect(forbidden?.evidence).not.toContain(`node_modules/retained/node_modules/${dependency}/index.js`)
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('retains lockfile tooling and generic transitive dependencies', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-dependencies-'))
    const topLevelRetainedDependencies = ['chokidar', 'dotenv', 'glob', 'node-gyp']
    const nestedRetainedDependencies = RETIRED_BACKEND_PACKAGES

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      // node-gyp is a lockfile-installed Electron build dependency, not a
      // shipped Freshell backend artifact; keep this retained-package control
      // so adding a node-gyp ban to the runtime guard fails loudly.
      for (const dependency of topLevelRetainedDependencies) {
        mkdirSync(path.join(fixtureRoot, 'node_modules', dependency), { recursive: true })
      }
      for (const dependency of nestedRetainedDependencies) {
        mkdirSync(path.join(fixtureRoot, 'node_modules/retained/node_modules', dependency), { recursive: true })
      }
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      for (const dependency of topLevelRetainedDependencies) {
        writeFileSync(path.join(fixtureRoot, 'node_modules', dependency, 'index.js'), 'retained package')
      }
      for (const dependency of nestedRetainedDependencies) {
        writeFileSync(
          path.join(fixtureRoot, 'node_modules/retained/node_modules', dependency, 'index.js'),
          'nested retained package',
        )
      }
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      const retained = runContainerLayoutFixture(fixtureRoot, true)
      expect(retained.status).toBe(0)
      expect(diagnostics(retained.stdout)[0]).toMatchObject({
        severity: 'info',
        event: 'container_layout_verified',
      })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects nested node-pty and dist/server runtime components', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-nested-retired-'))

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'node_modules/retained/node_modules/node-pty'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'node_modules/retained/dist/server'), { recursive: true })
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      writeFileSync(
        path.join(fixtureRoot, 'node_modules/retained/node_modules/node-pty/index.js'),
        'legacy native module',
      )
      writeFileSync(path.join(fixtureRoot, 'node_modules/retained/dist/server/index.js'), 'legacy backend')
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      const result = runContainerLayoutFixture(fixtureRoot, true)

      expect(result.status).toBe(1)
      const forbidden = diagnostics(result.stdout).find(
        (entry) => entry.event === 'container_layout_forbidden_artifacts',
      )
      expect(forbidden).toMatchObject({ count: 2, evidence_truncated: false })
      expect(typeof forbidden?.count).toBe('number')
      expect(typeof forbidden?.evidence_truncated).toBe('boolean')
      expect(forbidden?.evidence).toEqual(expect.arrayContaining([
        'node_modules/retained/dist/server/index.js',
        'node_modules/retained/node_modules/node-pty/index.js',
      ]))
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('bounds forbidden diagnostics when many retired artifacts are present', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-bounded-forbidden-'))

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'node_modules/node-pty'), { recursive: true })
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      for (let index = 0; index < 40; index += 1) {
        writeFileSync(path.join(fixtureRoot, 'node_modules/node-pty', `file-${index}.js`), 'legacy native module')
      }
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      const result = runContainerLayoutFixture(fixtureRoot, true)

      expect(result.status).toBe(1)
      const forbidden = diagnostics(result.stdout).find(
        (entry) => entry.event === 'container_layout_forbidden_artifacts',
      )
      expect(forbidden).toMatchObject({ count: 40, evidence_truncated: true })
      expect(typeof forbidden?.count).toBe('number')
      expect(typeof forbidden?.evidence_truncated).toBe('boolean')
      expect(forbidden?.evidence).toHaveLength(20)
      expect(result.stdout.length).toBeLessThan(4000)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('suppresses success evidence for a large retained node_modules tree', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-bounded-success-'))

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'node_modules/retained'), { recursive: true })
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      for (let index = 0; index < 2000; index += 1) {
        writeFileSync(path.join(fixtureRoot, 'node_modules/retained', `file-${index}.js`), 'retained package')
      }
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      const result = runContainerLayoutFixture(fixtureRoot, true)

      expect(result.status).toBe(0)
      const verified = diagnostics(result.stdout)[0]
      expect(verified).toMatchObject({
        severity: 'info',
        event: 'container_layout_verified',
        evidence: [],
        scanned_files: 2003,
      })
      expect(typeof verified.scanned_files).toBe('number')
      expect(result.stdout.length).toBeLessThan(500)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('can check shipped runtime roots without rejecting source-only fixtures', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-runtime-roots-'))

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'test/fixtures/distribution/node-server/node_modules/node-pty'), { recursive: true })
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      writeFileSync(
        path.join(fixtureRoot, 'test/fixtures/distribution/node-server/node_modules/node-pty/index.js'),
        'legacy fixture',
      )
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      const result = runContainerLayoutFixture(fixtureRoot, true)
      expect(result.status).toBe(0)
      expect(diagnostics(result.stdout)[0]).toMatchObject({
        severity: 'info',
        event: 'container_layout_verified',
        evidence: [],
        scanned_files: 3,
      })

      const retiredPath = path.join(fixtureRoot, 'dist/server/index.js')
      mkdirSync(path.dirname(retiredPath), { recursive: true })
      writeFileSync(retiredPath, 'legacy backend')

      const rejected = runContainerLayoutFixture(fixtureRoot, true)
      expect(rejected.status).toBe(1)
      const entries = diagnostics(rejected.stdout)
      const forbidden = entries.find((entry) => entry.event === 'container_layout_forbidden_artifacts')
      expect(forbidden?.evidence).toEqual(expect.arrayContaining(['dist/server/index.js']))
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('emits parseable JSON diagnostics when the fixture path contains a quote', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-layout-json-'))
    const quotedFixturePath = `${fixtureRoot}"quoted`

    try {
      const result = runContainerLayoutFixture(quotedFixturePath)

      expect(result.status).toBe(1)
      expect(diagnostics(result.stdout)[0]).toMatchObject({
        severity: 'error',
        event: 'container_layout_fixture_missing',
        path: quotedFixturePath,
      })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('emits empty evidence arrays for missing fixtures and required artifacts', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-missing-'))
    const missingFixture = path.join(fixtureRoot, 'missing-fixture')

    try {
      const missing = runContainerLayoutFixture(missingFixture)
      expect(missing.status).toBe(1)
      expect(diagnostics(missing.stdout)[0]).toMatchObject({
        severity: 'error',
        event: 'container_layout_fixture_missing',
        evidence: [],
      })

      const required = runContainerLayoutFixture(fixtureRoot)
      expect(required.status).toBe(1)
      expect(diagnostics(required.stdout)[0]).toMatchObject({
        severity: 'error',
        event: 'container_layout_required_artifacts_missing',
        evidence: [],
        missing: [
          'dist/client/index.html',
          'dist/tools/freshell-mcp/server.js',
          'freshell-server (or target/release/freshell-server)',
        ],
      })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects node-pty from the runtime-root release surface', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'freshell-container-layout-node-pty-release-'))

    try {
      mkdirSync(path.join(fixtureRoot, 'dist/client'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'target/release'), { recursive: true })
      mkdirSync(path.join(fixtureRoot, 'node_modules/node-pty'), { recursive: true })
      writeFileSync(path.join(fixtureRoot, 'dist/client/index.html'), '<!doctype html>')
      writeFileSync(path.join(fixtureRoot, 'dist/tools/freshell-mcp/server.js'), 'export {}')
      writeFileSync(path.join(fixtureRoot, 'target/release/freshell-server'), 'rust server')
      writeFileSync(path.join(fixtureRoot, 'node_modules/node-pty/index.js'), 'retired native module')
      chmodSync(path.join(fixtureRoot, 'target/release/freshell-server'), 0o755)

      const result = runContainerLayoutFixture(fixtureRoot, true)

      expect(result.status).toBe(1)
      const forbidden = diagnostics(result.stdout).find(
        (entry) => entry.event === 'container_layout_forbidden_artifacts',
      )
      expect(forbidden).toMatchObject({ count: 1, evidence_truncated: false })
      expect(typeof forbidden?.count).toBe('number')
      expect(typeof forbidden?.evidence_truncated).toBe('boolean')
      expect(forbidden?.evidence).toEqual(['node_modules/node-pty/index.js'])
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

})
