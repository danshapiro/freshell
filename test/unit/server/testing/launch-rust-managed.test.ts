import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../../..')
const launcher = path.join(root, 'scripts/launch-rust.sh')
const foreground = path.join(root, 'scripts/run-rust-managed.sh')

describe('canonical Rust launcher managed-runtime release wiring', () => {
  it('documents preparation, preflight, status, web-only stop, and legacy rollback', () => {
    const help = execFileSync('bash', [launcher, '--help'], { cwd: root, encoding: 'utf8' })
    for (const flag of ['--prepare-only', '--preflight', '--managed-status', '--stop-supervisor', '--legacy', '--stop']) {
      expect(help).toContain(flag)
    }
    expect(help).toMatch(/agents keep running/i)
  })

  it('builds every managed artifact, an exact image, and routes through the release manager', () => {
    const source = fs.readFileSync(launcher, 'utf8')
    expect(source).toContain('cargo build --release -p freshell-server --features managed-runtime-v1')
    expect(source).toContain('cargo build --release -p freshell-supervisor -p freshell-session-host')
    expect(source).toContain('docker build --file docker/runtime/Dockerfile')
    expect(source).toContain('managed prepare')
    expect(source).toContain('managed preflight --release-id "$PREPARED_RELEASE_ID"')
    expect(source).toContain('managed activate --release-id "$PREPARED_RELEASE_ID"')
    expect(source.indexOf('managed prepare')).toBeLessThan(source.indexOf('managed preflight --release-id'))
    expect(source.indexOf('managed preflight --release-id')).toBeLessThan(source.indexOf('managed activate --release-id'))
    expect(source).toContain('managed ensure-supervisor --replace')
    expect(source).toContain('managed web-env-file')
    expect(source).toContain('managed backup-registry')
  })



  it('never labels a dirty source tree as an immutable commit release', () => {
    const source = fs.readFileSync(launcher, 'utf8')
    const dirtyCheck = source.indexOf('git status --porcelain=v1 --untracked-files=all')
    const managedBuild = source.indexOf('cargo build --release -p freshell-server --features managed-runtime-v1')
    expect(dirtyCheck).toBeGreaterThanOrEqual(0)
    expect(dirtyCheck).toBeLessThan(managedBuild)
    expect(source).toMatch(/commit or clean the worktree before preparing a managed release/i)
  })

  it('does not activate a newly built release during validation-only preflight', () => {
    const source = fs.readFileSync(launcher, 'utf8')
    expect(source).toContain('if [[ "$PREFLIGHT_ONLY" == 1 ]]')
    const validationExit = source.indexOf('Managed release passed preflight; no active release pointer was changed.')
    const activation = source.indexOf('managed activate --release-id "$PREPARED_RELEASE_ID"')
    expect(validationExit).toBeGreaterThanOrEqual(0)
    expect(validationExit).toBeLessThan(activation)
  })


  it('does not change the active release when an existing server is left running', () => {
    const source = fs.readFileSync(launcher, 'utf8')
    const unchangedExit = source.indexOf('Use --restart only with required approval for the live server.')
    const activation = source.lastIndexOf('managed activate --release-id "$PREPARED_RELEASE_ID"')
    expect(unchangedExit).toBeGreaterThanOrEqual(0)
    expect(activation).toBeGreaterThan(unchangedExit)
  })


  it('backs up the registry before activating a prepared managed release', () => {
    const source = fs.readFileSync(launcher, 'utf8')
    const normalStart = source.indexOf('if [[ "$LEGACY" != 1 ]]')
    const normalEnd = source.indexOf('else\n  unset FRESHELL_MANAGED_RUNTIME_V1', normalStart)
    const normalBlock = source.slice(normalStart, normalEnd)
    expect(normalBlock.indexOf('managed backup-registry --release-id "$PREPARED_RELEASE_ID"'))
      .toBeGreaterThanOrEqual(0)
    expect(normalBlock.indexOf('managed backup-registry --release-id "$PREPARED_RELEASE_ID"'))
      .toBeLessThan(normalBlock.indexOf('managed activate --release-id "$PREPARED_RELEASE_ID"'))

    const prepareStart = source.indexOf('if [[ "$PREPARE_ONLY" == 1 ]]')
    const prepareBlock = source.slice(prepareStart, source.indexOf('\nfi', prepareStart) + 3)
    expect(prepareBlock.indexOf('managed backup-registry --release-id "$PREPARED_RELEASE_ID"'))
      .toBeGreaterThanOrEqual(0)
    expect(prepareBlock.indexOf('managed backup-registry --release-id "$PREPARED_RELEASE_ID"'))
      .toBeLessThan(prepareBlock.indexOf('managed activate --release-id "$PREPARED_RELEASE_ID"'))
  })

  it('provides a foreground systemd entrypoint that ensures the controller and execs the immutable server', () => {
    const source = fs.readFileSync(foreground, 'utf8')
    expect(source).toContain('managed ensure-supervisor >/dev/null')
    expect(source).not.toContain('managed ensure-supervisor --replace')
    expect(source).not.toContain('managed preflight')
    expect(source).toContain('managed current --field serverBinary')
    expect(source).toContain('managed web-env-file')
    expect(source).not.toContain('managed backup-registry')
    expect(source).toContain('exec "$BINARY"')
    expect(source).not.toContain('setsid')
  })


  it('keeps the independent controller outside systemd web-stop semantics', () => {
    const unit = fs.readFileSync(path.join(root, 'installers/systemd/freshell-rust.service'), 'utf8')
    expect(unit).toContain('scripts/run-rust-managed.sh')
    expect(unit).toContain('KillMode=process')
    expect(unit).not.toMatch(/^ExecStart=.*target\/release\/freshell-server/m)
  })

  it('stops only pid-file-verified processes and never uses broad process matching', () => {
    const source = fs.readFileSync(launcher, 'utf8')
    expect(source).toContain('/proc/$pid/cmdline')
    expect(source).toContain('kill "$pid"')
    expect(source).not.toMatch(/\bpkill\b|killall|docker\s+(?:rm|kill)\s+\$\(/)
    expect(source).toContain('NOT escalating automatically')
  })
})
