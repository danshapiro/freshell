// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  computeRustTestPlan,
  graphFromCargoMetadata,
  planToInvocation,
  type WorkspaceGraph,
} from '../../../scripts/hooks/rust-test-targets.js'
import { resolveOwningTsx } from '@test/helpers/tsx-stub-resolution'

// Workspace fixture mirroring the real dependency directions:
// server -> {ws, terminal, sessions, freshagent, protocol}
// freshagent -> {ws, terminal, protocol}
// ws -> {protocol}
// tauri -> {server}
const graph: WorkspaceGraph = {
  members: [
    'freshell-server',
    'freshell-ws',
    'freshell-terminal',
    'freshell-sessions',
    'freshell-freshagent',
    'freshell-protocol',
    'freshell-tauri',
  ],
  edges: {
    'freshell-server': ['freshell-ws', 'freshell-terminal', 'freshell-sessions', 'freshell-freshagent', 'freshell-protocol'],
    'freshell-freshagent': ['freshell-ws', 'freshell-terminal', 'freshell-protocol'],
    'freshell-ws': ['freshell-protocol'],
    'freshell-terminal': [],
    'freshell-sessions': [],
     'freshell-protocol': [],
     'freshell-tauri': ['freshell-server'],
   },
}

// (The owningTsxPath unit block from the pnpm-era base was removed with the
// helper in this merge: this branch's resolveOwningTsx supersedes it, and
// its behavior is pinned in test/unit/scripts/tsx-stub-resolution.test.ts.)

describe('computeRustTestPlan', () => {
  it('skips when nothing changed', () => {
    expect(computeRustTestPlan([], graph)).toEqual({ mode: 'skip' })
  })

  it('skips for client-only and docs-only changes', () => {
    expect(computeRustTestPlan(['src/components/App.tsx', 'docs/index.html'], graph)).toEqual({ mode: 'skip' })
    expect(computeRustTestPlan(['README.md'], graph)).toEqual({ mode: 'skip' })
  })

  it('tests a changed crate plus its transitive workspace dependents', () => {
    expect(computeRustTestPlan(['crates/freshell-ws/src/lib.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-server', 'freshell-ws'],
    })
  })

  it('tests only the changed crate when nothing depends on it', () => {
    expect(computeRustTestPlan(['crates/freshell-server/src/main.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-server'],
    })
  })

  it('closes transitively across the whole chain', () => {
    expect(computeRustTestPlan(['crates/freshell-protocol/src/lib.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-protocol', 'freshell-server', 'freshell-ws'],
    })
  })

  it('ignores client files mixed into a rust push', () => {
    expect(computeRustTestPlan(['src/lib/api.ts', 'crates/freshell-terminal/src/x.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-server', 'freshell-terminal'],
    })
  })

  it('excludes freshell-tauri per clippy parity, alone and mixed', () => {
    expect(computeRustTestPlan(['crates/freshell-tauri/src/main.rs'], graph)).toEqual({ mode: 'skip' })
    expect(
      computeRustTestPlan(['crates/freshell-tauri/src/main.rs', 'crates/freshell-ws/src/lib.rs'], graph),
    ).toEqual({ mode: 'packages', packages: ['freshell-freshagent', 'freshell-server', 'freshell-ws'] })
  })

  it('falls back to the whole workspace for unknown crate directories', () => {
    expect(computeRustTestPlan(['crates/freshell-newthing/src/lib.rs'], graph)).toEqual({ mode: 'workspace' })
  })

  it('treats root-level rust files as workspace-wide', () => {
    for (const p of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rust-toolchain', '.cargo/config.toml']) {
      expect(computeRustTestPlan([p], graph)).toEqual({ mode: 'workspace' })
    }
  })

  it('treats rust files outside crates/ as workspace-wide', () => {
    expect(computeRustTestPlan(['tools/foo.rs'], graph)).toEqual({ mode: 'workspace' })
  })

  it('treats test fixtures consumed by rust tests as workspace-wide', () => {
    expect(
      computeRustTestPlan(['test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs'], graph),
    ).toEqual({ mode: 'workspace' })
  })

  it('widens to the workspace when a fixture change mixes with a crate change', () => {
    expect(
      computeRustTestPlan(['test/fixtures/x.mjs', 'crates/freshell-terminal/src/x.rs'], graph),
    ).toEqual({ mode: 'workspace' })
  })

  it('treats crate-local manifests as crate changes', () => {
    expect(computeRustTestPlan(['crates/freshell-ws/Cargo.toml'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-server', 'freshell-ws'],
    })
  })
})

describe('graphFromCargoMetadata', () => {
  it('builds members and workspace-internal edges from real cargo package-ID metadata', () => {
    const metadata = {
      workspace_members: [
        'path+file:///repo/crates/freshell-server/Cargo.toml#0.7.5',
        'path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5',
        'path+file:///repo/crates/freshell-protocol/Cargo.toml#0.7.5',
      ],
      packages: [
        {
          name: 'freshell-server',
          id: 'path+file:///repo/crates/freshell-server/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-server/Cargo.toml',
          dependencies: [{ name: 'freshell-ws' }, { name: 'serde' }, { name: 'freshell-protocol' }],
        },
        {
          name: 'freshell-ws',
          id: 'path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-ws/Cargo.toml',
          dependencies: [{ name: 'freshell-protocol' }, { name: 'tokio' }],
        },
        {
          name: 'freshell-protocol',
          id: 'path+file:///repo/crates/freshell-protocol/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-protocol/Cargo.toml',
          dependencies: [],
        },
      ],
    }
    const built = graphFromCargoMetadata(JSON.stringify(metadata))
    expect(built.members.sort()).toEqual(['freshell-protocol', 'freshell-server', 'freshell-ws'])
    expect(built.edges['freshell-server'].sort()).toEqual(['freshell-protocol', 'freshell-ws'])
    expect(built.edges['freshell-ws']).toEqual(['freshell-protocol'])
  })

  it('still resolves when workspace_members are manifest paths', () => {
    const metadata = {
      workspace_members: ['/repo/crates/freshell-ws/Cargo.toml'],
      packages: [
        {
          name: 'freshell-ws',
          manifest_path: '/repo/crates/freshell-ws/Cargo.toml',
          dependencies: [],
        },
      ],
    }
    expect(graphFromCargoMetadata(JSON.stringify(metadata)).members).toEqual(['freshell-ws'])
  })

  it('ignores packages that are not workspace members', () => {
    const metadata = {
      workspace_members: ['path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5'],
      packages: [
        {
          name: 'freshell-ws',
          id: 'path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-ws/Cargo.toml',
          dependencies: [{ name: 'some-external-dep' }],
        },
        {
          name: 'non-member',
          id: 'path+file:///repo/other/Cargo.toml#1.0.0',
          manifest_path: '/repo/other/Cargo.toml',
          dependencies: [],
        },
      ],
    }
    const built = graphFromCargoMetadata(JSON.stringify(metadata))
    expect(built.members).toEqual(['freshell-ws'])
    expect(built.edges['freshell-ws']).toEqual([])
  })
})

describe('planToInvocation', () => {
  it('renders skip as an empty invocation', () => {
    expect(planToInvocation({ mode: 'skip' })).toBe('')
  })

  it('renders workspace as a full workspace test with the tauri exclusion', () => {
    expect(planToInvocation({ mode: 'workspace' })).toBe(
      'cargo test --workspace --exclude freshell-tauri --locked',
    )
  })

  it('renders a targeted package invocation in deterministic order', () => {
    expect(
      planToInvocation({ mode: 'packages', packages: ['freshell-ws', 'freshell-server'] }),
    ).toBe('cargo test --locked -p freshell-server -p freshell-ws')
  })
})

describe('pre-push hook routing (hermetic fixture repo)', () => {
  const hookPath = path.resolve(import.meta.dirname, '../../../scripts/hooks/pre-push')

  // The hook resolves tsx from cwd, the script dir, or the owning checkout.
  // A fresh worktree has no node_modules, so pin the real tsx from the
  // owning checkout and stub it into the fixture repo — the hermetic tests
  // then exercise the hook's full chain regardless of the worktree's
  // install state (the hook passes the real rust-test-targets.ts path as
  // the script argument, so the stub only supplies the runtime).
  // The stub MUST embed an ABSOLUTE tsx path: the cloud test image ships
  // no .git metadata, so plain git common-dir resolution yields a relative
  // path there — and a relative stub exec's ITSELF inside the fixture repo
  // in an infinite /bin/sh exec loop that freezes the worker (spawnSync
  // blocks the event loop, so no vitest timeout ever fires). resolveOwningTsx
  // falls back to a package.json walk-up in gitless checkouts, so the stub
  // path is absolute in every environment (see
  // test/unit/scripts/tsx-stub-resolution.test.ts).
  const realTsx = resolveOwningTsx(import.meta.dirname)

  let fixtureRoot: string
  let baseSha: string
  let rustSha: string
  let docsSha: string
  let tauriSha: string
  let fixtureSha: string
  let cargoConfigSha: string
  let pnpmLockSha: string
  let pnpmWorkspaceSha: string
  let npmrcSha: string
  let fakeCargoLog: string
  let fakeSandboxLog: string
  let fakeCargoMetadata: string
  let fakePnpmLog: string
  let fakeBinDir: string
  let fakeSandboxRunner: string

  function git(args: string[], opts: { cwd: string; stdin?: string } = { cwd: '' }): string {
    const res = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
    if (res.status !== 0 || res.error) {
      const detail = res.error
        ? `${res.error.message}${res.error.code === 'ETIMEDOUT' ? ' (timed out after 10s)' : ''}`
        : res.stderr
      throw new Error(`git ${args.join(' ')} failed: ${detail}`)
    }
    return (res.stdout ?? '').trim()
  }

  function writeFixture(p: string, contents: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, contents)
  }

  function pkg(name: string, deps: string[]): string {
    const depLines = deps.map((d) => `  ${d} = { path = "../${d}" }`).join('\n')
    return [
      '[package]',
      `name = "${name}"`,
      'version = "0.0.0"',
      'edition = "2021"',
      depLines.length > 0 ? `[dependencies]\n${depLines}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  beforeAll(() => {
    if (!fs.existsSync(realTsx)) throw new Error(`owning checkout tsx missing: ${realTsx}`)
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepush routing's-"))
    expect(fixtureRoot).toContain("prepush routing's-")
    const stubDir = path.join(fixtureRoot, 'node_modules/.bin')
    fs.mkdirSync(stubDir, { recursive: true })
    fs.writeFileSync(path.join(stubDir, 'tsx'), `#!/bin/sh\nexec "${realTsx}" "$@"\n`)
    fs.chmodSync(path.join(stubDir, 'tsx'), 0o755)
    fs.writeFileSync(path.join(stubDir, 'tsc'), '#!/usr/bin/env bash\nexit 0\n')
    fs.chmodSync(path.join(stubDir, 'tsc'), 0o755)
    git(['init', '-q', '-b', 'main'], { cwd: fixtureRoot })
    writeFixture(
      path.join(fixtureRoot, 'Cargo.toml'),
      [
        '[workspace]',
        'members = [',
        '  "crates/freshell-protocol",',
        '  "crates/freshell-ws",',
        '  "crates/freshell-freshagent",',
        '  "crates/freshell-server",',
        '  "crates/freshell-tauri",',
        ']',
        'resolver = "2"',
        '',
      ].join('\n'),
    )
    const fixtureDeps: Record<string, string[]> = {
      'freshell-protocol': [],
      'freshell-ws': ['freshell-protocol'],
      'freshell-freshagent': ['freshell-ws'],
      'freshell-server': ['freshell-ws', 'freshell-freshagent'],
      'freshell-tauri': ['freshell-server'],
    }
    for (const [name, deps] of Object.entries(fixtureDeps)) {
      writeFixture(path.join(fixtureRoot, `crates/${name}/Cargo.toml`), pkg(name, deps))
      writeFixture(path.join(fixtureRoot, `crates/${name}/src/lib.rs`), '')
    }
    const commit = (msg: string): string => {
      git(['add', '-A'], { cwd: fixtureRoot })
      git(
        ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg],
        { cwd: fixtureRoot },
      )
      return git(['rev-parse', 'HEAD'], { cwd: fixtureRoot })
    }
    baseSha = commit('base: fixture workspace')

    writeFixture(path.join(fixtureRoot, 'crates/freshell-ws/src/lib.rs'), '// ws change\n')
    rustSha = commit('rust: freshell-ws src change')

    writeFixture(path.join(fixtureRoot, 'README.md'), 'docs only\n')
    docsSha = commit('docs: readme')

    writeFixture(path.join(fixtureRoot, 'crates/freshell-tauri/src/main.rs'), 'fn main() {}\n')
    tauriSha = commit('rust: tauri-only change')

    writeFixture(
      path.join(fixtureRoot, 'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs'),
      '// fixture change\n',
    )
    fixtureSha = commit('test fixture change')

    writeFixture(path.join(fixtureRoot, '.cargo/config.toml'), '[build]\n')
    cargoConfigSha = commit('cargo config change')

    writeFixture(path.join(fixtureRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    pnpmLockSha = commit('pnpm lock change')

    writeFixture(path.join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
    pnpmWorkspaceSha = commit('pnpm workspace change')

    writeFixture(path.join(fixtureRoot, '.npmrc'), 'verify-deps-before-run=false\n')
    npmrcSha = commit('npmrc change')

    // The non-debug hook tests execute real dispatch with harmless recorders:
    // fake Cargo provides metadata and records its argv/environment, while the
    // fake sandbox executes the command produced by the real Rust runner.
    // Keep these helpers uncommitted so they cannot affect the range under test.
    writeFixture(path.join(fixtureRoot, 'package.json'), '{"type":"module"}\n')
    const tsxPackage = path.resolve(import.meta.dirname, '../../../node_modules/tsx')
    if (!fs.existsSync(tsxPackage)) throw new Error(`tsx package missing: ${tsxPackage}`)
    fs.symlinkSync(tsxPackage, path.join(fixtureRoot, 'node_modules/tsx'), 'dir')
    fs.mkdirSync(path.join(fixtureRoot, 'scripts/testing'), { recursive: true })
    fs.copyFileSync(
      path.resolve(import.meta.dirname, '../../../scripts/testing/run-rust-tests.ts'),
      path.join(fixtureRoot, 'scripts/testing/run-rust-tests.ts'),
    )

    fakeBinDir = path.join(fixtureRoot, 'fake-bin')
    fs.mkdirSync(fakeBinDir, { recursive: true })
    fakeCargoLog = path.join(fixtureRoot, 'fake-cargo.jsonl')
    fakePnpmLog = path.join(fixtureRoot, 'fake-pnpm.jsonl')
    fakeSandboxLog = path.join(fixtureRoot, 'fake-sandbox.jsonl')
    fakeCargoMetadata = path.join(fixtureRoot, 'fake-cargo-metadata.json')
    fakeSandboxRunner = path.join(fixtureRoot, 'fake-sandbox-runner.mjs')
    const manifestPath = (name: string) => path.join(fixtureRoot, `crates/${name}/Cargo.toml`)
    writeFixture(
      fakeCargoMetadata,
      JSON.stringify({
        workspace_members: Object.keys(fixtureDeps).map(manifestPath),
        packages: Object.entries(fixtureDeps).map(([name, deps]) => ({
          name,
          manifest_path: manifestPath(name),
          dependencies: deps.map((dependency) => ({ name: dependency })),
        })),
      }),
    )
    writeFixture(
      path.join(fakeBinDir, 'cargo'),
      [
        '#!/usr/bin/env node',
        'import fs from "node:fs"',
        'import { spawnSync } from "node:child_process"',
        'const args = process.argv.slice(2)',
        'const event = { args, buildJobs: process.env.CARGO_BUILD_JOBS ?? null, testThreads: process.env.RUST_TEST_THREADS ?? null, tokioThreads: process.env.TOKIO_WORKER_THREADS ?? null, sandboxActive: process.env.SANDBOX_ACTIVE ?? null, sandboxMode: process.env.FRESHELL_SANDBOX_MODE ?? null, sandboxOptIn: process.env.FRESHELL_RUST_TEST_SANDBOX ?? null }',
        'if (args[0] === "test") { const childEnv = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "0" }; const childGit = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), env: childEnv, encoding: "utf8" }); event.childGitStatus = childGit.status; event.childGitRoot = childGit.status === 0 ? childGit.stdout.trim() : null; event.childGitError = childGit.status === 0 ? null : childGit.stderr.trim(); event.gitConfigParameters = process.env.GIT_CONFIG_PARAMETERS ?? null; event.gitDirectory = process.env.GIT_DIR ?? null; event.gitWorkTree = process.env.GIT_WORK_TREE ?? null; event.gitIndexFile = process.env.GIT_INDEX_FILE ?? null; event.gitCommonDirectory = process.env.GIT_COMMON_DIR ?? null; event.gitPrefix = process.env.GIT_PREFIX ?? null; event.gitObjectDirectory = process.env.GIT_OBJECT_DIRECTORY ?? null; event.gitAlternateObjectDirectories = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? null }',
        'fs.appendFileSync(process.env.FAKE_CARGO_LOG, JSON.stringify(event) + "\\n")',
        'if (args[0] === "metadata") { process.stdout.write(fs.readFileSync(process.env.FAKE_CARGO_METADATA, "utf8")); process.exit(0) }',
        'if (args[0] === "test") process.exit(Number(process.env.FAKE_CARGO_TEST_EXIT ?? 0))',
      ].join('\n'),
    )
    fs.chmodSync(path.join(fakeBinDir, 'cargo'), 0o755)
    writeFixture(
      path.join(fakeBinDir, 'pnpm'),
      [
        '#!/usr/bin/env node',
        'import fs from "node:fs"',
        'fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), gitConfigParameters:process.env.GIT_CONFIG_PARAMETERS ?? null, gitDirectory:process.env.GIT_DIR ?? null}) + "\\n")',
        'process.exit(Number(process.env.FAKE_PNPM_EXIT ?? 0))',
      ].join('\n'),
    )
    fs.chmodSync(path.join(fakeBinDir, 'pnpm'), 0o755)
    writeFixture(
      fakeSandboxRunner,
      [
        'import fs from "node:fs"',
        'import path from "node:path"',
        'import { spawnSync } from "node:child_process"',
        'const args = process.argv.slice(2)',
        'fs.appendFileSync(process.env.FAKE_SANDBOX_LOG, JSON.stringify({args, ownerGuard:process.env.FRESHELL_SANDBOX_OWNER_GUARD ?? null}) + "\\n")',
        'if (Number(process.env.FAKE_SANDBOX_EXIT ?? 0) !== 0) process.exit(Number(process.env.FAKE_SANDBOX_EXIT))',
        'const fixtureRoot = process.cwd()',
        'const artifacts = path.join(fixtureRoot, ".sandbox-artifacts")',
        'fs.mkdirSync(artifacts, {recursive:true})',
        'const runner = path.join(fixtureRoot, "scripts/testing/run-rust-tests.ts")',
        String.raw`const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"`,
        'const command = args[1]',
        '  .replace("mktemp -d /freshell-test-artifacts/.freshell-rust-tests-XXXXXXXX", "mktemp -d " + shellQuote(path.join(artifacts, ".freshell-rust-tests-XXXXXXXX")))',
        '  .replace("mktemp -d /freshell-test-artifacts/XXX", "mktemp -d " + shellQuote(path.join(artifacts, "XXX")))',
        '  .replace("node --import tsx /workspace/scripts/testing/run-rust-tests.ts", "node --import tsx " + shellQuote(runner))',
        'const result = spawnSync("bash", ["-c", command], {cwd:fixtureRoot, env:{...process.env, SANDBOX_ACTIVE:"1", FRESHELL_SANDBOX_MODE:"runtime-suite"}, encoding:"utf8"})',
        'process.stdout.write(result.stdout ?? "")',
        'process.stderr.write(result.stderr ?? "")',
        'process.exit(result.status ?? 1)',
      ].join('\n'),
    )
    writeFixture(
      path.join(fixtureRoot, 'scripts/sandbox-test.sh'),
      '#!/usr/bin/env bash\nexec node "$FAKE_SANDBOX_RUNNER" "$@"\n',
    )
    fs.chmodSync(path.join(fixtureRoot, 'scripts/sandbox-test.sh'), 0o755)
  })

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })

  function runHook(
    localSha: string,
    remoteSha: string,
    extraEnv: Record<string, string> = {},
    debug = true,
  ): { status: number; stderr: string } {
    const res = spawnSync('bash', [hookPath], {
      input: `refs/heads/x ${localSha} refs/heads/x ${remoteSha}\n`,
      env: { ...process.env, ...extraEnv, FRESHELL_PREPUSH_DEBUG: debug ? '1' : '0' },
      encoding: 'utf8',
      cwd: fixtureRoot,
      // A hung hook (e.g. a stub exec-loop) blocks the event loop, so no
      // vitest timeout can fire — this spawn timeout is the ONLY guard.
      // Generous for real hook debug-mode runs; ETIMEDOUT surfaces below.
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
    let stderr = res.stderr ?? ''
    if (res.error) {
      const timedOut = res.error.code === 'ETIMEDOUT'
      stderr += `\nrunHook spawn failed: ${res.error.message}${
        timedOut ? ' — hook invocation timed out after 120s (hook or tsx stub hung?)' : ''
      }`
    }
    return { status: res.status ?? -1, stderr }
  }

  function runInstrumentedHook(
    localSha: string,
    remoteSha: string,
    extraEnv: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string; cargoEvents: Array<Record<string, unknown>>; sandboxEvents: Array<Record<string, unknown>> } {
    fs.writeFileSync(fakeCargoLog, '')
    fs.writeFileSync(fakeSandboxLog, '')
    const res = spawnSync('bash', [hookPath], {
      input: `refs/heads/x ${localSha} refs/heads/x ${remoteSha}\n`,
      env: (() => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...extraEnv,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          FAKE_CARGO_LOG: fakeCargoLog,
          FAKE_CARGO_METADATA: fakeCargoMetadata,
          FAKE_SANDBOX_LOG: fakeSandboxLog,
          FAKE_SANDBOX_RUNNER: fakeSandboxRunner,
          FRESHELL_PREPUSH_DEBUG: '0',
        }
        if (!Object.hasOwn(extraEnv, 'FRESHELL_RUST_TEST_SANDBOX')) delete env.FRESHELL_RUST_TEST_SANDBOX
        return env
      })(),
      encoding: 'utf8',
      cwd: fixtureRoot,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
    const events = (p: string): Array<Record<string, unknown>> =>
      fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    return {
      status: res.status ?? -1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      cargoEvents: events(fakeCargoLog),
      sandboxEvents: events(fakeSandboxLog),
    }
  }

  it('skips all checks for a docs-only range', () => {
    const out = runHook(docsSha, rustSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('full_gate=0 run_rust=0 run_ts=0 test_mode=skip')
  })

  it('plans targeted cargo tests for a changed crate plus its dependents', () => {
    const out = runHook(rustSha, baseSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=packages test_pkgs=freshell-freshagent freshell-server freshell-ws')
  })

  it('strips git hook env overrides (GIT_DIR et al) before any lane runs', () => {
    // git exports GIT_DIR/GIT_PREFIX into real pre-push invocations (the
    // pushing worktree's gitdir). Unstripped, a bogus or stale GIT_DIR breaks
    // the hook's own routing git calls — and in non-debug mode the leaked
    // vars redirect every test-side git child at the SHARED repository
    // (observed: cargo-test children re-initialized the main checkout's
    // config). The hook must drop them before cwd discovery and before any lane runs.
    const out = runHook(rustSha, baseSha, { GIT_DIR: '/nonexistent-prepush-hook-env' })
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('test_mode=packages test_pkgs=freshell-freshagent freshell-server freshell-ws')
  })

  it('keeps command-scoped worktree trust for hook Git queries and strips it before test children', () => {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepush remote's-"))
    try {
      const remote = path.join(remoteRoot, 'origin.git')
      const emptyHooks = path.join(remoteRoot, 'empty-hooks')
      const ownershipSeamHooks = path.join(remoteRoot, 'ownership-seam-hooks')
      fs.mkdirSync(emptyHooks)
      fs.mkdirSync(ownershipSeamHooks)
      git(['init', '--bare', '-q', remote], { cwd: fixtureRoot })
      git(['-c', `core.hooksPath=${emptyHooks}`, 'push', remote, `${baseSha}:refs/heads/main`], { cwd: fixtureRoot })
      git(['remote', 'add', 'origin', remote], { cwd: fixtureRoot })
      git(['update-ref', 'refs/remotes/origin/main', baseSha], { cwd: fixtureRoot })
      const hookWithOwnershipSeam = path.join(ownershipSeamHooks, 'pre-push')
      fs.writeFileSync(hookWithOwnershipSeam, '#!/usr/bin/env bash\nexport GIT_TEST_ASSUME_DIFFERENT_OWNER=1\nexec bash "$PREPUSH_REAL_HOOK" "$@"\n')
      fs.chmodSync(hookWithOwnershipSeam, 0o755)
      fs.writeFileSync(fakeCargoLog, '')
      fs.writeFileSync(fakePnpmLog, '')
      fs.writeFileSync(fakeSandboxLog, '')

      const pushThroughHook = (localSha: string, branch: string) => spawnSync('git', [
        '-c', `safe.directory=${fixtureRoot}`,
        '-c', `core.hooksPath=${ownershipSeamHooks}`,
        '-C', fixtureRoot,
        'push', 'origin', `${localSha}:refs/heads/${branch}`,
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          FAKE_CARGO_LOG: fakeCargoLog,
          FAKE_CARGO_METADATA: fakeCargoMetadata,
          FAKE_PNPM_LOG: fakePnpmLog,
          FAKE_SANDBOX_LOG: fakeSandboxLog,
          FAKE_SANDBOX_RUNNER: fakeSandboxRunner,
          PREPUSH_REAL_HOOK: hookPath,
          FRESHELL_PREPUSH_DEBUG: '0',
          FRESHELL_RUST_TEST_SANDBOX: '1',
        },
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 120_000,
        killSignal: 'SIGKILL',
      })
      const res = pushThroughHook(rustSha, 'prepush-trust-regression')
      const cargoEvents = fs.readFileSync(fakeCargoLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      const sandboxEvents = fs.readFileSync(fakeSandboxLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(res.status, res.stderr).toBe(0)
      expect(res.stderr).toContain('targeted cargo test --locked -p freshell-freshagent -p freshell-server -p freshell-ws')
      expect(sandboxEvents).toHaveLength(1)
      expect((sandboxEvents[0].args as string[])[0]).toBe('--runtime-suite')
      expect(cargoEvents.filter((event) => (event.args as string[])[0] === 'test')).toMatchObject([{
        args: ['test', '--locked', '-p', 'freshell-freshagent', '-p', 'freshell-server', '-p', 'freshell-ws'],
        childGitStatus: 0,
        childGitRoot: fixtureRoot,
        childGitError: null,
        gitConfigParameters: null,
        gitDirectory: null,
        gitWorkTree: null,
        gitIndexFile: null,
        gitCommonDirectory: null,
        gitPrefix: null,
        gitObjectDirectory: null,
        gitAlternateObjectDirectories: null,
      }])

      fs.writeFileSync(fakeCargoLog, '')
      fs.writeFileSync(fakePnpmLog, '')
      fs.writeFileSync(fakeSandboxLog, '')
      const typecheckPush = pushThroughHook(pnpmLockSha, 'prepush-typecheck-trust-regression')
      const pnpmEvents = fs.readFileSync(fakePnpmLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(typecheckPush.status, typecheckPush.stderr).toBe(0)
      expect(pnpmEvents).toMatchObject([{
        args: ['run', '--silent', 'typecheck'],
        cwd: fixtureRoot,
        gitConfigParameters: null,
        gitDirectory: null,
      }])
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true })
    }
  })

  it('skips the test lane for tauri-only changes (clippy parity)', () => {
    const out = runHook(tauriSha, docsSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=skip')
  })

  it('runs the workspace test lane for test-fixture changes', () => {
    const out = runHook(fixtureSha, tauriSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=workspace')
  })

  it('keeps direct Cargo execution when the sandbox opt-in is unset', () => {
    const out = runInstrumentedHook(rustSha, baseSha, {
      CARGO_BUILD_JOBS: '91',
      RUST_TEST_THREADS: '92',
      TOKIO_WORKER_THREADS: '93',
    })
    expect(out.status, out.stderr).toBe(0)
    expect(out.sandboxEvents).toEqual([])
    expect(out.cargoEvents.filter((event) => (event.args as string[])[0] === 'test')).toMatchObject([
      {
        args: ['test', '--locked', '-p', 'freshell-freshagent', '-p', 'freshell-server', '-p', 'freshell-ws'],
        buildJobs: '91',
        testThreads: '92',
        tokioThreads: '93',
        sandboxActive: null,
      },
    ])
  })

  it('dispatches the same selected package test through the sandbox with bounded runtime settings', () => {
    const out = runInstrumentedHook(rustSha, baseSha, {
      FRESHELL_RUST_TEST_SANDBOX: '1',
      CARGO_BUILD_JOBS: '91',
      RUST_TEST_THREADS: '92',
      TOKIO_WORKER_THREADS: '93',
    })
    expect(out.status, out.stderr).toBe(0)
    expect(out.sandboxEvents).toHaveLength(1)
    expect(out.sandboxEvents[0]).toMatchObject({
      args: ['--runtime-suite', expect.any(String)],
      ownerGuard: '1',
    })
    expect(
      out.cargoEvents
        .filter((event) => ['fmt', 'clippy'].includes((event.args as string[])[0]))
        .every((event) => event.sandboxActive === null),
    ).toBe(true)
    expect(out.cargoEvents.filter((event) => (event.args as string[])[0] === 'test')).toMatchObject([
      {
        args: ['test', '--locked', '-p', 'freshell-freshagent', '-p', 'freshell-server', '-p', 'freshell-ws'],
        buildJobs: '3',
        testThreads: '4',
        tokioThreads: '2',
        sandboxActive: '1',
        sandboxMode: 'runtime-suite',
        sandboxOptIn: '0',
      },
    ])
  })

  it('dispatches fixture changes as the exact workspace command through the sandbox', () => {
    const out = runInstrumentedHook(fixtureSha, tauriSha, { FRESHELL_RUST_TEST_SANDBOX: '1' })
    expect(out.status, out.stderr).toBe(0)
    expect(out.sandboxEvents).toHaveLength(1)
    expect(out.cargoEvents.filter((event) => (event.args as string[])[0] === 'test')).toMatchObject([
      {
        args: ['test', '--workspace', '--exclude', 'freshell-tauri', '--locked'],
        buildJobs: '3',
        testThreads: '4',
        tokioThreads: '2',
        sandboxActive: '1',
      },
    ])
  })

  it('does not start a sandbox for a selected skip plan', () => {
    const out = runInstrumentedHook(tauriSha, docsSha, { FRESHELL_RUST_TEST_SANDBOX: '1' })
    expect(out.status, out.stderr).toBe(0)
    expect(out.sandboxEvents).toEqual([])
    expect(out.cargoEvents.some((event) => (event.args as string[])[0] === 'test')).toBe(false)
  })

  it('fails the push when the sandbox wrapper fails without falling back to host Cargo', () => {
    const out = runInstrumentedHook(rustSha, baseSha, {
      FRESHELL_RUST_TEST_SANDBOX: '1',
      FAKE_SANDBOX_EXIT: '23',
    })
    expect(out.status).toBe(1)
    expect(out.sandboxEvents).toHaveLength(1)
    expect(out.cargoEvents.some((event) => (event.args as string[])[0] === 'test')).toBe(false)
    expect(out.stderr).toContain('pre-push: FAILED')
  })

  it('runs the rust gate for cargo-config changes', () => {
    const out = runHook(cargoConfigSha, fixtureSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=workspace')
  })

  it('runs the ts gate for pnpm lock changes', () => {
    const out = runHook(pnpmLockSha, cargoConfigSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=0 run_ts=1')
    expect(out.stderr).toContain('test_mode=skip')
  })

  it('runs the ts gate for pnpm workspace changes', () => {
    const out = runHook(pnpmWorkspaceSha, pnpmLockSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=0 run_ts=1')
    expect(out.stderr).toContain('test_mode=skip')
  })

  it('runs the ts gate for .npmrc changes', () => {
    const out = runHook(npmrcSha, pnpmWorkspaceSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=0 run_ts=1')
    expect(out.stderr).toContain('test_mode=skip')
  })

  it('runs the full gate when the merge base is unknown', () => {
    const out = runHook('0000000000000000000000000000000000000001', '0000000000000000000000000000000000000002')
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('full_gate=1 run_rust=1 run_ts=1')
    expect(out.stderr).toContain('test_mode=workspace')
  })
})
