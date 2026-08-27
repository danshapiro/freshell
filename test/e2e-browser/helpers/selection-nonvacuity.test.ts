import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_ONLY_SPECS } from '../playwright.config.js'
import { CLOUD_SKIP_SPECS } from '../playwright.cloud.config.js'
import { createE2eServerHandle } from './external-target.js'
import { assertRustServerInfo, RustServer } from './rust-server.js'

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

function listedProjects(env: NodeJS.ProcessEnv): { output: string; labels: string[]; tests: number; files: number } {
  const output = execFileSync(process.execPath, [
    playwrightCli,
    'test',
    '--config', playwrightConfig,
    '--list',
  ], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  })
  const total = output.match(/Total: (\d+) tests in (\d+) files/)
  if (!total) throw new Error(`Playwright list output did not include a total:\n${output}`)
  return {
    output,
    labels: [...new Set([...output.matchAll(/^\s*\[([^\]]+)] ›/gm)].map((match) => match[1]))],
    tests: Number(total[1]),
    files: Number(total[2]),
  }
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    return entry.name.endsWith('.ts') ? [entryPath] : []
  })
}

describe('browser selection non-vacuity', () => {
  it('resolves only Rust application projects with the exact continuity exclusion', () => {
    const defaultProjects = resolvedConfig(playwrightConfig, cleanEnvironment())
    expect(defaultProjects.map((project) => project.name)).toEqual(['chromium'])
    expect(defaultProjects[0].testIgnore).toEqual([continuityPattern])

    const ciProjects = resolvedConfig(playwrightConfig, cleanEnvironment({ CI: '1' }))
    expect(ciProjects.map((project) => project.name)).toEqual(['chromium', 'firefox', 'webkit'])
    for (const project of ciProjects) expect(project.testIgnore).toEqual([continuityPattern])

    const continuityProjects = resolvedConfig(playwrightConfig, cleanEnvironment({ FRESHELL_SMOKE: '1' }))
    expect(continuityProjects.map((project) => project.name)).toEqual(['chromium', 'continuity-smoke'])
    expect(continuityProjects[0].testIgnore).toEqual([continuityPattern])
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

    const ci = listedProjects(cleanEnvironment({ CI: '1' }))
    expect(ci.labels).toEqual(['chromium', 'firefox', 'webkit'])
    const retiredProjectNames = [`legacy${'-chromium'}`, `rust${'-chromium'}`]
    expect(ci.output).not.toMatch(new RegExp(`${retiredProjectNames.join('|')}|Total:\\s*0 tests in`, 'i'))
  })

  it('keeps the Rust factory, browser imports, and cloud local-only contract free of legacy paths', async () => {
    const server = await createE2eServerHandle({})
    expect(server).toBeInstanceOf(RustServer)

    const legacyImports = sourceFiles(browserRoot).flatMap((file) => {
      const imports = [...fs.readFileSync(file, 'utf8').matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
      return imports
        .filter((match) => /(?:^|\/)(?:test-server|legacy-node-server)(?:\.js)?$/.test(match[1]))
        .map((match) => `${path.relative(projectRoot, file)} -> ${match[1]}`)
    })
    expect(legacyImports).toEqual([])

    expect(LOCAL_ONLY_SPECS).toContainEqual({
      spec: 'mcp-qa-smoke-rust.spec.ts',
      classification: 'local-only-provider-binary',
      selector: '--project=chromium test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts',
    })
    expect(CLOUD_SKIP_SPECS).toContain('mcp-qa-smoke-rust.spec.ts')

    const cloudProjects = resolvedConfig(cloudConfig, cleanEnvironment())
    expect(cloudProjects.map((project) => project.name)).toEqual(['chromium'])
    expect(cloudProjects[0].testIgnore).toEqual([
      continuityPattern,
      ...CLOUD_SKIP_SPECS.map((spec) => ({ kind: 'string' as const, source: `**/${spec}` })),
    ])
    expect(new Set(CLOUD_SKIP_SPECS).size).toBe(CLOUD_SKIP_SPECS.length)
    for (const localOnly of LOCAL_ONLY_SPECS) expect(CLOUD_SKIP_SPECS).toContain(localOnly.spec)
  })

  it('rejects a healthy response that does not identify Rust provenance', () => {
    expect(() => assertRustServerInfo({ runtime: 'node', commit: 'abcdef0' })).toThrow(/runtime must be "rust"/)
    expect(() => assertRustServerInfo({ runtime: 'rust' })).toThrow(/provenance/)
  })
})
