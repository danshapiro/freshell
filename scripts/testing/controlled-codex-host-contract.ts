import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVitestCommand } from './coordinator-upstream.js'

const root = path.resolve(import.meta.dirname, '../..')
if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('The controlled Codex host contract requires the runtime-suite sandbox')
}

const artifactRoot = '/freshell-test-artifacts'
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((line) => line.split(' '))
const targetMount = mounts.find((fields) => fields[4] === '/workspace/target')
const artifactMount = mounts.find((fields) => fields[4] === artifactRoot)
if (!targetMount || !artifactMount || targetMount[2] !== artifactMount[2] || targetMount[3] !== artifactMount[3]) {
  throw new Error('controlled host artifacts must use the workspace target volume')
}
// The enclosing Rust sandbox command owns and cleans this short parent even
// when the contract process is interrupted.
const parent = process.env.TMPDIR && fs.realpathSync(process.env.TMPDIR)
if (!parent || path.dirname(parent) !== artifactRoot || fs.statSync(parent).dev !== fs.statSync(artifactRoot).dev) {
  throw new Error('controlled host contract requires an owned target-backed temporary parent')
}
const temporary = fs.mkdtempSync(path.join(parent, 'C'))
// This namespace is separate from the broad Rust lane and other runtime
// builders; Cargo owns its lock if two copies of this contract overlap.
const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: path.join(artifactRoot, 'controlled-codex-host-target'),
  TMPDIR: temporary, FRESHELL_TEST_EXECUTABLE_TMP_DIR: temporary, XDG_CACHE_HOME: path.join(temporary, 'cache'),
  XDG_DATA_HOME: path.join(temporary, 'data'), npm_config_cache: path.join(temporary, 'pnpm'), NODE_DISABLE_COMPILE_CACHE: '1' }

function testBinary(packageName: string, binary: string, features: string[] = []): string {
  const output = execFileSync('cargo', ['test', '--locked', '-p', packageName, '--bin', binary,
    ...features, '--no-run', '--message-format=json'], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
  const artifacts = output.trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.reason === 'compiler-artifact'
    && row.target?.name === binary && row.profile?.test === true && typeof row.executable === 'string')
  if (artifacts.length !== 1) throw new Error(`expected one ${binary} test executable, got ${artifacts.length}`)
  fs.accessSync(artifacts[0].executable, fs.constants.X_OK)
  return artifacts[0].executable
}

try {
  if (fs.statSync(temporary).dev !== fs.statSync(artifactRoot).dev) throw new Error('controlled host temporary directory left the target volume')
  for (const name of ['cache', 'data', 'pnpm']) fs.mkdirSync(path.join(temporary, name))
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'controlled_codex_host_paths',
    parent, temporary, device: fs.statSync(temporary).dev, targetMount: targetMount[3], artifactMount: artifactMount[3] })}\n`)
  const host = testBinary('freshell-session-host', 'freshell-session-host')
  const gateway = testBinary('freshell-server', 'freshell-server', ['--features', 'managed-runtime-v1'])
  const { FRESHELL_TEST_CONTROLLED_HOST: _hostFixture, ...controlEnv } = env
  const controlOutput = execFileSync(host, ['--exact', 'tests::send_rpc_preserves_refused_and_ambiguous_provider_outcomes',
    '--nocapture', '--test-threads=1'], { cwd: root, env: controlEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (!/test result: ok\. 1 passed;/.test(controlOutput)) throw new Error(`host provider control did not pass once:\n${controlOutput}`)
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'controlled_codex_host_provider_control_passed', tests: 1 })}\n`)
  const reportPath = path.join(temporary, 'vitest.json')
  const vitest = resolveVitestCommand(root)
  try {
    execFileSync(vitest.command, [...vitest.args, 'run', '--config', 'config/vitest/vitest.controlled-codex-host.config.ts', '--configLoader', 'runner',
      '--reporter=json', `--outputFile=${reportPath}`], {
      cwd: root, env: { ...env, FRESHELL_TEST_CONTROLLED_HOST_BINARY: host, FRESHELL_TEST_CONTROLLED_GATEWAY_BINARY: gateway },
      stdio: 'inherit',
    })
  } catch (error) {
    if (fs.existsSync(reportPath)) process.stderr.write(fs.readFileSync(reportPath, 'utf8'))
    throw error
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  if (report.numTotalTests !== 4 || report.numPassedTests !== 4 || report.numFailedTests !== 0 || report.numPendingTests !== 0) {
    throw new Error(`controlled client contract did not pass exactly four tests: ${JSON.stringify({
      total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests,
    })}`)
  }
  const identities = fs.readFileSync(path.join(temporary, 'request-identities.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  if (identities.length !== 2 || new Set(identities.map((row) => row.outcome)).size !== 2
    || identities.some((row) => !row.requestId || row.requestId !== row.responseRequestId || row.requestId === row.differentRequestId)) {
    throw new Error('controlled client request identity evidence is incomplete')
  }
  for (const identity of identities) process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'controlled_codex_host_request', ...identity })}\n`)
  const attaches = fs.readFileSync(path.join(temporary, 'attach-identities.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  if (attaches.length !== 2 || new Set(attaches.map((row) => row.publicId)).size !== 2
    || attaches.some((row) => row.publicId !== row.requestSessionId || row.frameCount < 5
      || row.firstType !== 'freshAgent.session.materialized')) {
    throw new Error('controlled unchanged attach evidence is incomplete')
  }
  for (const attach of attaches) process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'controlled_codex_host_attach', ...attach })}\n`)
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'controlled_codex_host_contract_passed', tests: report.numPassedTests })}\n`)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
