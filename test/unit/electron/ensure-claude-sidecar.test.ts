import { execFileSync as realExecFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureClaudeSidecarDependencies } from '../../../scripts/ensure-claude-sidecar.js'
import { dependencyCacheIdentity } from '../../../docker/sandbox/dependency-cache.mjs'

const SDK_NAME = '@anthropic-ai/claude-agent-sdk'
const SDK_VERSION = '0.3.237'
const PNPM_VERSION = '10.34.5'
const PINNED_PNPM_REMEDIATION = 'npm install --global pnpm@10.34.5'
const INSTALL_ARGS = ['install', '--filter', 'freshell-claude-sidecar', '--frozen-lockfile', '--config.confirmModulesPurge=false']
const CANONICAL_INSTALL_COMMAND = ['pnpm', ...INSTALL_ARGS]
const READY_RECEIPT_FILENAME = '.claude-sidecar-ready.json'

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex')
}

interface FixtureOptions {
  installSdk?: boolean
  sdkVersion?: string
  installNativePackage?: boolean
  writeReceipt?: boolean
}

interface WorkspaceFixture {
  repoRoot: string
  sidecarDir: string
  manifestPath: string
  lockPath: string
  workspacePath: string
  receiptPath: string
  pnpmEntryPath: string
  manifestMd5: string
  lockMd5: string
  workspaceMd5: string
  env: NodeJS.ProcessEnv
  writeSdk(version: string): void
  writeNativePackage(): void
}

const fixtureRoots: string[] = []

function buildWorkspaceFixture(options: FixtureOptions = {}): WorkspaceFixture {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'freshell-sidecar-workspace-'))
  fixtureRoots.push(repoRoot)

  const sidecarDir = path.join(repoRoot, 'crates', 'freshell-claude-sidecar')
  mkdirSync(path.join(sidecarDir, 'node_modules'), { recursive: true })

  writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: 'freshell',
    packageManager: 'pnpm@10.34.5',
  }))

  const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml')
  const workspaceContent = 'packages:\n  - crates/freshell-claude-sidecar\n'
  writeFileSync(workspacePath, workspaceContent)

  const lockPath = path.join(repoRoot, 'pnpm-lock.yaml')
  const lockContent = 'lockfileVersion: 9.0\narbitrary lock content\n'
  writeFileSync(lockPath, lockContent)

  const manifestPath = path.join(sidecarDir, 'package.json')
  const manifestContent = JSON.stringify({
    name: 'freshell-claude-sidecar',
    version: '0.1.0',
    dependencies: { [SDK_NAME]: SDK_VERSION },
  })
  writeFileSync(manifestPath, manifestContent)

  const sdkDir = path.join(sidecarDir, 'node_modules', ...SDK_NAME.split('/'))
  const writeSdk = (version: string) => {
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: SDK_NAME,
      version,
      exports: { '.': './index.mjs' },
    }))
    writeFileSync(path.join(sdkDir, 'index.mjs'), 'export {}\n')
  }

  const nativePackageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const writeNativePackage = () => {
    const nativeDir = path.join(sidecarDir, 'node_modules', ...nativePackageName.split('/'))
    mkdirSync(nativeDir, { recursive: true })
    writeFileSync(path.join(nativeDir, 'package.json'), JSON.stringify({
      name: nativePackageName,
      version: SDK_VERSION,
    }))
  }

  if (options.installSdk !== false) writeSdk(options.sdkVersion ?? SDK_VERSION)
  if (options.installSdk !== false && options.installNativePackage !== false) writeNativePackage()

  const manifestMd5 = md5(manifestContent)
  const lockMd5 = md5(lockContent)
  const workspaceMd5 = md5(workspaceContent)

  const receiptPath = path.join(sidecarDir, 'node_modules', READY_RECEIPT_FILENAME)
  if (options.writeReceipt === true) {
    writeFileSync(receiptPath, JSON.stringify({
      sdkVersion: SDK_VERSION,
      pnpmVersion: PNPM_VERSION,
      manifestMd5,
      lockMd5,
      workspaceMd5,
      at: '2026-09-20T00:00:00.000Z',
    }))
  }

  const pnpmEntryPath = path.join(repoRoot, 'pnpm.cjs')
  writeFileSync(pnpmEntryPath, '')

  return {
    repoRoot,
    sidecarDir,
    manifestPath,
    lockPath,
    workspacePath,
    receiptPath,
    pnpmEntryPath,
    manifestMd5,
    lockMd5,
    workspaceMd5,
    env: { npm_execpath: pnpmEntryPath },
    writeSdk,
    writeNativePackage,
  }
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

interface RecordedInvocation {
  command: string
  args: string[]
  cwd?: string
}

interface SpawnSeamOptions {
  onInstall?: () => void
  installExitCode?: number
}

function createSpawnSeam(seamOptions: SpawnSeamOptions = {}) {
  const invocations: RecordedInvocation[] = []
  const execFileSync = vi.fn((
    command: string,
    args: readonly string[],
    callOptions?: { cwd?: string },
  ) => {
    invocations.push({ command, args: [...args], cwd: callOptions?.cwd })
    if (args[args.length - 1] === '--version') {
      return `${PNPM_VERSION}\n`
    }
    const isInstallInvocation = args.length >= INSTALL_ARGS.length
      && INSTALL_ARGS.every((arg, index) => args[args.length - INSTALL_ARGS.length + index] === arg)
    if (isInstallInvocation) {
      if (seamOptions.installExitCode !== undefined && seamOptions.installExitCode !== 0) {
        throw Object.assign(new Error(`simulated pnpm exit ${seamOptions.installExitCode}`), {
          status: seamOptions.installExitCode,
        })
      }
      seamOptions.onInstall?.()
      return ''
    }
    throw new Error(`Unexpected spawn during test: ${command} ${args.join(' ')}`)
  })
  return { execFileSync, invocations }
}

function invocationsWithSuffix(
  invocations: RecordedInvocation[],
  suffix: readonly string[],
): RecordedInvocation[] {
  return invocations.filter((invocation) => invocation.args.length >= suffix.length
    && suffix.every((arg, index) => invocation.args[invocation.args.length - suffix.length + index] === arg))
}

function ensureSidecar(
  fixture: WorkspaceFixture,
  execFileSync: ReturnType<typeof createSpawnSeam>['execFileSync'],
  overrides: Record<string, unknown> = {},
) {
  return ensureClaudeSidecarDependencies({
    sidecarDir: fixture.sidecarDir,
    repoRoot: fixture.repoRoot,
    env: fixture.env,
    platform: process.platform,
    execFileSync: execFileSync as unknown as typeof realExecFileSync,
    ...overrides,
  })
}

function captureError(action: () => unknown): Error {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the action to throw')
}

function prepareSandboxFixture(fixture: WorkspaceFixture) {
  const metadataDir = path.join(fixture.repoRoot, 'sandbox-metadata')
  const foundation = `sha256:${'a'.repeat(64)}`
  mkdirSync(metadataDir)
  writeFileSync(path.join(metadataDir, 'foundation-id'), foundation)
  const protocol = { version: 2, image: 'freshell-sandbox:dependencies-v2', cacheSuffix: 'dependencies-v2' }
  writeFileSync(path.join(metadataDir, 'protocol.json'), JSON.stringify(protocol))
  mkdirSync(path.join(fixture.repoRoot, 'docker/sandbox'), { recursive: true })
  writeFileSync(path.join(fixture.repoRoot, 'docker/sandbox/protocol.json'), JSON.stringify(protocol))
  const key = dependencyCacheIdentity(fixture.repoRoot, foundation, protocol.version)
  const statePath = path.join(fixture.repoRoot, 'node_modules/.sandbox-deps-state')
  mkdirSync(path.dirname(statePath), { recursive: true })
  const inputFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'crates/freshell-claude-sidecar/package.json']
  const inputHashes = inputFiles.map(file => `${createHash('sha256').update(readFileSync(path.join(fixture.repoRoot, file))).digest('hex')}  ${file}\n`).join('')
  const fingerprint = createHash('sha256').update(`manager=pnpm@${PNPM_VERSION}\npolicy=install --frozen-lockfile --store-dir /home/sandbox/.local/share/pnpm/store\n${inputHashes}`).digest('hex')
  writeFileSync(statePath, `manager=pnpm\nmanager_version=${PNPM_VERSION}\nfingerprint=${fingerprint}\ncache_identity=${key}\n`)
  return { metadataDir, statePath, key, env: { ...fixture.env, FRESHELL_SANDBOX_DEPENDENCY_READONLY: '1', FRESHELL_SANDBOX_DEPENDENCY_KEY: key } }
}

describe('read-only prepared sandbox sidecar dependencies', () => {
  it('reuses verified installed dependencies without a separate sidecar receipt, installer, or write', () => {
    const fixture = buildWorkspaceFixture()
    const prepared = prepareSandboxFixture(fixture)
    const stateBefore = readFileSync(prepared.statePath, 'utf8')
    const { execFileSync, invocations } = createSpawnSeam()

    const receipt = ensureSidecar(fixture, execFileSync, { env: prepared.env, sandboxMetadataDir: prepared.metadataDir })

    expect(receipt).toMatchObject({ repaired: false, packageVersion: SDK_VERSION, packageManagerVersion: PNPM_VERSION })
    expect(invocations).toHaveLength(0)
    expect(existsSync(fixture.receiptPath)).toBe(false)
    expect(readFileSync(prepared.statePath, 'utf8')).toBe(stateBefore)
  })

  it.each([
    ['SDK version', (f: WorkspaceFixture) => f.writeSdk('0.3.100')],
    ['SDK entrypoint', (f: WorkspaceFixture) => rmSync(path.join(f.sidecarDir, 'node_modules', SDK_NAME, 'index.mjs'))],
    ['native version', (f: WorkspaceFixture) => writeFileSync(path.join(f.sidecarDir, 'node_modules', `${SDK_NAME}-${process.platform}-${process.arch}`, 'package.json'), JSON.stringify({ name: `${SDK_NAME}-${process.platform}-${process.arch}`, version: '0.0.1' }))],
    ['dependency input', (f: WorkspaceFixture) => writeFileSync(f.lockPath, 'changed input')],
    ['missing state', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => rmSync(p.statePath)],
    ['unreadable state', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => { rmSync(p.statePath); mkdirSync(p.statePath) }],
    ['stale identity', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => writeFileSync(p.statePath, readFileSync(p.statePath, 'utf8').replace(p.key, '0'.repeat(64)))],
    ['stale fingerprint', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => writeFileSync(p.statePath, readFileSync(p.statePath, 'utf8').replace(/fingerprint=.*/, `fingerprint=${'0'.repeat(64)}`))],
    ['unpinned manager', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => writeFileSync(p.statePath, readFileSync(p.statePath, 'utf8').replace(PNPM_VERSION, '0.0.1'))],
    ['unqualified selection', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => { delete (p.env as NodeJS.ProcessEnv).FRESHELL_SANDBOX_DEPENDENCY_KEY }],
    ['missing metadata', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => rmSync(p.metadataDir, { recursive: true })],
    ['stale protocol', (_f: WorkspaceFixture, p: ReturnType<typeof prepareSandboxFixture>) => writeFileSync(path.join(p.metadataDir, 'protocol.json'), JSON.stringify({ version: 1 }))],
  ] as const)('refuses invalid %s without installing or writing despite a current sidecar receipt', (_name, invalidate) => {
    const fixture = buildWorkspaceFixture({ writeReceipt: true })
    const prepared = prepareSandboxFixture(fixture)
    const receiptBefore = readFileSync(fixture.receiptPath, 'utf8')
    invalidate(fixture, prepared)
    const { execFileSync, invocations } = createSpawnSeam()

    expect(() => ensureSidecar(fixture, execFileSync, { env: prepared.env, sandboxMetadataDir: prepared.metadataDir })).toThrow(/read-only sandbox/i)
    expect(invocations).toHaveLength(0)
    expect(readFileSync(fixture.receiptPath, 'utf8')).toBe(receiptBefore)
  })

  it('refuses an unavailable target-platform native package without invoking pnpm', () => {
    const fixture = buildWorkspaceFixture({ writeReceipt: true })
    const prepared = prepareSandboxFixture(fixture)
    const { execFileSync, invocations } = createSpawnSeam()
    expect(() => ensureSidecar(fixture, execFileSync, {
      env: prepared.env, sandboxMetadataDir: prepared.metadataDir,
      platform: process.platform === 'darwin' ? 'linux' : 'darwin',
    })).toThrow(/read-only sandbox.*native package/i)
    expect(invocations).toHaveLength(0)
  })
})

describe('Claude sidecar dependency readiness and repair', () => {
  it('returns a ready receipt without spawning pnpm when the installation and fingerprint are current', () => {
    const fixture = buildWorkspaceFixture({ writeReceipt: true })
    const { execFileSync, invocations } = createSpawnSeam()

    const receipt = ensureSidecar(fixture, execFileSync)

    expect(invocations).toHaveLength(0)
    expect(receipt).toEqual({
      severity: 'info',
      event: 'claude_sidecar_dependencies_ready',
      sidecarDir: fixture.sidecarDir,
      packageName: SDK_NAME,
      packageVersion: SDK_VERSION,
      installCommand: CANONICAL_INSTALL_COMMAND,
      packageManagerVersion: PNPM_VERSION,
      fingerprint: {
        manifestMd5: fixture.manifestMd5,
        lockMd5: fixture.lockMd5,
        workspaceMd5: fixture.workspaceMd5,
      },
      repaired: false,
    })
  })

  it('repairs a missing installation with a frozen filtered pnpm install at the workspace root', () => {
    const fixture = buildWorkspaceFixture({ installSdk: false, installNativePackage: false })
    const { execFileSync, invocations } = createSpawnSeam({
      onInstall: () => {
        fixture.writeSdk(SDK_VERSION)
        fixture.writeNativePackage()
      },
    })

    const receipt = ensureSidecar(fixture, execFileSync)

    const installInvocations = invocationsWithSuffix(invocations, INSTALL_ARGS)
    expect(installInvocations).toHaveLength(1)
    expect(installInvocations[0].cwd).toBe(fixture.repoRoot)
    expect(installInvocations[0].command).toBe(process.execPath)
    expect(installInvocations[0].args).toEqual([fixture.pnpmEntryPath, ...INSTALL_ARGS])

    expect(invocationsWithSuffix(invocations, ['--version'])).toHaveLength(1)

    expect(receipt).toMatchObject({
      severity: 'info',
      event: 'claude_sidecar_dependencies_ready',
      sidecarDir: fixture.sidecarDir,
      packageName: SDK_NAME,
      packageVersion: SDK_VERSION,
      installCommand: [process.execPath, fixture.pnpmEntryPath, ...INSTALL_ARGS],
      packageManagerVersion: PNPM_VERSION,
      fingerprint: {
        manifestMd5: fixture.manifestMd5,
        lockMd5: fixture.lockMd5,
        workspaceMd5: fixture.workspaceMd5,
      },
      repaired: true,
    })

    expect(JSON.parse(readFileSync(fixture.receiptPath, 'utf8'))).toEqual({
      sdkVersion: SDK_VERSION,
      pnpmVersion: PNPM_VERSION,
      manifestMd5: fixture.manifestMd5,
      lockMd5: fixture.lockMd5,
      workspaceMd5: fixture.workspaceMd5,
      at: expect.any(String),
    })
  })

  it('repairs a stale fingerprint and rewrites the readiness receipt', () => {
    const fixture = buildWorkspaceFixture({ writeReceipt: true })
    const mutatedLockContent = 'lockfileVersion: 9.0\narbitrary lock content\nmutated after the receipt was written\n'
    writeFileSync(fixture.lockPath, mutatedLockContent)
    const { execFileSync, invocations } = createSpawnSeam()

    const { repoRoot: _derived, ...callFixture } = fixture
    const receipt = ensureClaudeSidecarDependencies({
      sidecarDir: callFixture.sidecarDir,
      env: callFixture.env,
      platform: process.platform,
      execFileSync: execFileSync as unknown as typeof realExecFileSync,
    })

    expect(invocationsWithSuffix(invocations, INSTALL_ARGS)).toHaveLength(1)
    expect(receipt.repaired).toBe(true)
    expect(receipt.fingerprint).toEqual({
      manifestMd5: fixture.manifestMd5,
      lockMd5: md5(mutatedLockContent),
      workspaceMd5: fixture.workspaceMd5,
    })

    const savedReceipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'))
    expect(savedReceipt.lockMd5).toBe(md5(mutatedLockContent))
    expect(savedReceipt.sdkVersion).toBe(SDK_VERSION)
    expect(savedReceipt.pnpmVersion).toBe(PNPM_VERSION)
  })

  it('fails without writing a receipt when the repaired SDK version does not match the manifest pin', () => {
    const fixture = buildWorkspaceFixture({ installSdk: false })
    const { execFileSync } = createSpawnSeam({
      onInstall: () => fixture.writeSdk('0.3.100'),
    })

    const error = captureError(() => ensureSidecar(fixture, execFileSync))

    expect(error.message).toContain('0.3.100')
    expect(error.message).toContain(SDK_VERSION)
    expect(existsSync(fixture.receiptPath)).toBe(false)
  })

  it('repairs a missing platform native package and is ready on the next invocation', () => {
    const fixture = buildWorkspaceFixture({ installNativePackage: false })
    const { execFileSync } = createSpawnSeam({
      onInstall: () => fixture.writeNativePackage(),
    })

    const repaired = ensureSidecar(fixture, execFileSync)
    expect(repaired.repaired).toBe(true)

    const secondSeam = createSpawnSeam()
    const ready = ensureSidecar(fixture, secondSeam.execFileSync)
    expect(ready.repaired).toBe(false)
    expect(ready.packageManagerVersion).toBe(PNPM_VERSION)
    expect(secondSeam.invocations).toHaveLength(0)
  })

  it('fails on a frozen install failure without ever attempting a mutable recovery', () => {
    const fixture = buildWorkspaceFixture({ installSdk: false })
    const { execFileSync, invocations } = createSpawnSeam({ installExitCode: 1 })

    const error = captureError(() => ensureSidecar(fixture, execFileSync))

    expect(error.message).toContain('--frozen-lockfile')
    expect(error.message).toContain('No mutable recovery')
    const installInvocations = invocations.filter((invocation) => invocation.args.includes('install'))
    expect(installInvocations).toHaveLength(1)
    expect(installInvocations[0].args).toContain('--frozen-lockfile')
  })

  it('fails with the pinned pnpm remediation when pnpm cannot be resolved', () => {
    const fixture = buildWorkspaceFixture({ installSdk: false })
    const { execFileSync, invocations } = createSpawnSeam()

    const error = captureError(() => ensureSidecar(fixture, execFileSync, {
      env: {},
      envPath: '',
    }))

    expect(error.message).toContain(PINNED_PNPM_REMEDIATION)
    expect(invocations).toHaveLength(0)
  })
})
