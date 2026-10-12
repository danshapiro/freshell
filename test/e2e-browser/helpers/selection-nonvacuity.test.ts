import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_ONLY_SPECS } from '../playwright.config.js'
import { CLOUD_SKIP_SPECS, CLOUD_SKIP_TITLES } from '../playwright.cloud.config.js'
import { createE2eServerHandle } from './external-target.js'
import { assertRustServerInfo, RustServer } from './rust-server.js'
import { EXTERNAL_DESCRIPTOR_KEYS, EXTERNAL_SELECTION_KEYS } from '../../../scripts/testing/runtime-external-browser.js'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '../../..')
const browserRoot = path.resolve(import.meta.dirname, '..')
const playwrightCli = require.resolve('@playwright/test/cli')
const configLoader = require.resolve('playwright/lib/common/configLoader')
const playwrightConfig = path.join(browserRoot, 'playwright.config.ts')
const cloudConfig = path.join(browserRoot, 'playwright.cloud.config.ts')
const continuityPattern = { kind: 'regexp', source: 'continuity-smoke\\.spec\\.ts$', flags: '' }

interface ResolvedProject {
  name: string
  testIgnore: Array<{ kind: 'regexp' | 'string'; source: string; flags?: string }>
  testMatch: Array<{ kind: 'regexp' | 'string'; source: string; flags?: string }>
}

function cleanEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CI
  delete env.FRESHELL_SMOKE
  for (const key of [...EXTERNAL_DESCRIPTOR_KEYS, ...EXTERNAL_SELECTION_KEYS,
    'FRESHELL_RUNTIME_EXTERNAL_SPEC', 'FRESHELL_RUNTIME_EXTERNAL_GREP']) delete env[key]
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
  const fixtureSpec = 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts'
  const external = {
    FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
    FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws',
    FRESHELL_E2E_TARGET_TOKEN: 'private-listing-token',
    FRESHELL_RUNTIME_EXTERNAL_RUN_ID: 'b8c53aab-d4f8-4153-bb7d-0873a7dcce90',
    FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: 'a'.repeat(40),
    FRESHELL_RUNTIME_EXTERNAL_SPEC: fixtureSpec,
  }

  function expectExternalFixtureCase(title: string) {
    const grep = `${title}$`
    const listed = listedProjects(cleanEnvironment({ ...external,
      FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST: '1', FRESHELL_RUNTIME_EXTERNAL_GREP: grep,
    }), cloudConfig, ['--project=chromium-external-target', fixtureSpec, '--grep', grep])
    expect(listed.labels).toEqual(['chromium-external-target'])
    expect(listed.tests).toBe(1)
    expect(listed.files).toBe(1)
    expect(listedSpecFiles(listed.output)).toEqual(new Set([path.basename(fixtureSpec)]))
    expect(listed.output).toContain(title)
  }

  it('positively lists the requested owned external managed case on the Cloud project', () => {
    expectExternalFixtureCase('all modes share activation and exact-native recovery without provider access')
  })

  it('positively lists the owned external managed History case independently', () => {
    expectExternalFixtureCase('completed owned native fixture history opens its existing browser pane')
  })

  it('fails before selection when an external managed descriptor lacks the exact fixture opt-in', () => {
    const listed = spawnSync(process.execPath, [playwrightCli, 'test', '--config', cloudConfig,
      '--project=chromium-external-target', '--list', fixtureSpec], {
      cwd: projectRoot, env: cleanEnvironment(external), encoding: 'utf8',
    })
    expect(listed.status).not.toBe(0)
    expect(`${listed.stdout}${listed.stderr}`).toContain('FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST')
  })

  it('does not count an external grep matching no requested cases', () => {
    const listed = spawnSync(process.execPath, [playwrightCli, 'test', '--config', cloudConfig,
      '--project=chromium-external-target', '--list', fixtureSpec, '--grep', 'absent managed scenario'], {
      cwd: projectRoot, env: cleanEnvironment({ ...external, FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST: '1' }), encoding: 'utf8',
    })
    expect(listed.status).not.toBe(0)
    expect(`${listed.stdout}${listed.stderr}`).toMatch(/No tests found/)
  })
  it('selects the actual topology smoke only with its owned external project', () => {
    const spec = 'test/e2e-browser/specs/runtime-external-target-smoke-rust.spec.ts'
    const absent = spawnSync(process.execPath, [playwrightCli, 'test', '--config', cloudConfig, '--list', spec], {
      cwd: projectRoot, env: cleanEnvironment(), encoding: 'utf8',
    })
    expect(absent.status).not.toBe(0)
    expect(`${absent.stdout}${absent.stderr}`).toMatch(/No tests found/)
    const selected = listedProjects(cleanEnvironment({ ...external, FRESHELL_RUNTIME_EXTERNAL_SPEC: spec }), cloudConfig,
      ['--project=chromium-external-target', spec, '--grep', 'actual managed external topology and finite owner facts'])
    expect(selected.tests).toBe(1)
    expect(selected.files).toBe(1)
    expect(selected.output).toContain('actual managed external topology and finite owner facts')
  })

  it('resolves only Rust application projects with the exact continuity exclusion', () => {
    const defaultProjects = resolvedConfig(playwrightConfig, cleanEnvironment())
    expect(defaultProjects.map((project) => project.name)).toEqual(['chromium'])

    const ciProjects = resolvedConfig(playwrightConfig, cleanEnvironment({ CI: '1' }))
    expect(ciProjects.map((project) => project.name)).toEqual(['chromium', 'firefox', 'webkit'])

    const continuityProjects = resolvedConfig(playwrightConfig, cleanEnvironment({ FRESHELL_SMOKE: '1' }))
    expect(continuityProjects.map((project) => project.name)).toEqual(['chromium', 'continuity-smoke'])
    expect(continuityProjects[1]).toMatchObject({
      name: 'continuity-smoke',
      testIgnore: [],
      testMatch: [continuityPattern],
    })
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

  // These contracts collect independently: five real Playwright children in
  // one case otherwise share a 30s deadline, even when each finishes promptly.
  it('creates an owned Rust fixture without starting its server', async () => {
    const server = await createE2eServerHandle({})
    expect(server).toBeInstanceOf(RustServer)
    expect(typeof server.start).toBe('function')
    expect(typeof server.stop).toBe('function')
    expect(() => server.info).toThrow('RustServer not started')
  })

  it('resolves the supported cloud projects and local-only exclusions', () => {
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
  })

  it('selects a non-vacuous cloud roster honoring all file and title exclusions', () => {
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
  })

  it('intersects mixed cloud selectors with the supported cloud projects', () => {
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
    expect(mixed.tests).toBeGreaterThan(0)
  })

  it('rejects an all-skip selection on the supported cloud projects', () => {
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
  })

  it('selects all migrated cases on the supported cloud projects', () => {
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
