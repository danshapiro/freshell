import { defineConfig, loadEnv } from 'vite'
import type { HttpProxy } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
  const env = loadEnv(mode, __dirname, '')
  const backendPort = env.PORT || '3001'
  const backendHost = env.VITE_BACKEND_HOST || env.BACKEND_HOST || '127.0.0.1'
  const backendUrl = `http://${backendHost}:${backendPort}`
  const vitePort = parseInt(env.VITE_PORT || '5173', 10)

  return {
    plugins: [react()],
    define: {
      __PERF_LOGGING__: JSON.stringify(env.PERF_LOGGING || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@test': path.resolve(__dirname, './test'),
      },
    },
    build: {
      outDir: 'dist/client',
      sourcemap: mode === 'development',
    },
    server: {
      host: true,
      port: vitePort,
      watch: {
        ignored: ['**/.worktrees/**', '**/demo-projects/**'],
      },
      proxy: {
        '/api': {
          target: backendUrl,
          configure: silenceStartupErrors,
        },
        '/local-file': {
          target: backendUrl,
          configure: silenceStartupErrors,
        },
        '/ws': {
          target: backendUrl,
          ws: true,
          changeOrigin: true,
          configure: silenceStartupErrors,
        },
      },
    },
  }
})
