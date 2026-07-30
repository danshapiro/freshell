import { defineConfig, loadEnv } from 'vite'
import type { HttpProxy } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getNetworkHost } from '../../server/get-network-host.js'
import {
  declarationDigest,
  parseContract,
  projectDeclaration,
} from '../../scripts/deployment-compatibility.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')
const compatibilityContractPath = path.join(projectRoot, 'config/deployment-compatibility.json')

function resolveClientOutDir(): string {
  const requested = process.env.FRESHELL_CLIENT_OUT_DIR
  if (requested === undefined) return path.join(projectRoot, 'dist/client')
  if (!path.isAbsolute(requested)) {
    throw new Error('FRESHELL_CLIENT_OUT_DIR must be an absolute path')
  }
  return requested
}

function deploymentCompatibilityArtifact() {
  const contract = parseContract(readFileSync(compatibilityContractPath, 'utf8'))
  const declaration = projectDeclaration(contract, 'client')
  return {
    schemaVersion: '1',
    declaration,
    declarationSha256: declarationDigest(declaration),
  }
}

/**
 * Transport-level proxy failures that mean "the backend is down or restarting":
 * refused (not yet listening), reset/pipe (killed mid-request), timeout/host
 * unreachable. Answer 503 so the client classifies them as a transient outage
 * (isTransientRequestFailure) instead of surfacing a 500 "server bug".
 */
const TRANSIENT_PROXY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
])

/** Suppress transport-level proxy errors while the backend is down/restarting. */
function silenceStartupErrors(proxy: HttpProxy.Server) {
  proxy.on('error', (err, _req, res) => {
    const code = 'code' in err ? String(err.code) : ''
    if (TRANSIENT_PROXY_ERROR_CODES.has(code) && 'writeHead' in res) {
      if (!res.headersSent) {
        res.writeHead(503)
        res.end()
      } else {
        // Headers (and possibly part of the body) already went out: ending
        // cleanly would make a truncated payload look like a successful
        // response. Destroy the connection so the client sees a transport
        // failure (NetworkError -> classified transient) instead.
        res.destroy()
      }
    }
  })
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '')
  const backendPort = process.env.PORT || env.PORT || '3001'
  const backendHost = process.env.VITE_BACKEND_HOST || process.env.BACKEND_HOST || env.VITE_BACKEND_HOST || env.BACKEND_HOST || '127.0.0.1'
  const backendUrl = `http://${backendHost}:${backendPort}`
  const vitePort = parseInt(process.env.VITE_PORT || env.VITE_PORT || '5173', 10)
  const allowedHosts = env.VITE_ALLOWED_HOSTS
    ? env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
    : undefined // Vite's default behavior (localhost + host value)

  return {
    root: projectRoot,
    plugins: [
      react(),
      {
        name: 'freshell-deployment-compatibility',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'deployment-compatibility.json',
            source: `${JSON.stringify(deploymentCompatibilityArtifact(), null, 2)}\n`,
          })
        },
      },
    ],
    define: {
      __PERF_LOGGING__: JSON.stringify(env.PERF_LOGGING || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(projectRoot, './src'),
        '@test': path.resolve(projectRoot, './test'),
        '@shared': path.resolve(projectRoot, './shared'),
      },
    },
    build: {
      outDir: resolveClientOutDir(),
      sourcemap: mode === 'development',
      chunkSizeWarningLimit: 1400,
    },
    server: {
      host: getNetworkHost(),
      allowedHosts,
      port: vitePort,
      watch: {
        ignored: ['**/.worktrees/**', '**/.claude/worktrees/**', '**/examples/demo-projects/**'],
      },
      proxy: {
        '/api': {
          target: backendUrl,
          xfwd: true,
          configure: silenceStartupErrors,
        },
        '/local-file': {
          target: backendUrl,
          xfwd: true,
          configure: silenceStartupErrors,
        },
        '/ws': {
          target: backendUrl,
          ws: true,
          changeOrigin: true,
          xfwd: true,
          configure: silenceStartupErrors,
        },
      },
    },
  }
})
