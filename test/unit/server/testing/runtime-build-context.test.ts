import fs from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../../..')

describe.each(['.dockerignore', '.gcloudignore'])('%s keeps private runtime material out of uploaded build contexts', (filename) => {
  const policy = () => ignore().add(fs.readFileSync(path.join(root, filename), 'utf8'))

  it.each([
    '.runtime-evidence/commit/run/provider-native-state.json',
    '.runtime-evidence/commit/run/browser/trace.zip',
    '.runtime-build/run/private-provider-home/state.json',
    '.runtime-build/run/freshell-server-managed',
    '.env',
    '.env.production',
    '.env.local',
    'docs/development/private-notes.md',
    'docs/development/unrelated-data.json',
  ])('excludes %s', (artifact) => {
    expect(policy().ignores(artifact)).toBe(true)
  })

  it.each([
    'AGENTS.md', 'package.json', 'package-lock.json',
    'scripts/testing/runtime-gate.ts',
    'crates/freshell-session-host/src/main.rs',
    'docs/development/runtime-provider-capabilities.json',
    'test/unit/server/testing/runtime-build-context.test.ts',
  ])('retains required source %s', (source) => {
    expect(policy().ignores(source)).toBe(false)
  })
})


it('copies the embedded provider declaration into the Rust cloud build stage', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'docker/cloud-run/Dockerfile'), 'utf8')
  const compile = dockerfile.indexOf('RUN cargo build --release -p freshell-server')
  const manifest = dockerfile.indexOf('COPY docs/development/runtime-provider-capabilities.json')
  expect(manifest).toBeGreaterThanOrEqual(0)
  expect(manifest).toBeLessThan(compile)
})
