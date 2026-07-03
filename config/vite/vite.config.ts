import { defineConfig, loadEnv } from 'vite'
import type { HttpProxy } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { getNetworkHost } from '../../server/get-network-host.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')

/** Suppress ECONNREFUSED proxy errors during startup (server not ready yet). */
function silenceStartupErrors(proxy: HttpProxy.Server) {
  proxy.on('error', (err, _req, res) => {
    if ('code' in err && err.code === 'ECONNREFUSED' && 'writeHead' in res) {
      res.writeHead(503)
      res.end()
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
    plugins: [react()],
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
      outDir: 'dist/client',
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
