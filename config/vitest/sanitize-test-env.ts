// Shared ambient-env sanitizer, imported FIRST by every vitest config in this
// repo (side effect). Vitest hoists imports to the top of each config module
// and loads configs in the main process before worker pools spawn, so the
// deletion here reaches every test worker — and therefore every child process
// a test spawns (children inherit the worker's env). This mirrors the existing
// inline NODE_ENV-mutation precedent at the top of six of the configs.
//
// Why these vars:
//  - HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy: an ambient shell proxy makes
//    EVERY spawned Node child print
//      (node:NNN) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...
//    on stderr, which fails the suite's strict-empty-stderr assertions
//    (test/e2e/update-flow.test.ts, test/unit/lib/visible-first-audit-gate.test.ts).
//  - FRESHELL_BIND_HOST: same shell-env-leak class; an ambient 0.0.0.0 silently
//    flips test-spawned servers off loopback (this already burned
//    test/unit/vite-config.test.ts, which self-manages it in-test).
//
// Escape hatch: the opt-in real-provider contract tests
// (FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1, test/integration/real/) spawn real
// CLI binaries that reach the internet; on a host whose only egress is a proxy,
// stripping would break them, so the strip is skipped when that flag is set.

export const AMBIENT_ENV_POISONS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'FRESHELL_BIND_HOST',
] as const

const PROXY_POISONS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

export function stripAmbientEnvPoisons(env: NodeJS.ProcessEnv = process.env): string[] {
  // Escape hatch — proxy vars only, and only on EXACTLY '1' (the same gate
  // convention the real-provider contract tests themselves use; a stray '0'
  // must not silently keep proxies), because its purpose is proxy egress for
  // those spawned CLIs. FRESHELL_BIND_HOST is ALWAYS stripped regardless.
  const proxyEscape = env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
  const removed: string[] = []
  for (const key of PROXY_POISONS) {
    if (proxyEscape) break
    if (key in env) {
      delete env[key]
      removed.push(key)
    }
  }
  if ('FRESHELL_BIND_HOST' in env) {
    delete env.FRESHELL_BIND_HOST
    removed.push('FRESHELL_BIND_HOST')
  }
  return removed
}

stripAmbientEnvPoisons()
