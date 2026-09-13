// Fixture for sanitize-test-env.test.ts. argv[2] = plain, clean, or config.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]
if (mode === 'clean') {
  const { stripAmbientEnvPoisons } = await import('../../../../config/vitest/sanitize-test-env.js')
  stripAmbientEnvPoisons(process.env)
} else if (mode === 'config') {
  const configPath = process.argv[3]
  if (!configPath) throw new Error('config mode requires an absolute config path')
  await import(pathToFileURL(configPath).href)
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
