import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'codex-launch-unit-'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
try {
  const packageRoot = path.join(root, 'package')
  const platformPackageRoot = path.join(packageRoot, 'node_modules/platform')
  const helperDirectory = path.join(root, 'helpers')
  for (const directory of [packageRoot, platformPackageRoot, helperDirectory]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.164.0', type: 'module' }))
  fs.writeFileSync(path.join(platformPackageRoot, 'package.json'), JSON.stringify({ version: '0.164.0-linux-x64' }))
  const marker = path.join(root, 'dispatched.json')
  const npmWrapper = path.join(packageRoot, 'entry.mjs')
  fs.writeFileSync(npmWrapper, `import fs from 'node:fs'; import assert from 'node:assert/strict';
    assert(process.env.PATH.startsWith(${JSON.stringify(helperDirectory + ':')}), 'verified helper must precede the ambient PATH');
    assert.equal(process.env.CODEX_MANAGED_PACKAGE_ROOT, ${JSON.stringify(packageRoot)});
    assert.equal(process.env.CODEX_MANAGED_BY_NPM, '1');
    assert.equal(process.env.CODEX_MANAGED_BY_BUN, undefined);
    assert.equal(process.env.npm_config_user_agent, undefined);
    assert.deepEqual(process.argv.slice(2), ['argument with spaces', '$'+'(literal)', 'line1\\nline2']);
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),path:process.env.PATH}));
  `, { mode: 0o755 })
  for (const name of ['native', 'bwrap']) fs.writeFileSync(path.join(platformPackageRoot, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.symlinkSync(path.join(platformPackageRoot, 'bwrap'), path.join(helperDirectory, 'bwrap'))
  const launchWrapper = path.join(root, 'launch.mjs')
  fs.copyFileSync('docker/runtime/codex-launch.mjs', launchWrapper)
  const identity = { version: '0.164.0', platform: process.platform, arch: process.arch, launchWrapper, nodeExecutable: process.execPath, npmWrapper, packageRoot, helperDirectory, layoutFile: path.join(root, 'layout.json'), executable: 'native', bwrap: 'bwrap', bwrapSha256: hash(path.join(platformPackageRoot, 'bwrap')), npmEntrypointSha256: hash(npmWrapper) }
  const layout = { ...identity, platformPackageRoot, nativeExecutable: path.join(platformPackageRoot, 'native'), bwrap: path.join(platformPackageRoot, 'bwrap') }
  fs.writeFileSync(identity.layoutFile, JSON.stringify(layout))
  fs.writeFileSync(path.join(root, 'codex-native-sandbox.json'), JSON.stringify({ native: identity }))
  const run = () => spawnSync(process.execPath, [launchWrapper, 'argument with spaces', '$(literal)', 'line1\nline2'], {
    env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_MANAGED_BY_BUN: '1', npm_config_user_agent: 'bun/fixture' }, encoding: 'utf8', timeout: 10_000,
  })
  const positive = run()
  assert.equal(positive.status, 0, positive.stderr)
  assert(fs.existsSync(marker), 'actual npm entrypoint fixture must execute')
  fs.unlinkSync(marker)
  fs.unlinkSync(path.join(helperDirectory, 'bwrap'))
  const missing = run()
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /owned bwrap helper is missing/)
  assert.equal(fs.existsSync(marker), false, 'missing helper must refuse before npm dispatch')
  console.log(JSON.stringify({ severity: 'info', event: 'codex_managed_launch_unit_passed', cases: 2 }))
} finally { fs.rmSync(root, { recursive: true, force: true }) }
