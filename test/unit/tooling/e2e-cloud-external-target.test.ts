import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../..')
const targetUrl = 'https://synthetic-owned.trycloudflare.com'
const targetToken = 'synthetic token: quote " newline\nvalue'
const managedFixture = { candidateSha: 'a'.repeat(40), runId: '11111111-1111-4111-8111-111111111111',
  remoteWorkspacePath: '/tmp/synthetic/workspace', expectedNonce: 'synthetic-environment-nonce' }
const checkpointFixture = { candidateSha: 'a'.repeat(40), runId: managedFixture.runId,
  syntheticWorkspacePath: '/tmp/synthetic/workspace', linkedWorktreePath: '/tmp/synthetic/linked-worktree',
  syntheticHomePath: '/tmp/synthetic/home',
  nonGitWorkspacePath: '/tmp/synthetic/non-git', restrictedUid: 65534, expectedNonce: 'synthetic-checkpoint-nonce' }

async function dispatch(overrides: Record<string, string | undefined>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-external-dispatch-'))
  const callsFile = path.join(directory, 'calls.jsonl')
  const receivedFile = path.join(directory, 'received.yaml')
  const gcloud = path.join(directory, 'gcloud')
  await fs.writeFile(gcloud, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FRESHELL_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args.slice(0, 3).join(' ') === 'run jobs create') {
  const file = args.find(arg => arg.startsWith('--env-vars-file='))?.slice('--env-vars-file='.length);
  if (!file) process.exit(91);
  fs.copyFileSync(file, process.env.FRESHELL_TEST_RECEIVED);
  process.exit(19); // Stop before execution; every GCP command is this fake.
}
process.exit(0);
`)
  await fs.chmod(gcloud, 0o755)
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
    FRESHELL_E2E_BACKEND: 'cloud', FRESHELL_TEST_CALLS: callsFile, FRESHELL_TEST_RECEIVED: receivedFile,
    FRESHELL_E2E_TARGET_URL: targetUrl, FRESHELL_E2E_TARGET_TOKEN: targetToken,
    FRESHELL_E2E_TARGET_WS_URL: targetUrl.replace('https:', 'wss:') + '/ws',
    FRESHELL_E2E_TARGET_TIMEOUT_MS: '45000', FRESHELL_E2E_TARGET_HOME: '/PRIVATE_AMBIENT_HOME',
    UNRELATED_AMBIENT_SECRET: 'PRIVATE_AMBIENT_VALUE', FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'managed-environment',
    FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: JSON.stringify(managedFixture) } as NodeJS.ProcessEnv
  delete env.FRESHELL_CODE_CHECKPOINT_FIXTURE
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  try {
    const result = spawnSync('bash', [path.join(root, 'scripts/e2e-cloud.sh'), 'run', '--shards=1',
      '--account=synthetic-robot@example.invalid', '--project=chromium-external-target',
      env.FRESHELL_E2E_EXTERNAL_FIXTURE_KIND === 'code-checkpoint'
        ? 'test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts'
        : 'test/e2e-browser/specs/managed-provider-environment-external.spec.ts'],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
    const calls = (await fs.readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
    const received = await fs.readFile(receivedFile, 'utf8').catch(() => undefined)
    return { result, calls, received: received === undefined ? undefined : parse(received) as Record<string, string> }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

describe('closed Cloud external target handoff', () => {
  it.each([
    { FRESHELL_E2E_TARGET_TOKEN: undefined },
    { FRESHELL_E2E_TARGET_URL: undefined },
    { FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: undefined },
    { FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'unrecognized' },
    { FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: undefined },
    { FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: '{bad-json' },
    { FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: JSON.stringify({ ...managedFixture, candidateSha: 'unknown' }) },
    { FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: JSON.stringify({ ...managedFixture, remoteWorkspacePath: '../outside' }) },
    { FRESHELL_CODE_CHECKPOINT_FIXTURE: JSON.stringify(checkpointFixture) },
  ])('refuses an incomplete or mismatched external selection before identity and dispatch (%j)', async (overrides) => {
    const { result, calls, received } = await dispatch(overrides)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(calls.filter(args => args[0] !== 'info')).toEqual([])
    expect(received).toBeUndefined()
    expect(result.stdout + result.stderr).not.toContain(targetToken)
  })

  it.each(['managed-environment', 'code-checkpoint'] as const)(
    'dispatches only the paired %s fixture through the actual private env file', async (kind) => {
      const overrides = kind === 'managed-environment' ? {} : {
        FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: kind, FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: undefined,
        FRESHELL_CODE_CHECKPOINT_FIXTURE: JSON.stringify(checkpointFixture),
      }
      const { result, calls, received } = await dispatch(overrides)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(19)
      expect(calls.filter(args => args.slice(0, 3).join(' ') === 'run jobs create')).toHaveLength(1)
      expect(received).toMatchObject({ FRESHELL_E2E_TARGET_URL: targetUrl,
        FRESHELL_E2E_TARGET_TOKEN: targetToken, FRESHELL_E2E_TARGET_WS_URL: targetUrl.replace('https:', 'wss:') + '/ws',
        FRESHELL_E2E_TARGET_TIMEOUT_MS: '45000', FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: kind })
      const selected = kind === 'managed-environment' ? 'FRESHELL_MANAGED_ENVIRONMENT_FIXTURE' : 'FRESHELL_CODE_CHECKPOINT_FIXTURE'
      expect(JSON.parse(received![selected])).toEqual(kind === 'managed-environment' ? managedFixture : checkpointFixture)
      expect(received).not.toHaveProperty(kind === 'managed-environment' ? 'FRESHELL_CODE_CHECKPOINT_FIXTURE' : 'FRESHELL_MANAGED_ENVIRONMENT_FIXTURE')
      expect(received).not.toHaveProperty('FRESHELL_E2E_TARGET_HOME')
      expect(received).not.toHaveProperty('UNRELATED_AMBIENT_SECRET')
      expect(result.stdout + result.stderr).not.toContain(targetToken)
      expect(result.stdout + result.stderr).not.toContain('PRIVATE_AMBIENT_VALUE')
    },
  )
})
