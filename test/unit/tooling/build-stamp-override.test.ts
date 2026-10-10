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
  execFileSync('cargo', ['build', '--quiet'], { cwd: project, env, stdio: 'pipe' })
  return execFileSync(path.join(project, 'target/debug/stamp-override-check'), [], {
    cwd: project,
    encoding: 'utf8',
  }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Rust artifact build provenance', () => {
  it('restamps cached server artifacts after an untracked dirty source becomes clean', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-state-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'src'))
    fs.copyFileSync(path.join(repositoryRoot, 'crates/freshell-server/build.rs'), path.join(root, 'build.rs'))
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="source-state-check"\nversion="0.0.0"\nedition="2021"\n[workspace]\n')
    fs.writeFileSync(path.join(root, 'src/main.rs'), 'fn main() { println!("{}:{}", env!("FRESHELL_BUILD_COMMIT"), env!("FRESHELL_BUILD_DIRTY")); }\n')
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Dan Shapiro',
      '-c', 'user.email=3732858+danshapiro@users.noreply.github.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
    git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'Owned source-state fixture')
    // Ignore outputs before the first build, so deleting the fixture changes
    // no Git index/ref/ignore file that Cargo already watches.
    fs.writeFileSync(path.join(root, '.git/info/exclude'), 'target/\nCargo.lock\n')
    const commit = git('rev-parse', 'HEAD')
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    delete env.FRESHELL_BUILD_COMMIT
    const build = (state: string) => {
      execFileSync('cargo', ['build', '--quiet'], { cwd: root, env: { ...env, FRESHELL_BUILD_SOURCE_STATE: state }, stdio: 'pipe' })
      return execFileSync(path.join(root, 'target/debug/source-state-check'), [], { cwd: root, encoding: 'utf8' }).trim()
    }
    const dirty = path.join(root, 'owned-untracked-fixture')
    fs.writeFileSync(dirty, 'owned parity workspace')
    expect(build(`${commit}:dirty`)).toBe(`${commit}:true`)
    fs.unlinkSync(dirty)
    expect(git('status', '--porcelain')).toBe('')
    expect(build(`${commit}:clean`)).toBe(`${commit}:false`)
    fs.writeFileSync(dirty, 'another owned parity workspace')
    // An inaccurate trigger must never override independently measured truth.
    expect(build('incorrect-clean-trigger')).toBe(`${commit}:true`)
  })

  it.each(BUILD_SCRIPTS)('bakes the validated build-time override into $crate', (sourceCrate) => {
    const commit = 'b'.repeat(40)
    expect(stampFromBuildScript(sourceCrate, commit)).toBe(commit)
  })

  it.each(BUILD_SCRIPTS)('rejects invalid build-time overrides in $crate', (sourceCrate) => {
    expect(stampFromBuildScript(sourceCrate, 'B'.repeat(40))).toBe('unknown')
  })
})
