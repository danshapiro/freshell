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
  it.each(BUILD_SCRIPTS)('restamps $crate when the managed source-state trigger changes after a linked-worktree cache copy', (sourceCrate) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-stamp-worktrees-'))
    roots.push(root)
    const repository = path.join(root, 'repository')
    const original = path.join(root, 'original')
    const moved = path.join(root, 'moved')
    const crate = path.join('crates', 'stamp')
    fs.mkdirSync(path.join(repository, crate, 'src'), { recursive: true })
    fs.copyFileSync(path.join(repositoryRoot, 'crates', sourceCrate.crate, 'build.rs'), path.join(repository, crate, 'build.rs'))
    fs.writeFileSync(path.join(repository, crate, 'Cargo.toml'), '[package]\nname="worktree-stamp-check"\nversion="0.0.0"\nedition="2021"\n[workspace]\n')
    fs.writeFileSync(path.join(repository, crate, 'src/main.rs'), `fn main() { println!("{}", env!("${sourceCrate.variable}")); }\n`)
    fs.writeFileSync(path.join(repository, '.gitignore'), 'target/\nCargo.lock\n')
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    delete env.FRESHELL_BUILD_COMMIT
    delete env.FRESHELL_BUILD_SOURCE_STATE
    delete env.CARGO_TARGET_DIR
    const git = (cwd: string, ...args: string[]) => execFileSync('git', [
      '-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', ...args,
    ], { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
    git(repository, 'init', '--quiet')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'Owned worktree-stamp fixture')
    git(repository, 'worktree', 'add', '--quiet', '-b', 'original', original)
    git(repository, 'worktree', 'add', '--quiet', '-b', 'moved', moved)
    const initialCommit = git(original, 'rev-parse', 'HEAD')
    const build = (worktree: string, sourceState: string) => {
      const project = path.join(worktree, crate)
      const output = execFileSync('cargo', ['build', '--quiet', '--offline', '--message-format=json'], {
        cwd: project, env: { ...env, FRESHELL_BUILD_SOURCE_STATE: sourceState }, encoding: 'utf8', stdio: 'pipe',
      })
      const artifact = output.trim().split('\n').map(line => JSON.parse(line))
        .find(message => message.reason === 'compiler-artifact' && message.target.name === 'worktree-stamp-check')
      expect(artifact).toBeDefined()
      const stamp = execFileSync(artifact.executable, [], { cwd: project, encoding: 'utf8' }).trim()
      return { stamp, fresh: artifact.fresh as boolean }
    }
    git(moved, 'commit', '--quiet', '--allow-empty', '-m', 'Advance destination before copying cache')
    const movedCommit = git(moved, 'rev-parse', 'HEAD')
    expect(build(original, `${initialCommit}:clean`).stamp).toBe(initialCommit)
    // The destination's Git metadata predates the copied cache, as it can in
    // normal cache seeding. Watching only its gitfile mtime would miss this.
    fs.cpSync(path.join(original, crate, 'target'), path.join(moved, crate, 'target'), { recursive: true, preserveTimestamps: true })
    expect(build(moved, `${movedCommit}:clean`).stamp).toBe(movedCommit)
    git(moved, 'commit', '--quiet', '--allow-empty', '-m', 'Advance destination again')
    // Keep the caller trigger unchanged to prove the refreshed Git watches
    // now follow an ordinary same-branch commit in the destination worktree.
    const currentCommit = git(moved, 'rev-parse', 'HEAD')
    expect(build(moved, `${movedCommit}:clean`).stamp).toBe(currentCommit)
    // The invalidation signal must not force a compile on unchanged builds.
    // It also must not replace the independently discovered commit above.
    expect(build(moved, `${movedCommit}:clean`)).toEqual({ stamp: currentCommit, fresh: true })
  })

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
