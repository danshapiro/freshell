// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
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

type ProcIssue = { operation: string; pid?: number; fd?: string; code: string }
type ProcFileDescriptor = {
  pid: number
  fd: string
  flags: string | null
  accessMode: 'read-only' | 'write-only' | 'read-write' | 'unknown'
  processExecutableBasename: string | null
}

function inspectOpenFileDescriptors(filePath: string) {
  const target = path.resolve(filePath)
  const matchingFileDescriptors: ProcFileDescriptor[] = []
  const inaccessibleByCode: Record<string, number> = {}
  const inaccessibleSamples: ProcIssue[] = []
  let inaccessibleCount = 0
  let racedEntryCount = 0
  let scannedProcessCount = 0
  if (process.platform !== 'linux') {
    return { status: 'unavailable' as const, target, rootError: 'unsupported-platform', scannedProcessCount,
      matchingFileDescriptors, inaccessibleCount, inaccessibleByCode,
      inaccessibleSamples: [{ operation: 'scan-process-file-descriptors', code: 'unsupported-platform' }],
      inaccessibleSamplesOmitted: 0, racedEntryCount }
  }

  const recordProcIssue = (operation: string, pid: number | undefined, fd: string | undefined, error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'UNKNOWN') : 'UNKNOWN'
    if (code === 'ENOENT') {
      racedEntryCount += 1
      return
    }
    inaccessibleCount += 1
    inaccessibleByCode[code] = (inaccessibleByCode[code] ?? 0) + 1
    if (inaccessibleSamples.length < 32) {
      inaccessibleSamples.push({ operation,
        ...(pid === undefined ? {} : { pid }), ...(fd === undefined ? {} : { fd }), code })
    }
  }

  let processes: fs.Dirent[]
  try {
    processes = fs.readdirSync('/proc', { withFileTypes: true })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'UNKNOWN') : 'UNKNOWN'
    return { status: 'unavailable' as const, target, rootError: code, scannedProcessCount,
      matchingFileDescriptors, inaccessibleCount: 1, inaccessibleByCode: { [code]: 1 },
      inaccessibleSamples: [{ operation: 'list-processes', code }], racedEntryCount }
  }

  for (const process of processes) {
    if (!/^\d+$/.test(process.name)) continue
    const pid = Number(process.name)
    scannedProcessCount += 1
    const fdDirectory = path.join('/proc', process.name, 'fd')
    let descriptors: fs.Dirent[]
    try {
      descriptors = fs.readdirSync(fdDirectory, { withFileTypes: true })
    } catch (error) {
      recordProcIssue('list-file-descriptors', pid, undefined, error)
      continue
    }

    for (const descriptor of descriptors) {
      const fd = descriptor.name
      const descriptorPath = path.join(fdDirectory, fd)
      let linkedPath: string
      try {
        linkedPath = fs.readlinkSync(descriptorPath).replace(/ \(deleted\)$/, '')
      } catch (error) {
        recordProcIssue('read-file-descriptor-link', pid, fd, error)
        continue
      }
      if (path.resolve(linkedPath) !== target) continue

      let flags: string | null = null
      try {
        const info = fs.readFileSync(path.join('/proc', process.name, 'fdinfo', fd), 'utf8')
        flags = /^flags:\s*([0-7]+)/m.exec(info)?.[1] ?? null
      } catch (error) {
        recordProcIssue('read-file-descriptor-flags', pid, fd, error)
      }
      let processExecutableBasename: string | null = null
      try {
        const executable = fs.readlinkSync(path.join('/proc', process.name, 'exe')).replace(/ \(deleted\)$/, '')
        processExecutableBasename = path.basename(executable)
      } catch (error) {
        recordProcIssue('read-process-executable', pid, undefined, error)
      }
      const access = flags === null ? Number.NaN : Number.parseInt(flags, 8) & 0b11
      matchingFileDescriptors.push({ pid, fd, flags,
        accessMode: access === 0 ? 'read-only' : access === 1 ? 'write-only' : access === 2 ? 'read-write' : 'unknown',
        processExecutableBasename })
    }
  }

  return { status: 'complete' as const, target, scannedProcessCount, matchingFileDescriptors,
    inaccessibleCount, inaccessibleByCode, inaccessibleSamples,
    inaccessibleSamplesOmitted: Math.max(0, inaccessibleCount - inaccessibleSamples.length),
    racedEntryCount }
}

function copiedBuildScriptTextFileBusyDiagnostic(error: unknown, project: string) {
  const failure = error as { code?: string; errno?: number; stderr?: Buffer | string }
  const stderr = Buffer.isBuffer(failure?.stderr) ? failure.stderr.toString('utf8') : String(failure?.stderr ?? '')
  if (!stderr.includes('Text file busy (os error 26)')) return undefined
  const executable = /could not execute process [`"]([^`"\r\n]+[\\/]build-script-build(?:\.exe)?)[`"]/.exec(stderr)?.[1]
  const targetDirectory = path.join(project, 'target', 'debug', 'build')
  let copiedExecutables: string[] = []
  try {
    copiedExecutables = fs.readdirSync(targetDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(targetDirectory, entry.name, 'build-script-build'))
      .filter(file => fs.existsSync(file))
  } catch {
    // The Cargo error remains primary; the JSONL diagnostic below records
    // whether /proc was also inaccessible when an exact path is available.
  }
  const procScan = executable ? inspectOpenFileDescriptors(executable)
    : { status: 'not-run' as const,
      reason: 'Cargo stderr did not identify a build-script-build path', copiedExecutables }
  return { severity: 'error' as const, event: 'build_stamp.copied_build_script_etxtbsy',
    executable: executable ?? null,
    cargoError: { code: failure?.code ?? null, errno: failure?.errno ?? null }, procScan }
}

function reportCopiedBuildScriptTextFileBusy(error: unknown, project: string): void {
  const diagnostic = copiedBuildScriptTextFileBusyDiagnostic(error, project)
  if (diagnostic) process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
}

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
  it('reports a writable /proc descriptor or an explicit unsupported-platform diagnostic', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-script-holder-'))
    roots.push(root)
    const executable = path.join(root, 'build-script-build')
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    let writableFd: number | undefined
    try {
      const windowsExecutable = String.raw`C:\tmp\freshell\target\debug\build\fixture\build-script-build.exe`
      const windowsDiagnostic = copiedBuildScriptTextFileBusyDiagnostic({
        code: 1,
        stderr: `could not execute process \`${windowsExecutable}\` (never executed)\nText file busy (os error 26)`,
      }, root)
      expect(windowsDiagnostic?.executable).toBe(windowsExecutable)

      if (process.platform !== 'linux') {
        const diagnostic = copiedBuildScriptTextFileBusyDiagnostic({
          code: 1,
          stderr: `could not execute process \`${executable}\` (never executed)\nText file busy (os error 26)`,
        }, root)
        if (!diagnostic) throw new Error('ETXTBSY diagnostic was not generated for the matching Cargo failure')
        expect(diagnostic.procScan).toMatchObject({ status: 'unavailable', rootError: 'unsupported-platform' })
        return
      }

      writableFd = fs.openSync(executable, 'r+')
      const execution = spawnSync(executable, [], { encoding: 'utf8' })
      expect(execution.error?.code).toBe('ETXTBSY')
      const diagnostic = copiedBuildScriptTextFileBusyDiagnostic({
        code: 1,
        stderr: `could not execute process \`${executable}\` (never executed)\nText file busy (os error 26)`,
      }, root)
      if (!diagnostic) throw new Error('ETXTBSY diagnostic was not generated for the matching Cargo failure')
      expect(diagnostic).toMatchObject({
        severity: 'error', event: 'build_stamp.copied_build_script_etxtbsy', executable,
      })
      if (diagnostic.procScan.status !== 'complete') throw new Error('Linux /proc scan was not completed')
      expect(diagnostic.procScan.matchingFileDescriptors).toContainEqual(expect.objectContaining({
        pid: process.pid, fd: String(writableFd), accessMode: 'read-write',
        processExecutableBasename: path.basename(fs.realpathSync(process.execPath)),
      }))
      const holderDescriptor = diagnostic.procScan.matchingFileDescriptors.find(descriptor =>
        descriptor.pid === process.pid && descriptor.fd === String(writableFd))
      if (!holderDescriptor) throw new Error('writable holder descriptor was not included in the diagnostic')
      expect(holderDescriptor.flags).toMatch(/^[0-7]+$/)
      expect(diagnostic.procScan).toHaveProperty('inaccessibleCount')
      expect(diagnostic.procScan).toHaveProperty('racedEntryCount')
    } finally {
      if (writableFd !== undefined) fs.closeSync(writableFd)
    }
  })

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
      let output: string
      try {
        output = execFileSync('cargo', ['build', '--quiet', '--offline', '--message-format=json'], {
          cwd: project, env: { ...env, FRESHELL_BUILD_SOURCE_STATE: sourceState }, encoding: 'utf8', stdio: 'pipe',
        })
      } catch (error) {
        reportCopiedBuildScriptTextFileBusy(error, project)
        throw error
      }
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
