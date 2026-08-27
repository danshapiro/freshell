import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import config, {
  CONTINUITY_SMOKE_SPEC,
  LOCAL_ONLY_SPECS,
  MATCH_ALL_TEST_IGNORE,
} from '../playwright.config.js'
import { CLOUD_SKIP_SPECS } from '../playwright.cloud.config.js'
import { assertRustServerInfo } from './rust-server.js'

const specsDir = path.resolve(import.meta.dirname, '../specs')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => path.join(dir, name))
}

describe('browser selection non-vacuity', () => {
  it('keeps every application project on the Rust fixture with only continuity excluded', () => {
    const projects = config.projects ?? []
    const chromium = projects.find((project) => project.name === 'chromium')
    expect(chromium).toBeDefined()
    expect(projects.map((project) => project.name)).not.toContain('retired Node browser lane')
    expect(projects.map((project) => project.name)).not.toContain('Rust browser lane')
    expect(MATCH_ALL_TEST_IGNORE).toEqual([CONTINUITY_SMOKE_SPEC])
    expect(chromium?.testIgnore).toEqual([CONTINUITY_SMOKE_SPEC])
    for (const project of projects.filter((project) => ['firefox', 'webkit'].includes(project.name ?? ''))) {
      expect(project.testIgnore).toEqual([CONTINUITY_SMOKE_SPEC])
    }
  })

  it('has a non-vacuous Rust Chromium selection floor', () => {
    const files = sourceFiles(specsDir)
    const registrations = files.reduce((count, file) => count + (fs.readFileSync(file, 'utf8').match(/\btest(?:\.describe)?\s*\(/g)?.length ?? 0), 0)
    expect(files.length).toBeGreaterThanOrEqual(86)
    expect(registrations).toBeGreaterThanOrEqual(308)
  })

  it('retains mcp QA as a local-only receipt and keeps cloud skips explained', () => {
    expect(LOCAL_ONLY_SPECS).toContainEqual(expect.objectContaining({
      spec: 'mcp-qa-smoke-rust.spec.ts',
      classification: 'local-only-provider-binary',
      selector: expect.stringContaining('--project=chromium'),
    }))
    for (const localOnly of LOCAL_ONLY_SPECS) expect(CLOUD_SKIP_SPECS).toContain(localOnly.spec)
  })

  it('rejects a healthy response that does not identify Rust provenance', () => {
    expect(() => assertRustServerInfo({ runtime: 'node', commit: 'abcdef0' })).toThrow(/runtime must be "rust"/)
    expect(() => assertRustServerInfo({ runtime: 'rust' })).toThrow(/provenance/)
  })
})
