import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_ONLY_SPECS } from '../playwright.config.js'
import { CLOUD_SKIP_SPECS, CLOUD_SKIP_TITLES } from '../playwright.cloud.config.js'
import { createE2eServerHandle } from './external-target.js'
import { assertRustServerInfo, RustServer } from './rust-server.js'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '../../..')
const browserRoot = path.resolve(import.meta.dirname, '..')
const playwrightCli = require.resolve('@playwright/test/cli')
const configLoader = require.resolve('playwright/lib/common/configLoader')
const playwrightConfig = path.join(browserRoot, 'playwright.config.ts')
const cloudConfig = path.join(browserRoot, 'playwright.cloud.config.ts')

interface ResolvedProject {
  name: string
  testIgnore: Array<{ kind: 'regexp' | 'string'; source: string; flags?: string }>
  testMatch: Array<{ kind: 'regexp' | 'string'; source: string; flags?: string }>
}

function cleanEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CI
  delete env.FRESHELL_SMOKE
  for (const key of ['FRESHELL_E2E_EXTERNAL_FIXTURE_KIND', 'FRESHELL_MANAGED_ENVIRONMENT_FIXTURE',
    'FRESHELL_CODE_CHECKPOINT_FIXTURE', 'FRESHELL_E2E_TARGET_URL', 'FRESHELL_E2E_TARGET_WS_URL',
    'FRESHELL_E2E_TARGET_TOKEN', 'FRESHELL_E2E_TARGET_TIMEOUT_MS']) delete env[key]
  return { ...env, ...overrides }
}

function resolvedConfig(configPath: string, env: NodeJS.ProcessEnv): ResolvedProject[] {
  const script = String.raw`
const { loadConfigFromFile } = require(process.argv[1])
const normalize = (value) => (Array.isArray(value) ? value : [value]).map((pattern) =>
  pattern instanceof RegExp
    ? { kind: 'regexp', source: pattern.source, flags: pattern.flags }
    : { kind: 'string', source: String(pattern) },
)
loadConfigFromFile(process.argv[2]).then((config) => {
  process.stdout.write(JSON.stringify(config.projects.map(({ project }) => ({
    name: project.name,
    testIgnore: normalize(project.testIgnore),
    testMatch: normalize(project.testMatch),
  }))))
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`
  const output = execFileSync(process.execPath, ['-e', script, configLoader, configPath], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  })
  return JSON.parse(output) as ResolvedProject[]
}

function listedProjects(
  env: NodeJS.ProcessEnv,
  configPath = playwrightConfig,
  selectors: string[] = [],
): { output: string; labels: string[]; tests: number; files: number } {
  const output = execFileSync(process.execPath, [
    playwrightCli,
    'test',
    '--config', configPath,
    '--list',
    ...selectors,
  ], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  })
  const total = output.match(/Total: (\d+) tests? in (\d+) files?/)
  if (!total) throw new Error(`Playwright list output did not include a total:\n${output}`)
  return {
    output,
    labels: [...new Set([...output.matchAll(/^\s*\[([^\]]+)] ›/gm)].map((match) => match[1]))],
    tests: Number(total[1]),
    files: Number(total[2]),
  }
}

// Playwright --list roster lines have the exact shape
// "  [project] › <specFile>:<line>:<col> › <title>". Extracting the spec
// token makes presence an exact-filename membership check — substring
// containment passes vacuously for colliding names
// (opencode-restart-recovery.spec.ts is contained inside
// freshopencode-restart-recovery.spec.ts, so a deleted shorter spec would
// still satisfy a raw toContain; delta-review round-1 F3).
function listedSpecFiles(output: string): Set<string> {
  return new Set([...output.matchAll(/› (\S+\.spec\.ts):\d+:\d+/g)].map((match) => match[1]))
}

describe('browser selection non-vacuity', () => {
  it('discovers the managed external cases only through their paired dedicated Cloud project', () => {
    const spec = 'managed-provider-environment-external.spec.ts'
    const ordinary = listedProjects(cleanEnvironment(), cloudConfig)
    expect(listedSpecFiles(ordinary.output).has(spec)).toBe(false)
    expect(listedSpecFiles(ordinary.output).has('code-checkpoint-workspace-external.spec.ts')).toBe(false)
    const fixture = JSON.stringify({ candidateSha: 'a'.repeat(40), runId: '11111111-1111-4111-8111-111111111111',
      remoteWorkspacePath: '/tmp/selected-managed-fixture/workspace', expectedNonce: 'selection-fixture-nonce' })
    const paired = cleanEnvironment({ FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'managed-environment',
      FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: fixture, FRESHELL_E2E_TARGET_URL: 'https://fixture.invalid',
      FRESHELL_E2E_TARGET_TOKEN: 'synthetic-selection-token' })
    const selected = listedProjects(paired, cloudConfig, ['--project=chromium-external-target', spec])
    expect(selected.labels).toEqual(['chromium-external-target'])
    expect(selected.tests).toBe(3)
    expect(selected.files).toBe(1)
    expect([...listedSpecFiles(selected.output)]).toEqual([spec])
    // The source exists now: ordinary projects still cannot execute it.
    const ordinaryExplicit = spawnSync(process.execPath, [playwrightCli, 'test', '--config', cloudConfig,
      '--list', '--project=chromium', spec], { cwd: projectRoot, env: paired, encoding: 'utf8' })
    expect(ordinaryExplicit.status).toBe(1)
  }, 90_000)

  it.each(['missing', 'mismatched'] as const)('refuses external discovery with a %s fixture pair', pairing => {
    const env = cleanEnvironment({ FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'managed-environment',
      FRESHELL_E2E_TARGET_URL: 'https://fixture.invalid', FRESHELL_E2E_TARGET_TOKEN: 'synthetic-selection-token',
      ...(pairing === 'mismatched' ? { FRESHELL_CODE_CHECKPOINT_FIXTURE: '{}' } : {}) })
    const listed = spawnSync(process.execPath, [playwrightCli, 'test', '--config', cloudConfig, '--list',
      '--project=chromium-external-target', 'managed-provider-environment-external.spec.ts'],
      { cwd: projectRoot, env, encoding: 'utf8' })
    expect(listed.status).toBe(1)
    expect(`${listed.stdout}\n${listed.stderr}`).toContain('matching fixture pair')
  })

  it('selects a non-vacuous Chromium lane and all CI application projects', () => {
    const chromium = listedProjects(cleanEnvironment())
    expect(chromium.labels).toEqual(['chromium'])
    expect(chromium.output).toContain('[chromium]')
    expect(chromium.tests).toBeGreaterThanOrEqual(308)
    expect(chromium.files).toBeGreaterThanOrEqual(86)
    // Local coverage pin (kata 67jt): every CLOUD_SKIP_SPECS entry must
    // remain listed on the base/local lane — cloud-skip never means "not
    // covered"; it means "covered locally". A renamed or deleted spec that
    // forgets the list fails here. Presence is exact-filename roster
    // membership (listedSpecFiles), never substring containment: the
    // opencode-/freshopencode-restart-recovery pair collides as substrings.
    const baseSpecTokens = listedSpecFiles(chromium.output)
    for (const spec of CLOUD_SKIP_SPECS) {
      expect(baseSpecTokens, `base lane must still list ${spec}`).toContain(spec)
    }
    // Self-proving matcher (cheap synthetic negative): a roster holding only
    // the longer colliding name must not count as the shorter one, and the
    // real base lane lists both as distinct roster items.
    expect(baseSpecTokens.has('freshopencode-restart-recovery.spec.ts')).toBe(true)
    expect(baseSpecTokens.has('opencode-restart-recovery.spec.ts')).toBe(true)
    const collisionOnlyRoster = listedSpecFiles(
      '  [chromium] › freshopencode-restart-recovery.spec.ts:360:3 › Freshopencode restart recovery › resumes a session',
    )
    expect(collisionOnlyRoster.has('freshopencode-restart-recovery.spec.ts')).toBe(true)
    expect(collisionOnlyRoster.has('opencode-restart-recovery.spec.ts')).toBe(false)
    // CLOUD_SKIP_TITLES non-vacuity: each grepInvert title must actually
    // select a test in the base lane — else the cloud exclusion would be
    // vacuously green after an edit (today's known hit: editor-pane.spec.ts
    // "loads the editor lazily and requests a new JS asset after the click").
    expect(CLOUD_SKIP_TITLES.length).toBeGreaterThan(0)
    for (const title of CLOUD_SKIP_TITLES) {
      expect(chromium.output, `grepInvert source must exist in the base lane: ${title.source}`).toMatch(title)
    }

    const ci = listedProjects(cleanEnvironment({ CI: '1' }))
    expect(ci.labels).toEqual(['chromium', 'firefox', 'webkit'])
    const retiredProjectNames = [`legacy${'-chromium'}`, `rust${'-chromium'}`]
    expect(ci.output).not.toMatch(new RegExp(`${retiredProjectNames.join('|')}|Total:\\s*0 tests in`, 'i'))
  })

  it('creates Rust fixtures and selects the supported cloud projects', async () => {
    const server = await createE2eServerHandle({})
    expect(server).toBeInstanceOf(RustServer)
    expect(typeof server.start).toBe('function')
    expect(typeof server.stop).toBe('function')
    expect(() => server.info).toThrow('RustServer not started')

    expect(LOCAL_ONLY_SPECS).toContainEqual({
      spec: 'mcp-qa-smoke-rust.spec.ts',
      classification: 'local-only-provider-binary',
      selector: '--project=chromium test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts',
    })
    expect(CLOUD_SKIP_SPECS).toContain('mcp-qa-smoke-rust.spec.ts')
    expect(CLOUD_SKIP_SPECS).not.toContain('server-build-mismatch-rust.spec.ts')
    expect(CLOUD_SKIP_SPECS).not.toContain('tabs-client-retire.spec.ts')

    const cloudProjects = resolvedConfig(cloudConfig, cleanEnvironment())
    expect(cloudProjects.map((project) => project.name)).toEqual(['chromium'])
    expect(new Set(CLOUD_SKIP_SPECS).size).toBe(CLOUD_SKIP_SPECS.length)
    for (const localOnly of LOCAL_ONLY_SPECS) expect(CLOUD_SKIP_SPECS).toContain(localOnly.spec)

    const cloud = listedProjects(cleanEnvironment(), cloudConfig)
    expect(cloud.labels).toEqual(['chromium'])
    expect(cloud.output).toContain('[chromium]')
    expect(cloud.tests).toBeGreaterThan(0)
    expect(cloud.files).toBeGreaterThan(0)
    // Cloud exclusion pin (kata 67jt): no skip-listed spec may appear in
    // the cloud selection at all — a pattern typo, a minimatch-semantics
    // change, or a config refactor that drops the testIgnore mapping all
    // fail here.
    for (const spec of CLOUD_SKIP_SPECS) {
      expect(cloud.output, `cloud lane must not list ${spec}`).not.toContain(spec)
    }
    // grepInvert honored at selection level: excluded titles absent from
    // the cloud list while their spec files still run there.
    for (const title of CLOUD_SKIP_TITLES) {
      expect(cloud.output, `cloud lane must not list excluded title: ${title.source}`).not.toMatch(title)
    }

    // Explicit positional file args are an INTERSECTION with testIgnore,
    // never a bypass (Playwright 1.58.2 cliFileMatcher semantics): a mixed
    // focused invocation must keep its cloud-legal member and silently drop
    // the skip-listed one — so even a contaminated manifest or filter could
    // not execute skip-listed specs under the cloud config.
    const mixed = listedProjects(cleanEnvironment(), cloudConfig, [
      'test/e2e-browser/specs/truly-idle-alerting.spec.ts',
      'test/e2e-browser/specs/host-stats-pane.spec.ts',
    ])
    expect(mixed.output).toContain('host-stats-pane.spec.ts')
    expect(mixed.output).not.toContain('truly-idle-alerting')
    expect(mixed.files).toBe(1)

    // An ALL-skip focused invocation fails LOUDLY (exit 1, "No tests
    // found") instead of silently reading as a green zero-test run — a
    // vacuous focused cloud proof can never masquerade as coverage.
    const allSkip = spawnSync(process.execPath, [
      playwrightCli,
      'test',
      '--config', cloudConfig,
      '--list',
      'test/e2e-browser/specs/truly-idle-alerting.spec.ts',
    ], { cwd: projectRoot, env: cleanEnvironment(), encoding: 'utf8' })
    expect(allSkip.status).toBe(1)
    expect(`${allSkip.stdout}\n${allSkip.stderr}`).toContain('No tests found')

    const migrated = listedProjects(cleanEnvironment(), cloudConfig, [
      'test/e2e-browser/specs/server-build-mismatch-rust.spec.ts',
      'test/e2e-browser/specs/tabs-client-retire.spec.ts',
    ])
    expect(migrated.tests).toBe(4)
    expect(migrated.files).toBe(2)
    expect(migrated.output).toContain('mismatched ready buildId reloads exactly once and converges')
    expect(migrated.output).toContain('sentinel persists across a real navigation')
    expect(migrated.output).toContain('a seeded sentinel suppresses a repeat mismatch (no reload)')
    expect(migrated.output).toContain('closed browser client is removed from the Tabs UI through the unload retire API')
  })

  it('rejects a healthy response that does not identify Rust provenance', () => {
    expect(() => assertRustServerInfo({ runtime: 'node', commit: 'abcdef0' })).toThrow(/runtime must be "rust"/)
    expect(() => assertRustServerInfo({ runtime: 'rust' })).toThrow(/provenance/)
  })
})
