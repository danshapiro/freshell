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
  executable(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\nprintf "pnpm %s\\n" "$*" >> "$COMMAND_LOG"\n')
  executable(path.join(bin, 'cargo'), '#!/usr/bin/env bash\nprintf "cargo %s\\n" "$*" >> "$COMMAND_LOG"\nexit "${CARGO_EXIT:-0}"\n')
  executable(path.join(bin, 'ss'), '#!/usr/bin/env bash\nexit 0\n')
  executable(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n')
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

function run(fixture: LaunchFixture, args: string[], managedRuntime: boolean | null = false) {
  const buildInfo = fs.readFileSync(path.join(fixture.root, '.build-info'), 'utf8')
  const env = {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    FRESHELL_HOME: fixture.home,
    PORT: fixture.port,
    COMMAND_LOG: fixture.commandLog,
    FAKE_BUILD_INFO: buildInfo,
    ...(managedRuntime === null ? {} : { FRESHELL_MANAGED_RUNTIME_V1: managedRuntime ? '1' : '' }),
  }
  if (managedRuntime === null) delete env.FRESHELL_MANAGED_RUNTIME_V1
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

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fs.existsSync(pidFile(fixture))) run(fixture, ['--stop'])
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

describe('launch-rust managed runtime feature guard', () => {
  it('adds the managed runtime feature to the requested Rust build', () => {
    const fixture = createFixture('{"managedRuntimeV1":true}')

    const result = run(fixture, [], true)

    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('cargo build --release -p freshell-server --locked --features managed-runtime-v1')
  })

  it('launcher skip-build refuses a featureless binary', () => {
    const fixture = createFixture('{"managedRuntimeV1":false}')
    const started = run(fixture, ['--skip-build'])
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())

    const restarted = run(fixture, ['--skip-build', '--restart'], true)

    expect(restarted.status).not.toBe(0)
    expect(`${restarted.stdout}${restarted.stderr}`).toContain('managed-runtime-v1')
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('honors the managed runtime request in .env before rebuilding or stopping', () => {
    const fixture = createFixture('{"managedRuntimeV1":false}')
    const started = run(fixture, ['--skip-build'])
    expect(started.status, started.stdout + started.stderr).toBe(0)
    const pid = Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())
    fs.writeFileSync(path.join(fixture.root, '.env'), 'AUTH_TOKEN=fixture-token\nFRESHELL_MANAGED_RUNTIME_V1=1\n')

    const restarted = run(fixture, ['--restart'], null)

    expect(restarted.status).not.toBe(0)
    expect(`${restarted.stdout}${restarted.stderr}`).toContain('managed-runtime-v1')
    expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('--features managed-runtime-v1')
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(Number(fs.readFileSync(pidFile(fixture), 'utf8').trim())).toBe(pid)
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
