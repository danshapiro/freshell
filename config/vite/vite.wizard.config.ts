import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

export default defineConfig({
  plugins: [react()],
  root: path.resolve(projectRoot, 'electron/setup-wizard'),
  base: './',  // relative paths for file:// protocol in production
  build: {
    outDir: path.resolve(projectRoot, 'dist/wizard'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,  // separate from main app's 5173
  },
  resolve: {
    alias: {
      '@electron': path.resolve(projectRoot, './electron'),
    },
  },
  css: {
    postcss: {
      plugins: [
        (await import('tailwindcss')).default({
          config: path.resolve(projectRoot, 'config/tailwind/tailwind.config.wizard.js'),
        }),
        (await import('autoprefixer')).default,
      ],
    },
  },
})
