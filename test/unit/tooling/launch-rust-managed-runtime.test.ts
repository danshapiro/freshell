// @vitest-environment node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..')

interface LaunchFixture {
  root: string
  home: string
  bin: string
  script: string
  commandLog: string
  port: string
}

const fixtures: LaunchFixture[] = []

function executable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o755 })
}

function createFixture(buildInfo = '{"managedRuntimeV1":false}'): LaunchFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-launch-rust-managed-runtime-'))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const scriptDirectory = path.join(root, 'scripts')
  const releaseDirectory = path.join(root, 'target', 'release')
  fs.mkdirSync(home)
  fs.mkdirSync(bin)
  fs.mkdirSync(scriptDirectory)
  fs.mkdirSync(releaseDirectory, { recursive: true })
  fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts/launch-rust.sh'), path.join(scriptDirectory, 'launch-rust.sh'))
  fs.writeFileSync(path.join(root, '.env'), 'AUTH_TOKEN=fixture-token\n')
  executable(path.join(releaseDirectory, 'freshell-server'), [
    '#!/usr/bin/env bash',
    'if [[ "${1:-}" == "--build-info" ]]; then',
    '  printf "%s\\n" "$FAKE_BUILD_INFO"',
    '  exit 0',
    'fi',
    'while true; do sleep 0.2; done',
    '',
  ].join('\n'))
  executable(path.join(releaseDirectory, 'freshell-supervisor-admin'), [
    '#!/usr/bin/env bash',
    'printf "admin %s\\n" "${!#}" >> "$COMMAND_LOG"',
    'if [[ "${!#}" == "health" ]]; then printf "%s\\n" "$FAKE_SUPERVISOR_HEALTH"; exit 0; fi',
    'exit 2',
    '',
  ].join('\n'))
  executable(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\nprintf "pnpm %s\\n" "$*" >> "$COMMAND_LOG"\n')
  executable(path.join(bin, 'cargo'), '#!/usr/bin/env bash\nprintf "cargo %s\\n" "$*" >> "$COMMAND_LOG"\nexit "${CARGO_EXIT:-0}"\n')
  executable(path.join(bin, 'ss'), '#!/usr/bin/env bash\nexit 0\n')
  executable(path.join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    */api/health) printf "curl /api/health\\n" >> "$COMMAND_LOG"; exit 0 ;;',
    '    */api/runtime/readiness)',
    '      config="$(cat)"; auth=no',
    '      expected_config="header = \\"x-auth-token: $FAKE_EXPECTED_AUTH_TOKEN\\""',
    '      [[ "$config" == "$expected_config" ]] && auth=yes',
    '      printf "curl /api/runtime/readiness auth=%s\\n" "$auth" >> "$COMMAND_LOG"',
    '      if [[ "$auth" == no ]]; then printf "\\n__FRESHELL_STATUS__401"; exit 0; fi',
    '      printf "%s" "$FAKE_READINESS_JSON"',
    '      printf "\\n__FRESHELL_STATUS__%s" "${FAKE_READINESS_STATUS:-200}"',
    '      exit "${FAKE_READINESS_EXIT:-0}" ;;',
    '  esac',
    'done',
    'exit 22',
    '',
  ].join('\n'))
  executable(path.join(bin, 'setsid'), '#!/usr/bin/env bash\nexec "$@"\n')
  const fixture: LaunchFixture = {
    root,
    home,
    bin,
    script: path.join(scriptDirectory, 'launch-rust.sh'),
    commandLog: path.join(root, 'commands.log'),
    port: String(40_000 + Math.floor(Math.random() * 20_000)),
  }
  fs.writeFileSync(fixture.commandLog, '')
  fs.writeFileSync(path.join(root, '.build-info'), buildInfo)
  fixtures.push(fixture)
  return fixture
}

function run(
  fixture: LaunchFixture,
  args: string[],
  managedRuntime: boolean | null = false,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const buildInfo = fs.readFileSync(path.join(fixture.root, '.build-info'), 'utf8')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    FRESHELL_HOME: fixture.home,
    PORT: fixture.port,
    COMMAND_LOG: fixture.commandLog,
    AUTH_TOKEN: 'fixture-token',
    FAKE_EXPECTED_AUTH_TOKEN: 'fixture-token',
    FAKE_BUILD_INFO: buildInfo,
    FAKE_SUPERVISOR_HEALTH: process.env.FAKE_SUPERVISOR_HEALTH
      ?? '{"state":"ok","installationId":"fixture-installation","controlEpoch":11}',
    FAKE_READINESS_JSON: process.env.FAKE_READINESS_JSON ?? JSON.stringify({
      installationId: 'fixture-installation',
      controlEpoch: 11,
      readiness: { initialScanState: 'complete', blockedSubsystems: [] },
      paneOwnership: {
        complete: true,
        readyToStop: true,
        panes: [],
        unattachedProcesses: [],
      },
    }),
    FAKE_READINESS_EXIT: process.env.FAKE_READINESS_EXIT ?? '0',
    FAKE_READINESS_STATUS: process.env.FAKE_READINESS_STATUS ?? '200',
    ...(managedRuntime === null ? {} : { FRESHELL_MANAGED_RUNTIME_V1: managedRuntime ? '1' : '' }),
    ...extraEnv,
  }
  if (managedRuntime === null) delete env.FRESHELL_MANAGED_RUNTIME_V1
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key]
  }
  return spawnSync('bash', [fixture.script, ...args], {
    cwd: fixture.root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function pidFile(fixture: LaunchFixture): string {
  return path.join(fixture.home, `rust-server-${fixture.port}.pid`)
}

function managedMarkerFile(fixture: LaunchFixture): string {
  return `${pidFile(fixture)}.managed`
}

function stopFixtureServer(fixture: LaunchFixture): void {
  const file = pidFile(fixture)
  if (!fs.existsSync(file)) return
  const pid = Number(fs.readFileSync(file, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid fixture server pid file: ${file}`)
  const procRoot = path.join('/proc', String(pid))
  if (!fs.existsSync(procRoot)) {
    fs.rmSync(file, { force: true })
    fs.rmSync(managedMarkerFile(fixture), { force: true })
    return
  }
  const expectedBinary = path.join(fixture.root, 'target/release/freshell-server')
  const cwd = fs.readlinkSync(path.join(procRoot, 'cwd'))
  const args = fs.readFileSync(path.join(procRoot, 'cmdline'), 'utf8').split('\0')
  if (cwd !== fixture.root || !args.includes(expectedBinary)) {
    throw new Error(`refusing to stop a process not owned by this launcher fixture (pid ${pid})`)
  }
  process.kill(pid, 'SIGTERM')
  const wait = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 100 && fs.existsSync(procRoot); attempt += 1) {
    Atomics.wait(wait, 0, 0, 50)
  }
  if (fs.existsSync(procRoot)) throw new Error(`fixture server pid ${pid} did not exit after SIGTERM`)
  fs.rmSync(file, { force: true })
  fs.rmSync(managedMarkerFile(fixture), { force: true })
}

function configureManagedEnvironment(fixture: LaunchFixture, authAssignment = 'AUTH_TOKEN=fixture-token'): void {
  const secretFile = path.join(fixture.home, 'control-secret')
  fs.writeFileSync(secretFile, 'fixture-secret\n', { mode: 0o600 })
  fs.writeFileSync(path.join(fixture.root, '.env'), [
    authAssignment,
    'FRESHELL_MANAGED_RUNTIME_V1=1',
    `FRESHELL_RUNTIME_CONTROL_SOCKET=${path.join(fixture.home, 'supervisor.sock')}`,
    `FRESHELL_RUNTIME_CONTROL_SECRET_FILE=${secretFile}`,
  ].join('\n') + '\n')
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    stopFixtureServer(fixture)
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

describe('launch-rust managed runtime feature guard', () => {
  it('adds the managed runtime feature to the requested Rust build', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)

    const result = run(fixture, [], true)

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('cargo build --release -p freshell-server --locked --features managed-runtime-v1')
  })

  it('refuses an inactive managed launch when skip-build selects a featureless binary', () => {
    const fixture = createFixture('{"managedRuntimeV1":false}')

    const started = run(fixture, ['--skip-build'], true)

    expect(started.status).not.toBe(0)
    expect(`${started.stdout}${started.stderr}`).toContain('managed-runtime-v1')
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
  })

  it('retains managed startup state after dotenv changes and probes an unmarked process', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)
    const started = run(fixture, ['--skip-build'], null)
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
    expect(fs.readFileSync(managedMarkerFile(fixture), 'utf8')).toMatch(new RegExp(`^managed-runtime-v1:${pid}:\\d+\\n$`))
    fs.writeFileSync(path.join(fixture.root, '.env'), 'AUTH_TOKEN=fixture-token\n')
    const commandsBefore = fs.readFileSync(fixture.commandLog, 'utf8')

    const restarted = run(fixture, ['--restart'], false)

    expect(restarted.status).not.toBe(0)
    expect(`${restarted.stdout}${restarted.stderr}`).toMatch(/managed[\s\S]*restart[\s\S]*update-managed-runtime/i)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toBe(commandsBefore)
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())).toBe(pid)

    const stopped = run(fixture, ['--stop'], false)
    expect(stopped.status).not.toBe(0)
    expect(`${stopped.stdout}${stopped.stderr}`).toMatch(/managed[\s\S]*stop[\s\S]*update-managed-runtime/i)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toBe(commandsBefore)
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())).toBe(pid)

    // Simulate a managed instance created before the startup marker existed.
    fs.rmSync(managedMarkerFile(fixture))
    const unmarkedStop = run(fixture, ['--stop'], null)
    expect(unmarkedStop.status).not.toBe(0)
    expect(`${unmarkedStop.stdout}${unmarkedStop.stderr}`).toMatch(/managed[\s\S]*stop[\s\S]*update-managed-runtime/i)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it.each(['--stop', '--restart'])('keeps an ordinary feature-enabled server usable with %s when readiness has no runtime client', (action) => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    const unavailableRuntime = {
      FAKE_READINESS_STATUS: '503',
      FAKE_READINESS_JSON: '{"error":"Managed runtime unavailable"}',
    }
    const started = run(fixture, ['--skip-build'], null, unavailableRuntime)
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())

    const result = run(fixture, [action, '--skip-build'], null, unavailableRuntime)

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    expect(() => process.kill(pid, 0)).toThrow()
    if (action === '--stop') {
      expect(fs.existsSync(pidFile(fixture))).toBe(false)
    } else {
      const replacementPid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
      expect(replacementPid).not.toBe(pid)
      expect(() => process.kill(replacementPid, 0)).not.toThrow()
    }
  })

  it('retains stop support for a server without the managed readiness route', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    const started = run(fixture, ['--skip-build'], null, { FAKE_READINESS_STATUS: '404' })
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())

    const stopped = run(fixture, ['--stop'], null, { FAKE_READINESS_STATUS: '404' })

    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0)
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it.each([
    ['401', '{"error":"Unauthorized"}'],
    ['403', '{"error":"Forbidden"}'],
    ['503', '{"error":"Supervisor unavailable"}'],
    ['503', '{"error":"Managed runtime unavailable","readiness":"failed"}'],
    ['503', 'not-json'],
  ])('preserves the running server when readiness returns an ambiguous %s response %s', (status, body) => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    const started = run(fixture, ['--skip-build'], null)
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())

    const stopped = run(fixture, ['--stop'], null, {
      FAKE_READINESS_STATUS: status,
      FAKE_READINESS_JSON: body,
    })

    expect(stopped.status).not.toBe(0)
    expect(stopped.stdout + stopped.stderr).toContain('Could not verify that the running server is outside managed runtime')
    expect(Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())).toBe(pid)
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('verifies authenticated readiness against the intended supervisor before saying ready', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)
    const readiness = JSON.stringify({
      installationId: 'different-supervisor',
      controlEpoch: 11,
      readiness: { initialScanState: 'complete', blockedSubsystems: [] },
      paneOwnership: { complete: true, panes: [], unattachedProcesses: [] },
    })

    const started = run(fixture, ['--skip-build'], null, { FAKE_READINESS_JSON: readiness })

    expect(started.status).not.toBe(0)
    expect(`${started.stdout}${started.stderr}`).toMatch(/runtime readiness.*supervisor/i)
    expect(`${started.stdout}${started.stderr}`).not.toContain('freshell-server is ready!')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('admin health')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    expect((fs.readFileSync(fixture.commandLog, 'utf8').match(/admin health/g) ?? [])).toHaveLength(3)
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
  })

  it.each([
    'AUTH_TOKEN="fixture-token" # token comment',
    "export AUTH_TOKEN='fixture-token' # token comment",
    'AUTH_TOKEN=fixture-token # token comment',
  ])('authenticates managed readiness using the parsed dotenv assignment %s', (assignment) => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture, assignment)

    const started = run(fixture, ['--skip-build'], null, { AUTH_TOKEN: undefined })

    expect(started.status, started.stdout + started.stderr).toBe(0)
    expect(started.stdout).toContain('freshell-server and managed runtime are ready')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it.each([
    'AUTH_TOKEN=fixture#token',
    'AUTH_TOKEN=fixture#token # token comment',
  ])('preserves an embedded hash in the unquoted dotenv token %s during managed startup', (assignment) => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture, assignment)

    const started = run(fixture, ['--skip-build'], null, {
      AUTH_TOKEN: undefined,
      FAKE_EXPECTED_AUTH_TOKEN: 'fixture#token',
    })

    expect(started.status, started.stdout + started.stderr).toBe(0)
    expect(started.stdout).toContain('freshell-server and managed runtime are ready')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('uses the process authentication token ahead of a different dotenv token', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture, 'AUTH_TOKEN="different-dotenv-token" # token comment')

    const started = run(fixture, ['--skip-build'], null)

    expect(started.status, started.stdout + started.stderr).toBe(0)
    expect(started.stdout).toContain('freshell-server and managed runtime are ready')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('rejects an explicitly empty process token instead of using the dotenv token', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)

    const started = run(fixture, ['--skip-build'], null, { AUTH_TOKEN: '' })

    expect(started.status).not.toBe(0)
    expect(started.stdout + started.stderr).toContain('AUTH_TOKEN not set')
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).not.toContain('curl ')
  })

  it('rejects an empty dotenv token followed by a comment before starting a server', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture, 'AUTH_TOKEN= # token comment')

    const started = run(fixture, ['--skip-build'], null, { AUTH_TOKEN: undefined })

    expect(started.status).not.toBe(0)
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).not.toContain('curl ')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).not.toContain('admin health')
  })

  it('preserves an unmarked managed server when the process authentication token is explicitly empty', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)
    const started = run(fixture, ['--skip-build'], null)
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
    fs.rmSync(managedMarkerFile(fixture))
    fs.writeFileSync(path.join(fixture.root, '.env'), 'AUTH_TOKEN=fixture-token\n')
    const commandsBefore = fs.readFileSync(fixture.commandLog, 'utf8')

    const stopped = run(fixture, ['--stop'], null, { AUTH_TOKEN: '' })

    expect(stopped.status).not.toBe(0)
    expect(stopped.stdout + stopped.stderr).toContain('Could not verify that the running server is outside managed runtime')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toBe(commandsBefore)
    expect(Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())).toBe(pid)
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('fails a managed launch when authenticated runtime readiness is unavailable', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)

    const started = run(fixture, ['--skip-build'], null, { FAKE_READINESS_STATUS: '404' })

    expect(started.status).not.toBe(0)
    expect(`${started.stdout}${started.stderr}`).toMatch(/authenticated runtime readiness http 404/i)
    expect(`${started.stdout}${started.stderr}`).toMatch(/newly launched web server will be stopped/i)
    expect(`${started.stdout}${started.stderr}`).not.toContain('freshell-server and managed runtime are ready')
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
    expect(fs.existsSync(managedMarkerFile(fixture))).toBe(false)
  })

  it('builds the supervisor admin client and reports census counts for a verified managed launch', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)
    const readiness = JSON.stringify({
      installationId: 'fixture-installation',
      controlEpoch: 11,
      readiness: { initialScanState: 'complete', blockedSubsystems: [] },
      paneOwnership: {
        complete: true,
        panes: [
          { ownership: 'durable', kind: 'fresh-agent' },
          { ownership: 'host-managed', kind: 'terminal' },
          { ownership: 'unknown', kind: 'terminal' },
        ],
        unattachedProcesses: [{ ownership: 'host-managed', kind: 'coding-agent' }],
      },
    })

    const started = run(fixture, [], null, { FAKE_READINESS_JSON: readiness })

    expect(started.status, started.stdout + started.stderr).toBe(0)
    expect(started.stdout).toMatch(/managed runtime are ready.*durable=1.*host-managed=1.*unknown=1.*unattached=1/i)
    expect(started.stdout).toMatch(/host-managed and unknown panes remain outside durable-soul protection and are left running/i)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('cargo build --release -p freshell-runtime-client --bin freshell-supervisor-admin --locked')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('curl /api/runtime/readiness auth=yes')
    expect((fs.readFileSync(fixture.commandLog, 'utf8').match(/admin health/g) ?? [])).toHaveLength(3)
  })

  it('honors the managed runtime request in .env when building an inactive launch', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')
    configureManagedEnvironment(fixture)

    const started = run(fixture, [], null)

    expect(started.status, started.stdout + started.stderr).toBe(0)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('--features managed-runtime-v1')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('cargo build --release -p freshell-runtime-client --bin freshell-supervisor-admin --locked')
  })

  it('lets an explicit empty process value override the .env request', () => {
    const fixture = createFixture('{"managedRuntimeV1":false}')
    fs.writeFileSync(path.join(fixture.root, '.env'), 'AUTH_TOKEN=fixture-token\nFRESHELL_MANAGED_RUNTIME_V1=1\n')

    const result = run(fixture, ['--skip-build'], false)

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.existsSync(pidFile(fixture))).toBe(true)
  })

  it('keeps featureless launches working when managed runtime is not requested', () => {
    const fixture = createFixture('{"managedRuntimeV1":false}')

    const result = run(fixture, ['--skip-build'])

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.existsSync(pidFile(fixture))).toBe(true)
  })

  it('client-only does not probe or start a server', () => {
    const fixture = createFixture('{"managedRuntimeV1":false}')

    const result = run(fixture, ['--client-only'], true)

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.existsSync(pidFile(fixture))).toBe(false)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).not.toContain('cargo build')
  })
})
