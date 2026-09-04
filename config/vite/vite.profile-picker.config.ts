import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

export default defineConfig({
  plugins: [react()],
  root: path.resolve(projectRoot, 'electron/profile-picker'),
  base: './',
  build: {
    outDir: path.resolve(projectRoot, 'dist/profile-picker'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5179,
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
