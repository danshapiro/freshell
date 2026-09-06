// Pins the playwright.config.ts rust-only registration invariant: every
// rust-only spec runs EXACTLY ONCE, under the `rust-chromium` project.
// Default `chromium` is a match-all project (testIgnore: RUST_ONLY_SPECS);
// a spec in rust-chromium `testMatch` but missing from RUST_ONLY_SPECS is
// also collected by `chromium` and runs against the legacy Node server
// (darkforge job 0q8k / GATE-01 evidence). A spec on disk but unregistered
// collects ZERO tests under rust-chromium -- a silent false green.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import baseConfig, {
  MATRIX_SPECS,
  RUST_ONLY_SPECS,
} from '../../test/e2e-browser/playwright.config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const specsDir = path.resolve(__dirname, '../../test/e2e-browser/specs')

type Pattern = string | RegExp
function toRegexes(patterns: Pattern | Pattern[] | undefined): RegExp[] {
  const list = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  return list.map((p) => (p instanceof RegExp ? p : new RegExp(p)))
}

// rust-chromium `testMatch` entries that are ALSO allowed under the match-all
// `chromium` project (intentional Node/Rust double coverage), each with the
// reason this is NOT a RUST_ONLY_SPECS hole. Keyed by exact regex source.
const INTENTIONAL_CHROMIUM_DOUBLE_COVERAGE: Record<string, string> = {
  [/sidebar-opencode-rail\.spec\.ts$/.source]:
    'Node parity is part of the fix (spec doc comment + testMatch comment).',
  [/harness-01-rust-server\.spec\.ts$/.source]:
    'Server-kind-agnostic owned-fixture self-test; config comment says it only needs to run once, under rust-chromium, but it also passes under chromium (harmless duplicate).',
}

const chromium = baseConfig.projects?.find((p) => p.name === 'chromium')
const rust = baseConfig.projects?.find((p) => p.name === 'rust-chromium')

describe('playwright e2e rust-only spec registration', () => {
  it('chromium testIgnore is exactly the shared RUST_ONLY_SPECS array', () => {
    expect(chromium?.testIgnore).toBe(RUST_ONLY_SPECS)
  })

  it('every on-disk *-rust.spec.ts is registered in BOTH rust-chromium testMatch and RUST_ONLY_SPECS', () => {
    const onDisk = fs
      .readdirSync(specsDir)
      .filter((f) => f.endsWith('-rust.spec.ts'))
    const rustMatch = toRegexes(rust?.testMatch as Pattern | Pattern[] | undefined)
    const unregistered = onDisk.filter(
      (f) =>
        !rustMatch.some((re) => re.test(f)) ||
        !RUST_ONLY_SPECS.some((re) => re.test(f)),
    )
    expect(unregistered).toEqual([])
  })

  it('every rust-chromium testMatch entry is in RUST_ONLY_SPECS or allowlisted for intentional chromium double coverage', () => {
    const rustMatch = toRegexes(rust?.testMatch as Pattern | Pattern[] | undefined)
    const ignoreSources = new Set(RUST_ONLY_SPECS.map((re) => re.source))
    // MATRIX_SPECS are multi-server BY DESIGN (HARNESS-02): they run under
    // legacy-chromium, rust-chromium, AND the match-all chromium project.
    const matrixSources = new Set(MATRIX_SPECS.map((re) => re.source))
    const violators = rustMatch
      .map((re) => re.source)
      .filter((source) => !matrixSources.has(source))
      .filter(
        (source) =>
          !ignoreSources.has(source) &&
          !(source in INTENTIONAL_CHROMIUM_DOUBLE_COVERAGE),
      )
    expect(violators).toEqual([])
  })
})
