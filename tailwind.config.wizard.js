import baseConfig from './tailwind.config.js'

/** @type {import('tailwindcss').Config} */
export default {
  ...baseConfig,
  content: ['./electron/setup-wizard/**/*.{ts,tsx,html}'],
}
