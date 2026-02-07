/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_CWD?: string
  readonly VITE_PERF_LOGGING?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __PERF_LOGGING__: string
