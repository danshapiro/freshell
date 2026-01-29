/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_CWD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
