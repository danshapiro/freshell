// Fixture for sanitize-test-env.test.ts. `argv[2]` = 'plain' | 'clean'.
// In 'clean' mode it applies the shared sanitize to its OWN env — exactly what
// importing config/vitest/sanitize-test-env.ts at config load does. It then
// spawns an inner plain node child whose one fetch() forces undici's
// EnvHttpProxyAgent activation (the `[UNDICI-EHPA]` warning is emitted lazily
// at the first dispatch, not at process start) and reports the inner child's
// stderr verbatim on stdout as JSON.
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
if (mode === 'clean') {
  const { stripAmbientEnvPoisons } = await import('../../../../config/vitest/sanitize-test-env.js')
  stripAmbientEnvPoisons(process.env)
}

const inner = spawnSync(
  process.execPath,
  ['-e', "fetch('data:text/plain,hi').then(() => process.stdout.write('inner alive'))\n"],
  {
    encoding: 'utf8',
    // Pin the knobs ambient state cannot be trusted with: clear NODE_OPTIONS
    // (a --disable-warning=UNDICI-EHPA there would suppress the very warning
    // the control asserts) and explicitly enable env-proxy handling
    // (inert on Nodes that already default it on).
    env: { ...process.env, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '1' },
  },
)
const envReport: Record<string, string | undefined> = {}
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'FRESHELL_BIND_HOST']) {
  envReport[key] = process.env[key]
}
process.stdout.write(JSON.stringify({ innerStderr: inner.stderr ?? '', envReport }))
