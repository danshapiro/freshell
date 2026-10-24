// @vitest-environment node

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function runCloudFixture(mode: 'progress' | 'volume' | 'failure') {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'freshell-cloud-output-'))
  const script = path.join(fixture, 'cloud.mjs')
  const release = path.join(fixture, 'release')
  writeFileSync(script, `#!${process.execPath}
import { existsSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
process.stderr.write('cloud diagnostic\\n');
if (mode === 'progress') {
  process.stdout.write('cloud progress\\n');
  const deadline = Date.now() + 4000;
  const timer = setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) {
      clearInterval(timer);
      process.stdout.write('cloud complete\\n');
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      process.exitCode = 17;
    }
  }, 10);
} else if (mode === 'volume') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
  process.stdout.write('\\ncloud complete\\n');
} else {
  process.exitCode = 7;
}
`, { mode: 0o755 })
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'scripts/run-standard-tests.ts',
    'test/unit/cloud-output-fixture.test.ts',
  ], {
    cwd: root,
    env: {
      ...process.env,
      FRESHELL_VITEST_BACKEND: 'cloud',
      FRESHELL_VITEST_CLOUD_SCRIPT: script,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.includes('cloud progress')) writeFileSync(release, '')
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { code, stdout, stderr }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

describe('standard runner cloud output', () => {
  it('streams progress while the cloud process is still running', async () => {
    const result = await runCloudFixture('progress')
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('cloud complete')
    expect(result.stderr).toContain('cloud diagnostic')
  }, 15_000)

  it('accepts a successful cloud run with more than the execFile buffer limit of output', async () => {
    const result = await runCloudFixture('volume')
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('x'.repeat(2 * 1024 * 1024))
    expect(result.stdout).toContain('cloud complete')
  }, 15_000)

  it('preserves the cloud diagnostic and reports its failing exit code', async () => {
    const result = await runCloudFixture('failure')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('cloud diagnostic')
    expect(result.stderr).toContain('Cloud Vitest phase exited with code 7')
  }, 15_000)
})
