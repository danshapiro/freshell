// @vitest-environment node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const BUILD_SCRIPTS = [
  { crate: 'freshell-ws', variable: 'FRESHELL_WS_BUILD_COMMIT' },
  { crate: 'freshell-server', variable: 'FRESHELL_BUILD_COMMIT' },
] as const

function stampFromBuildScript(
  sourceCrate: (typeof BUILD_SCRIPTS)[number],
  buildCommit: string | undefined,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-stamp-override-'))
  roots.push(root)
  const project = path.join(root, 'project')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.copyFileSync(path.join(repositoryRoot, 'crates', sourceCrate.crate, 'build.rs'), path.join(project, 'build.rs'))
  fs.writeFileSync(path.join(project, 'Cargo.toml'), [
    '[package]',
    'name = "stamp-override-check"',
    'version = "0.0.0"',
    'edition = "2021"',
    '',
    '[workspace]',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(project, 'src/main.rs'), `fn main() { println!(\"{}\", option_env!(\"${sourceCrate.variable}\").unwrap_or(\"unknown\")); }\n`)

  const env = { ...process.env }
  if (buildCommit === undefined) delete env.FRESHELL_BUILD_COMMIT
  else env.FRESHELL_BUILD_COMMIT = buildCommit
  execFileSync('cargo', ['build', '--quiet'], { timeout: 120_000, killSignal: 'SIGKILL', cwd: project, env, stdio: 'pipe' })
  return execFileSync(path.join(project, 'target/debug/stamp-override-check'), [], {
    timeout: 30_000,
    killSignal: 'SIGKILL',
    cwd: project,
    encoding: 'utf8',
  }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Rust artifact build provenance', () => {
  it.each(BUILD_SCRIPTS)('bakes the validated build-time override into $crate', (sourceCrate) => {
    const commit = 'b'.repeat(40)
    expect(stampFromBuildScript(sourceCrate, commit)).toBe(commit)
  })

  it.each(BUILD_SCRIPTS)('rejects invalid build-time overrides in $crate', (sourceCrate) => {
    expect(stampFromBuildScript(sourceCrate, 'B'.repeat(40))).toBe('unknown')
  })
})
