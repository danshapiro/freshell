import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const backendPort = env.PORT || '3001'
  const backendUrl = `http://localhost:${backendPort}`
  const vitePort = parseInt(env.VITE_PORT || '5173', 10)

  return {
    plugins: [react()],
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
        ignored: ['**/.worktrees/**'],
      },
      proxy: {
        '/api': backendUrl,
        '/local-file': backendUrl,
        '/ws': {
          target: backendUrl,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  }
})
