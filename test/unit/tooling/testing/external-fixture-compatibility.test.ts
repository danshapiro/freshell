import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import { validateExternalSelection } from '../../../../scripts/testing/e2e-external-target.js'
import { dispatchOwnedExternalBrowser, externalCloudMetadata } from '../../../../scripts/testing/runtime-external-browser.js'

const root = process.cwd()
const descriptor = {
  FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
  FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws',
  FRESHELL_E2E_TARGET_TOKEN: 'synthetic-private-owner-token',
  FRESHELL_RUNTIME_EXTERNAL_RUN_ID: '11111111-1111-4111-8111-111111111111',
  FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: 'a'.repeat(40),
}
const selection = {
  spec: 'test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts',
  grep: 'synthetic interrupted ordinary Stop preserves history$',
}
const selectors = ['--project=chromium-external-target', selection.spec, '--grep', selection.grep]
const environment = { ...descriptor, FRESHELL_E2E_BACKEND: 'cloud', FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1',
  FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec, FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep }

describe('external runtime fixture launcher compatibility', () => {
  it('admits the real owner dispatch and retains its closed Cloud environment through the launcher CLI', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'external-fixture-compatibility-'))
    const selected = { id: 'synthetic-stop', file: selection.spec, title: 'Phase 2 managed runtime continuity › synthetic interrupted ordinary Stop preserves history' }
    const cli = (operation: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath,
      [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/testing/e2e-external-target.ts'), operation, ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 15_000 })
    const owner = {
      start: vi.fn().mockResolvedValue(descriptor),
      list: vi.fn().mockResolvedValue([selected]),
      child: vi.fn(async (_command: string, args: string[], env: NodeJS.ProcessEnv) => {
        const validation = cli('validate', args.slice(2), env)
        expect(validation.error).toBeUndefined()
        expect(validation.status, validation.stderr).toBe(0)
        const published = cli('cloud-metadata', args.slice(2), env)
        expect(published.status, published.stderr).toBe(0)
        const metadata = parse(published.stdout) as Record<string, string>
        expect(metadata).toEqual(externalCloudMetadata(env))
        const file = path.join(directory, 'cloud-env.yaml')
        await fs.writeFile(file, published.stdout)
        const appended = cli('append-env', [file, ...args.slice(2)], env)
        expect(appended.status, appended.stderr).toBe(0)
        expect(parse(await fs.readFile(file, 'utf8'))).toEqual(metadata)
        expect(metadata).toMatchObject({ ...descriptor, FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec,
          FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep, FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1' })
        expect(metadata).not.toHaveProperty('DOCKER_HOST')
        expect(metadata).not.toHaveProperty('UNRELATED_SECRET')
        return { exitCode: 0, cases: [{ ...selected, status: 'passed' as const }] }
      }),
      finish: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
      abort: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
    }
    try {
      await expect(dispatchOwnedExternalBrowser(selection, {
        FRESHELL_E2E_BACKEND: 'cloud', FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1',
        DOCKER_HOST: 'unix:///synthetic-private/docker.sock', UNRELATED_SECRET: 'synthetic-private-secret',
      }, owner)).resolves.toMatchObject({ selected: 1, executed: 1, passed: 1 })
      expect(owner.finish).toHaveBeenCalledOnce()
      expect(owner.abort).not.toHaveBeenCalled()
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })

  it.each([
    ['missing run identity', { FRESHELL_RUNTIME_EXTERNAL_RUN_ID: undefined }, selectors],
    ['missing candidate', { FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: undefined }, selectors],
    ['mismatched transport', { FRESHELL_E2E_TARGET_WS_URL: 'wss://foreign.invalid/ws' }, selectors],
    ['missing opt-in', { FRESHELL_RUNTIME_SYNTHETIC_RESUME: undefined }, selectors],
    ['unknown spec', { FRESHELL_RUNTIME_EXTERNAL_SPEC: 'test/e2e-browser/specs/foreign.spec.ts' }, selectors],
    ['mixed fixture families', { FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'managed-environment', FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: '{}' }, selectors],
    ['wrong project', {}, ['--project=chromium', selection.spec, '--grep', selection.grep]],
    ['wrong spec', {}, ['--project=chromium-external-target', 'test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts', '--grep', selection.grep]],
    ['additional spec', {}, [...selectors, 'test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts']],
    ['additional positional selector', {}, [...selectors, 'runtime-tabs']],
    ['wrong grep', {}, ['--project=chromium-external-target', selection.spec, '--grep=unselected case']],
    ['missing grep', {}, ['--project=chromium-external-target', selection.spec]],
  ] as const)('rejects %s before external dispatch without exposing secrets', (_name, overrides, args) => {
    let failure: unknown
    try { validateExternalSelection([...args], { ...environment, ...overrides }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(descriptor.FRESHELL_E2E_TARGET_TOKEN)
  })
})
