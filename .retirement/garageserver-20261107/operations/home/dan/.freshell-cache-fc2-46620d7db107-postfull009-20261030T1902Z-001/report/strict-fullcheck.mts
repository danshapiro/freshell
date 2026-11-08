// Prepared for the coordinator. The bounded repair owner does not execute it.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { prepareRuntimeBuilds, runtimeBuildRecipesForFiles, RUNTIME_BUILD_MANIFEST_ENV } from '/home/dan/code/freshell/.worktrees/freshcodex-complete/scripts/testing/runtime-build-preflight.ts'

const root = '/home/dan/code/freshell/.worktrees/freshcodex-complete'
const hostCompiler = '/home/dan/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu/bin'
const reports = '/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports'
const shim = "/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/generic-cli"
const env = {
  ...process.env,
  PATH: `${shim}:${hostCompiler}:${process.env.PATH}`,
  CARGO: `${hostCompiler}/cargo`, RUSTC: `${hostCompiler}/rustc`, RUSTDOC: `${hostCompiler}/rustdoc`,
  RUSTUP_TOOLCHAIN: '1.96.0',
  FRESHELL_OWNED_COMPILER_ROUTE_CONFIG: "/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/route.json",
  FRESHELL_OWNED_COMPILER_ROUTE_EVENTS: `/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/fullgate-compiler-${randomUUID()}.jsonl`,
  GCLOUD_ROBOT_REQUIRE: '1', FRESHELL_RUST_TEST_SANDBOX: '1',
}
for (const binary of ['rustc', 'cargo', 'rustdoc']) {
  const compiler = spawnSync(`${hostCompiler}/${binary}`, ['--version'], { env, encoding: 'utf8' })
  process.stderr.write(`STRICT_COMPILER ${compiler.stdout}`)
  if (compiler.status !== 0 || !compiler.stdout.startsWith(`${binary} 1.96.0 `)) throw new Error('strict compiler unavailable')
}
const recipes = runtimeBuildRecipesForFiles(root, [
  `${root}/test/integration/server/provider-parity-contract.test.ts`,
], env)
const prepared = prepareRuntimeBuilds(root, recipes, {
  env, command: { program: `${hostCompiler}/cargo`, args: [] },
})
try {
  const result = spawnSync('pnpm', ['run', 'check'], {
    cwd: root, env: { ...env, [RUNTIME_BUILD_MANIFEST_ENV]: prepared.manifestPath }, stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  prepared.cleanup()
}
