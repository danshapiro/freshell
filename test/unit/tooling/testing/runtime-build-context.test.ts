import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import ignore from 'ignore'
import { afterEach, describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'

const root = path.resolve(__dirname, '../../../..')

describe.each(['.dockerignore', '.gcloudignore'])('%s keeps private runtime material out of uploaded build contexts', (filename) => {
  const policy = () => ignore().add(fs.readFileSync(path.join(root, filename), 'utf8'))

  it.each([
    '.runtime-evidence/commit/run/provider-native-state.json',
    '.runtime-evidence/commit/run/browser/trace.zip',
    '.runtime-build/run/private-provider-home/state.json',
    '.runtime-build/run/freshell-server-managed',
    '.env',
    '.env.production',
    '.env.local',
  ])('excludes %s', (artifact) => {
    expect(policy().ignores(artifact)).toBe(true)
  })

  it.each([
    'AGENTS.md', 'package.json', 'pnpm-lock.yaml',
    'scripts/testing/runtime-gate.ts',
    'crates/freshell-session-host/src/main.rs',
    'test/unit/tooling/testing/runtime-build-context.test.ts',
  ])('retains required source %s', (source) => {
    expect(policy().ignores(source)).toBe(false)
  })
})

describe('managed builders copy the actual Cargo target artifacts', () => {
  let directory: string | undefined
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  it.each(['absolute', 'relative', 'default', 'missing'] as const)('uses %s output without a stale default fallback', kind => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-build-target-'))
    const repo = path.join(directory, 'repo')
    fs.mkdirSync(repo)
    fs.mkdirSync(path.join(repo, 'docs/development'), { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/development/runtime-provider-capabilities.json'), 'utf8'))
    Object.assign(manifest.providers.find((row: { provider: string }) => row.provider === 'claude'),
      { certificationState: 'pending_live_provider_certification', managedEnabled: false })
    fs.writeFileSync(path.join(repo, 'docs/development/runtime-provider-capabilities.json'), JSON.stringify(manifest))
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: repo })
    const configured = kind === 'default' ? undefined
      : kind === 'relative' ? '../relative-target' : path.join(directory, 'absolute-target')
    for (const profile of ['debug', 'release']) {
      fs.mkdirSync(path.join(repo, 'target', profile), { recursive: true })
      for (const bin of ['freshell-supervisor', 'freshell-session-host', 'freshell-server']) {
        fs.writeFileSync(path.join(repo, 'target', profile, bin), `stale:${profile}:${bin}`)
      }
    }
    const home = path.join(directory, 'builder-home')
    const mise = path.join(home, '.local/bin/mise')
    fs.mkdirSync(path.dirname(mise), { recursive: true })
    fs.writeFileSync(mise, `#!${process.execPath}\n
        const fs = require('node:fs'); const path = require('node:path');
        const args = process.argv.slice(2);
        const target = path.resolve(process.cwd(), process.env.CARGO_TARGET_DIR || 'target');
        const profile = args.includes('--release') ? 'release' : 'debug';
        const bins = args.flatMap((arg, i) => arg === '-p' ? [args[i+1]] : []);
        fs.mkdirSync(path.join(target, profile), { recursive: true });
        if (${JSON.stringify(kind)} !== 'missing') for (const bin of bins) {
          fs.writeFileSync(path.join(target, profile, bin), 'current:' + profile + ':' + bin);
        }
      `, { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
    if (configured) env.CARGO_TARGET_DIR = configured
    else delete env.CARGO_TARGET_DIR
    const outcome = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import fs from 'node:fs';
      const { ManagedRuntimeOwner } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'scripts/testing/runtime-sandbox.ts')).href)});
      const rig = new ManagedRuntimeOwner(() => { throw new Error('web is unused'); },
        ${JSON.stringify(repo)}, 2, {}, {}, 'test', { enabledProviders: ['claude'] });
      fs.mkdirSync(rig.runtime.buildDir, { recursive: true });
      const errors = [];
      const filesystemFailures = [];
      for (const [receiver, method] of [[rig.runtime, 'buildBinaries'], [rig, 'buildManagedServer'], [rig, 'buildQualificationSupervisor']]) {
        try { receiver[method](); } catch (error) {
          errors.push({ method, code: error.code });
          filesystemFailures.push({ method, path: error.path, dest: error.dest, syscall: error.syscall });
        }
      }
      process.stdout.write(JSON.stringify({ errors, filesystemFailures, buildDir: rig.runtime.buildDir,
        testSupervisor: rig.runtime.testSupervisorBinary, testHost: rig.runtime.testHostBinary,
        releaseSupervisor: rig.runtime.releaseSupervisorBinary, releaseHost: rig.runtime.releaseHostBinary }));
    `], { cwd: root, env, encoding: 'utf8', timeout: 15_000 })) as {
      errors: { method: string; code: string }[]; buildDir: string
      filesystemFailures: { method: string; path: string; dest: string; syscall: string }[]
      testSupervisor: string; testHost: string; releaseSupervisor: string; releaseHost: string
    }
    if (kind === 'missing') {
      expect(outcome.errors).toEqual(['buildBinaries', 'buildManagedServer', 'buildQualificationSupervisor']
        .map(method => ({ method, code: 'ENOENT' })))
      expect(outcome.filesystemFailures).toEqual([
        ['buildBinaries', 'debug', 'freshell-supervisor', 'freshell-supervisor-test'],
        ['buildManagedServer', 'release', 'freshell-server', 'freshell-server-managed'],
        ['buildQualificationSupervisor', 'release', 'freshell-supervisor', 'freshell-supervisor-qualification'],
      ].map(([method, profile, source, target]) => ({
        method, syscall: 'copyfile', path: path.join(configured!, profile, source),
        dest: path.join(outcome.buildDir, target),
      })))
      expect(fs.readdirSync(outcome.buildDir)).toEqual([])
    } else {
      expect(outcome.errors).toEqual([])
      expect(fs.readFileSync(outcome.testSupervisor, 'utf8')).toBe('current:debug:freshell-supervisor')
      expect(fs.readFileSync(outcome.testHost, 'utf8')).toBe('current:debug:freshell-session-host')
      expect(fs.readFileSync(outcome.releaseSupervisor, 'utf8')).toBe('current:release:freshell-supervisor')
      expect(fs.readFileSync(outcome.releaseHost, 'utf8')).toBe('current:release:freshell-session-host')
      expect(fs.readFileSync(path.join(outcome.buildDir, 'freshell-server-managed'), 'utf8')).toBe('current:release:freshell-server')
      expect(fs.readFileSync(path.join(outcome.buildDir, 'freshell-supervisor-qualification'), 'utf8')).toBe('current:release:freshell-supervisor')
    }
    if (configured) for (const profile of ['debug', 'release']) {
      expect(fs.readFileSync(path.join(repo, 'target', profile, 'freshell-supervisor'), 'utf8'))
        .toBe(`stale:${profile}:freshell-supervisor`)
    }
  })

  it.each(['pending', 'promoted', 'not-ready', 'fixture', 'candidate'] as const)('dispatches %s builds from current requested capabilities', kind => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-build-policy-'))
    const repo = path.join(directory, 'repo')
    fs.mkdirSync(path.join(repo, 'docs/development'), { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/development/runtime-provider-capabilities.json'), 'utf8'))
    for (const row of manifest.providers) if (['claude', 'codex'].includes(row.provider)) {
      if (kind === 'promoted') Object.assign(row, { certificationState: 'certified', managedEnabled: true })
      if (kind === 'pending' || kind === 'not-ready') Object.assign(row,
        { certificationState: 'pending_live_provider_certification', managedEnabled: false })
      if (kind === 'not-ready') row.qualificationReady = false
    }
    fs.writeFileSync(path.join(repo, 'docs/development/runtime-provider-capabilities.json'), JSON.stringify(manifest))
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: repo })
    const home = path.join(directory, 'builder-home')
    const mise = path.join(home, '.local/bin/mise')
    fs.mkdirSync(path.dirname(mise), { recursive: true })
    fs.writeFileSync(mise, `#!${process.execPath}\n
      const fs = require('node:fs'); const path = require('node:path');
      const args = process.argv.slice(2);
      fs.appendFileSync('dispatch.jsonl', JSON.stringify(args) + '\\n');
      const bin = args[args.indexOf('-p') + 1];
      fs.mkdirSync('target/release', { recursive: true });
      fs.writeFileSync(path.join('target/release', bin), 'controlled-current-artifact');
    `, { mode: 0o755 })
    const env = { ...process.env, HOME: home }
    delete env.CARGO_TARGET_DIR
    const outcome = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { ManagedRuntimeOwner } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'scripts/testing/runtime-sandbox.ts')).href)});
      const rig = new ManagedRuntimeOwner(() => { throw new Error('web unused'); },
        ${JSON.stringify(repo)}, 2, {}, {}, ${JSON.stringify(kind === 'fixture' ? 'test' : 'release')},
        ${JSON.stringify(kind === 'fixture'
          ? { enabledProviders: [], freshAgentModes: ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'], fixtureFreshAgentModes: ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] }
          : { enabledProviders: ['claude', 'codex', 'opencode'] })});
      const fs = await import('node:fs'); fs.mkdirSync(rig.runtime.buildDir, { recursive: true });
      const supervisor = rig.buildQualificationSupervisor(); const server = rig.buildManagedServer();
      process.stdout.write(JSON.stringify({ supervisor: supervisor ?? null, server, environment: rig.qualificationEnvironment() }));
    `], { cwd: root, env, encoding: 'utf8', timeout: 15_000 }))
    const calls = fs.readFileSync(path.join(repo, 'dispatch.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const server = calls.find(args => args.includes('freshell-server'))!
    expect(server[server.indexOf('--features') + 1]).toBe(kind === 'fixture' ? 'managed-fresh-agent-fixtures'
      : kind === 'pending' ? 'managed-provider-qualification' : 'managed-runtime-v1')
    expect(calls.some(args => args.includes('freshell-supervisor'))).toBe(kind === 'pending')
    expect(outcome.supervisor !== null).toBe(kind === 'pending')
    expect(outcome.environment).toEqual(kind === 'pending' ? { FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'claude,codex' } : {})
    expect(fs.readFileSync(outcome.server, 'utf8')).toBe('controlled-current-artifact')
  })
})
