import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  ManifestError,
  NATIVE_ROLES,
  classifyReceipt,
  fixedInputs,
  nativeDockerArgv,
  parseManifest,
  runNativeSessionNamesSandbox,
  validateInputs,
} from '../../../scripts/testing/native-session-names-sandbox.mjs'

/**
 * UNIFIED AGENT NAMES (Task 8) — the native contract runner's child-process
 * boundary, exercised with INJECTED fakes (never a real Docker daemon, never
 * a real provider): fail-on-missing inputs BEFORE any Docker mutation, the
 * fixed five-role manifest contract, argv containment (read-only mounts,
 * no operator home, entrypoint bypass, network isolation, no implicit
 * install tokens anywhere in the launch), and executed-receipt
 * classification (a missing or failed provider result is a failure; a
 * not-measured live redraw never is).
 *
 * These tests exercise the wrapper's actual decision logic end to end — the
 * fake `docker` records the exact argv and simulates container exit/receipt
 * outcomes. No test searches plan/docs/config text for behavior.
 */

// ---------------------------------------------------------------------------
// An injectable in-memory filesystem
// ---------------------------------------------------------------------------

function memFs(files: Record<string, string> = {}) {
  return {
    existsSync: (p: string) => files[path.resolve(p)] !== undefined,
    readFileSync: (p: string) => {
      const resolved = path.resolve(p)
      if (files[resolved] === undefined) throw new Error(`ENOENT ${resolved}`)
      return files[resolved]
    },
    mkdtempSync: (prefix: string) => {
      const dir = path.join(os.tmpdir(), `${path.basename(prefix)}-fake`)
      return dir
    },
    mkdirSync: () => {},
    writeFileSync: () => {},
    copyFileSync: () => {},
    rmSync: () => {},
  }
}

/** The full happy-path input set: every fixed role's root/entry/version file. */
function completeInputFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const input of fixedInputs()) {
    files[input.root] = 'dir'
    if (input.entryRelativePath) {
      files[path.join(input.root, input.entryRelativePath)] = 'binary-bytes'
    }
    if (input.versionFile) {
      files[path.join(input.root, input.versionFile)] = JSON.stringify({ version: '1.0.0' })
    }
    for (const required of input.requiredFiles ?? []) {
      files[path.join(input.root, required)] = 'required'
    }
  }
  return files
}

function fakeDeps(files: Record<string, string>, overrides: Record<string, unknown> = {}) {
  const spawns: Array<{ file: string; argv: string[]; env?: unknown }> = []
  const deps: Record<string, unknown> = {
    platform: 'linux',
    arch: 'x64',
    fs: memFs(files),
    uid: 1000,
    gid: 1000,
    imageIdentity: async () => 'sha256:freshell-sandbox-image-id',
    spawn: (file: string, argv: string[]) => {
      spawns.push({ file, argv })
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, listener: (payload: unknown) => void) => {
          if (event === 'close') {
            // The default fake docker "runs" the container and exits 0
            // WITHOUT writing a receipt; individual tests override this by
            // writing the receipt file into `files` beforehand.
            setTimeout(() => listener({ code: 0 }), 0)
          }
        },
      }
    },
    ...overrides,
  }
  return { deps, spawns }
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe('native-session-names manifest validation', () => {
  it('accepts exactly the five roles with absolute roots and non-escaping entries', () => {
    const manifest = parseManifest({
      version: 1,
      inputs: NATIVE_ROLES.map((role) => ({ role, root: `/fixed/${role}`, entryRelativePath: 'bin/entry' })),
    })
    expect(manifest.version).toBe(1)
    expect(manifest.inputs.map((input: { role: string }) => input.role).sort()).toEqual([...NATIVE_ROLES].sort())
  })

  it('rejects a missing role', () => {
    const inputs = NATIVE_ROLES.filter((role) => role !== 'opencode')
      .map((role) => ({ role, root: `/x/${role}` }))
    expect(() => parseManifest({ version: 1, inputs })).toThrow(ManifestError)
  })

  it('rejects a duplicate role', () => {
    const inputs = NATIVE_ROLES.map((role) => ({ role, root: `/x/${role}` }))
    inputs.push({ role: 'codex', root: '/x/codex-again' })
    expect(() => parseManifest({ version: 1, inputs })).toThrow(/duplicate/i)
  })

  it('rejects an unknown role', () => {
    const inputs = NATIVE_ROLES.map((role) => ({ role, root: `/x/${role}` }))
    inputs.push({ role: 'nmap', root: '/x/nmap' })
    expect(() => parseManifest({ version: 1, inputs })).toThrow(/unknown manifest role/)
  })

  it('rejects a relative root', () => {
    const inputs = NATIVE_ROLES.map((role) => ({ role, root: `relative/${role}` }))
    expect(() => parseManifest({ version: 1, inputs })).toThrow(/absolute/i)
  })

  it('rejects an escaping entryRelativePath', () => {
    const inputs = NATIVE_ROLES.map((role) => ({ role, root: `/x/${role}`, entryRelativePath: 'bin/entry' }))
    inputs[1].entryRelativePath = '../../escape'
    expect(() => parseManifest({ version: 1, inputs })).toThrow(/escapes/i)
  })

  it('rejects an incompatible manifest version', () => {
    expect(() => parseManifest({ version: 2, inputs: [] })).toThrow(/exactly 1/)
  })
})

// ---------------------------------------------------------------------------
// Input validation — fail-on-missing BEFORE any Docker mutation
// ---------------------------------------------------------------------------

describe('native-session-names input validation', () => {
  it('accepts the complete fixed input set', () => {
    const { problems } = validateInputs(fixedInputs(), {
      platform: 'linux',
      arch: 'x64',
      fs: memFs(completeInputFiles()),
    })
    expect(problems).toEqual([])
  })

  it('fails on a missing provider root', () => {
    const files = completeInputFiles()
    delete files[fixedInputs().find((input) => input.role === 'codex')!.root]
    const { problems } = validateInputs(fixedInputs(), {
      platform: 'linux',
      arch: 'x64',
      fs: memFs(files),
    })
    expect(problems.some((problem) => problem.includes('codex: root does not exist'))).toBe(true)
  })

  it('fails on a missing staged runtime artifact', () => {
    const files = completeInputFiles()
    delete files[path.join(fixedInputs().find((input) => input.role === 'runtime')!.root, 'claude-sidecar', 'session-names.mjs')]
    const { problems } = validateInputs(fixedInputs(), {
      platform: 'linux',
      arch: 'x64',
      fs: memFs(files),
    })
    expect(problems.some((problem) => problem.includes('required file missing'))).toBe(true)
  })

  it('fails on an incompatible host platform', () => {
    const { problems } = validateInputs(fixedInputs(), {
      platform: 'darwin',
      arch: 'arm64',
      fs: memFs(completeInputFiles()),
    })
    expect(problems.some((problem) => problem.includes('linux/x64'))).toBe(true)
  })

  it('fails on a manifest-declared version mismatch', () => {
    const inputs = fixedInputs().map((input) =>
      input.role === 'codex' ? { ...input, expectedVersion: '0.999.0' } : input)
    const { problems } = validateInputs(inputs, {
      platform: 'linux',
      arch: 'x64',
      fs: memFs(completeInputFiles()),
    })
    expect(problems.some((problem) => problem.includes('version mismatch'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Docker argv containment
// ---------------------------------------------------------------------------

describe('native-session-names docker argv containment', () => {
  it('mounts only the fixed tools read-only plus explicit scratch/receipt dirs', () => {
    const inputs = fixedInputs()
    const argv = nativeDockerArgv(inputs, { uid: 1000, gid: 1000, scratchDir: '/tmp/run/scratch', receiptDir: '/tmp/run/receipts', runnerStagedPath: '/tmp/run/native-session-names-runner.mjs' })
    const mounts = argv.flatMap((value, index) => (value === '-v' ? [argv[index + 1]] : []))
    expect(mounts.filter((mount) => mount.endsWith(':ro')).length)
      .toBe(inputs.length) // claude + codex + opencode + runtime + runner
    expect(mounts.filter((mount) => mount.endsWith(':rw'))).toEqual([
      '/tmp/run/scratch:/scratch:rw',
      '/tmp/run/receipts:/receipts:rw',
    ])
    // The runner mounts the PER-RUN STAGED COPY, never the repo file
    // itself: WSL docker caches file-bind inodes across runs, and an
    // in-place runner edit otherwise keeps executing the stale bytes
    // inside the container (observed end-to-end).
    expect(mounts).toContain('/tmp/run/native-session-names-runner.mjs:/opt/freshell-native/native-session-names.mjs:ro')
    expect(mounts.some((mount) => mount.includes('scripts/testing'))).toBe(false)
    // No operator home, no corpus, no repo workspace, no credentials.
    for (const mount of mounts) {
      expect(mount.startsWith(`${os.homedir()}:`)).toBe(false)
      expect(mount).not.toContain('.claude')
      expect(mount).not.toContain('.codex')
      expect(mount).not.toContain('opencode.db')
    }
  })

  it('isolates the network and PID namespace and bypasses the image entrypoint', () => {
    const argv = nativeDockerArgv(fixedInputs(), { uid: 1000, gid: 1000, scratchDir: '/s', receiptDir: '/r', runnerStagedPath: '/s/native-session-names-runner.mjs' })
    expect(argv).toContain('--network')
    expect(argv[argv.indexOf('--network') + 1]).toBe('none')
    expect(argv).toContain('--pids-limit')
    expect(argv).toContain('--rm')
    expect(argv).toContain('--user')
    expect(argv[argv.indexOf('--user') + 1]).toBe('1000:1000')
    expect(argv).toContain('--entrypoint')
    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/usr/local/bin/node')
  })

  it('launches the mounted runner with the image Node — never a shell, never an install', () => {
    const argv = nativeDockerArgv(fixedInputs(), { uid: 1000, gid: 1000, scratchDir: '/s', receiptDir: '/r', runnerStagedPath: '/s/native-session-names-runner.mjs' })
    const imageIndex = argv.indexOf('freshell-sandbox:dependencies-v2')
    expect(imageIndex).toBeGreaterThan(0)
    const runnerArgs = argv.slice(imageIndex + 1)
    expect(runnerArgs[0]).toBe('/opt/freshell-native/native-session-names.mjs')
    // No implicit install/discovery tokens anywhere in the launch.
    for (const token of argv) {
      expect(token).not.toMatch(/npm|install|apt-get|pull|build/i)
    }
  })
})

// ---------------------------------------------------------------------------
// Executed receipt classification
// ---------------------------------------------------------------------------

describe('native-session-names receipt classification', () => {
  const pass = (extra: Record<string, unknown> = {}) => ({ outcome: 'pass', ...extra })

  it('passes only when all three provider contracts ran and passed', () => {
    expect(classifyReceipt({ providers: { claude: pass(), codex: pass(), opencode: pass() } }).exitCode).toBe(0)
  })

  it('fails when a provider result is missing (no skip/opt-in success state)', () => {
    const result = classifyReceipt({ providers: { claude: pass(), codex: pass() } })
    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/opencode.*did not run/)
  })

  it('fails when a provider contract failed', () => {
    const result = classifyReceipt({
      providers: { claude: pass(), codex: { outcome: 'fail', failure: 'boom' }, opencode: pass() },
    })
    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/codex.*boom/)
  })

  it('never fails on an unmeasured live redraw', () => {
    const result = classifyReceipt({
      providers: {
        claude: pass({ liveRedraw: 'not_measured' }),
        codex: pass({ liveRedraw: 'not_measured' }),
        opencode: pass({ liveRedraw: 'not_measured' }),
      },
    })
    expect(result.exitCode).toBe(0)
  })

  it('fails on a non-object receipt', () => {
    expect(classifyReceipt(null).exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The end-to-end run through the injected child-process boundary
// ---------------------------------------------------------------------------

describe('native-session-names sandbox run (injected boundary)', () => {
  const OUTPUT = path.join(os.tmpdir(), 'freshell-native-test-output.json')

  it('exits 2 and never touches Docker when an input is missing', async () => {
    const files = completeInputFiles()
    delete files[fixedInputs().find((input) => input.role === 'opencode')!.root]
    const { deps, spawns } = fakeDeps(files)
    const result = await runNativeSessionNamesSandbox({ output: OUTPUT }, deps)
    expect(result.exitCode).toBe(2)
    expect(result.reason).toMatch(/missing prerequisites/)
    expect(spawns).toEqual([]) // no Docker mutation happened
  })

  it('exits 2 and never touches Docker when the image is missing', async () => {
    const { deps, spawns } = fakeDeps(completeInputFiles(), { imageIdentity: async () => null })
    const result = await runNativeSessionNamesSandbox({ output: OUTPUT }, deps)
    expect(result.exitCode).toBe(2)
    expect(result.reason).toMatch(/image is missing/)
    expect(spawns).toEqual([])
  })

  it('exits 2 on an invalid manifest before any Docker mutation', async () => {
    const { deps, spawns } = fakeDeps(completeInputFiles())
    const manifestPath = '/tmp/freshell-bad-manifest.json'
    const fsWithManifest = {
      ...deps.fs,
      readFileSync: (p: string) => {
        if (path.resolve(p) === manifestPath) return JSON.stringify({ version: 1, inputs: [] })
        return (deps.fs as { readFileSync: (p: string) => string }).readFileSync(p)
      },
    }
    const result = await runNativeSessionNamesSandbox(
      { output: OUTPUT, manifest: manifestPath },
      { ...deps, fs: fsWithManifest },
    )
    expect(result.exitCode).toBe(2)
    expect(result.reason).toMatch(/missing role/)
    expect(spawns).toEqual([])
  })

  it('runs the container, classifies a passing receipt, and writes the output', async () => {
    const files = completeInputFiles()
    const { deps, spawns } = fakeDeps(files, {
      spawn: (file: string, argv: string[]) => {
        spawns.push({ file, argv })
        return {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event: string, listener: (payload: unknown) => void) => {
            if (event === 'close') {
              // The fake container writes its receipt into the mounted
              // receipts dir through the INJECTED filesystem (the memfs the
              // wrapper itself reads back through).
              const receiptDir = path.join(os.tmpdir(), 'freshell-native-smoke--fake', 'receipts')
              files[path.join(receiptDir, 'native-session-names.json')] = JSON.stringify({
                version: 1,
                overall: 'pass',
                providers: {
                  claude: { outcome: 'pass', persistence: 'pass', freshReadback: 'pass', liveRedraw: 'not_measured' },
                  codex: { outcome: 'pass', persistence: 'pass', freshReadback: 'pass', liveRedraw: 'not_measured' },
                  opencode: { outcome: 'pass', persistence: 'pass', freshReadback: 'pass', liveRedraw: 'not_measured' },
                },
              })
              setTimeout(() => listener({ code: 0 }), 0)
            }
          },
        }
      },
    })
    const result = await runNativeSessionNamesSandbox({ output: OUTPUT }, deps)
    expect(result.exitCode).toBe(0)
    expect(spawns).toHaveLength(1)
    expect(spawns[0].file).toBe('docker')
    const argv = spawns[0].argv
    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/usr/local/bin/node')
  })

  it('classifies a container exit with no receipt as a contract failure (exit 1)', async () => {
    const { deps } = fakeDeps(completeInputFiles(), {
      spawn: () => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, listener: (payload: unknown) => void) => {
          if (event === 'close') setTimeout(() => listener({ code: 1 }), 0)
        },
      }),
    })
    const result = await runNativeSessionNamesSandbox({ output: OUTPUT }, deps)
    expect(result.exitCode).toBe(1)
  })

  it('honors FRESHELL_NATIVE_SMOKE_RUN_ROOT for the scratch/receipt mounts (WSL /tmp squash)', async () => {
    // On WSL-backed Docker, binds under /tmp surface in-container as
    // root:root 0700 — the non-root runner user then cannot write its
    // receipt (EACCES observed end-to-end). The run root override moves
    // BOTH owned mount sources under an operator-chosen path (home-tree
    // binds keep the operator's ownership there).
    const files = completeInputFiles()
    const { deps, spawns } = fakeDeps(files, {
      spawn: (file: string, argv: string[]) => {
        spawns.push({ file, argv })
        return {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event: string, listener: (payload: unknown) => void) => {
            if (event === 'close') {
              const receiptDir = '/home/sandbox-owner/freshell-native-smoke/receipts'
              files[path.join(receiptDir, 'native-session-names.json')] = JSON.stringify({
                version: 1,
                overall: 'pass',
                providers: {
                  claude: { outcome: 'pass', persistence: 'pass', freshReadback: 'pass', liveRedraw: 'not_measured' },
                  codex: { outcome: 'pass', persistence: 'pass', freshReadback: 'pass', liveRedraw: 'not_measured' },
                  opencode: { outcome: 'pass', persistence: 'pass', freshReadback: 'pass', liveRedraw: 'not_measured' },
                },
              })
              setTimeout(() => listener({ code: 0 }), 0)
            }
          },
        }
      },
    })
    const prior = process.env.FRESHELL_NATIVE_SMOKE_RUN_ROOT
    process.env.FRESHELL_NATIVE_SMOKE_RUN_ROOT = '/home/sandbox-owner/freshell-native-smoke'
    try {
      const result = await runNativeSessionNamesSandbox({ output: OUTPUT }, deps)
      expect(result.exitCode).toBe(0)
      const argv = spawns[0].argv
      const mounts = argv.flatMap((value: string, index: number) => (value === '-v' ? [argv[index + 1]] : []))
      const rw = mounts.filter((mount: string) => mount.endsWith(':rw'))
      expect(rw).toEqual([
        '/home/sandbox-owner/freshell-native-smoke/scratch:/scratch:rw',
        '/home/sandbox-owner/freshell-native-smoke/receipts:/receipts:rw',
      ])
    } finally {
      if (prior === undefined) delete process.env.FRESHELL_NATIVE_SMOKE_RUN_ROOT
      else process.env.FRESHELL_NATIVE_SMOKE_RUN_ROOT = prior
    }
  })

  it('requires --require-all at the CLI level — there is no skip success state', async () => {
    // Enforced by cliMain; the exported run path is only invoked with it.
    // The classification contract above pins the no-skip semantics; here the
    // documented flag's presence is pinned against the CLI contract.
    const { cliMain } = await import('../../../scripts/testing/native-session-names-sandbox.mjs')
    const exitCodes: number[] = []
    const originalExit = process.exit
  ;(process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCodes.push(code ?? 0)
      throw new Error('exit')
    }) as typeof process.exit
    try {
      await cliMain(['--output', OUTPUT])
    } catch {
      // process.exit throws in the test
    } finally {
      ;(process as unknown as { exit: typeof process.exit }).exit = originalExit
    }
    expect(exitCodes).toEqual([2])
  })
})
