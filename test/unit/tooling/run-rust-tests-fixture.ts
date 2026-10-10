import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const tsx = require.resolve('tsx')
const launcher = path.resolve('scripts/testing/run-rust-tests.ts')

export function fixture() {
  const temporaryRoot = process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir()
  const root = mkdtempSync(path.join(temporaryRoot, 'rust-launcher-'))
  mkdirSync(path.join(root, 'scripts/testing'), { recursive: true })
  mkdirSync(path.join(root, 'target'))
  mkdirSync(path.join(root, 'bin'))
  const artifacts = mkdtempSync(path.join(temporaryRoot, 'rust-artifacts-'))
  copyFileSync(launcher, path.join(root, 'scripts/testing/run-rust-tests.ts'))
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
  const receipt = path.join(root, 'receipt.jsonl')
  const executable = (file: string, body: string) => {
    writeFileSync(`${file}.mjs`, body)
    const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
    writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(`${file}.mjs`)} "$@"\n`)
    chmodSync(file, 0o755)
  }
  executable(path.join(root, 'bin/cargo'), `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    if (args[0] === 'test' && process.env.RUNTIME_PROBE) {
      const cp = await import('node:child_process');
      const result = cp.spawnSync(process.env.RUNTIME_PROBE, {env:process.env, stdio:'inherit'});
      process.exit(result.status ?? 1);
    }
    if (args[0] === 'test' && process.env.COMMONJS_PROBE) {
      const cp = await import('node:child_process');
      const file = process.env.TMPDIR+'/fixture.js';
      fs.writeFileSync(file, "const fs = require('node:fs'); fs.writeFileSync(process.env.COMMONJS_PROBE, 'executed');");
      const result = cp.spawnSync(process.execPath, [file], {env:process.env, stdio:'inherit'});
      process.exit(result.status ?? 1);
    }
    fs.appendFileSync(process.env.RECEIPT, JSON.stringify({kind:'cargo', args,
      binary:process.env.FRESHELL_SERVER_BIN, route:process.env.FRESHELL_RUST_TEST_SANDBOX, jobs:process.env.CARGO_BUILD_JOBS,
      tmp:process.env.TMPDIR, executableTmp:process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR})+'\\n');
    if (args[0] === 'test' && process.env.HOLD_TEST) {
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.env.HOLD_TEST, JSON.stringify({pid:process.pid, tmp:process.env.TMPDIR}));
      setInterval(() => {}, 10000);
      await new Promise(() => {});
    }
    process.exit(Number(args[0]==='build' ? process.env.BUILD_EXIT || 0 : process.env.TEST_EXIT || 0));
  `)
  executable(path.join(root, 'scripts/sandbox-test.sh'), `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.RECEIPT, JSON.stringify({kind:'sandbox', args})+'\\n');
    if (process.env.SANDBOX_EXIT) process.exit(Number(process.env.SANDBOX_EXIT));
    const command = args[1]
      .replaceAll('/freshell-test-artifacts', ${JSON.stringify(artifacts)})
      .replace('mktemp -d /workspace/target/', 'mktemp -d ' + ${JSON.stringify(root)} + '/target/')
      .replace('node --import tsx /workspace/scripts/testing/run-rust-tests.ts', 'node --import tsx ' + ${JSON.stringify(root)} + '/scripts/testing/run-rust-tests.ts');
    const result = cp.spawnSync('bash', ['-c', command], {env:process.env, stdio:'inherit'});
    process.exit(result.status ?? 1);
  `)
  return {
    root, artifacts,
    run(env: NodeJS.ProcessEnv = {}, args: string[] = []) {
      const result = spawnSync(process.execPath, ['--import', tsx, path.join(root, 'scripts/testing/run-rust-tests.ts'), ...args], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RECEIPT: receipt,
          FRESHELL_RUST_TEST_SANDBOX: '0', FRESHELL_SERVER_BIN: '/host/stale-server', ...env },
        encoding: 'utf8', timeout: 15_000,
      })
      const events = existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
      return { ...result, events }
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); rmSync(artifacts, { recursive: true, force: true }) },
  }
}

