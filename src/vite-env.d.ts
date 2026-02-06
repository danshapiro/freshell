/// <reference types="vite/client" />

// Vite-defined global build-time flags
declare const __PERF_LOGGING__: string | undefined

interface ImportMetaEnv {
  readonly VITE_DEFAULT_CWD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
