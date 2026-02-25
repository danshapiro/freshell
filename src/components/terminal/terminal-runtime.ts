import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search'
import type { IDisposable, Terminal } from '@xterm/xterm'

export type SearchOptions = ISearchOptions
export type SearchResultChangeEvent = ISearchResultChangeEvent

export type TerminalRuntime = {
  attachAddons: () => void
  fit: () => void
  findNext: (term: string, opts?: SearchOptions) => boolean
  findPrevious: (term: string, opts?: SearchOptions) => boolean
  clearDecorations: () => void
  onDidChangeResults: (callback: (event: SearchResultChangeEvent) => void) => IDisposable
  dispose: () => void
  webglActive: () => boolean
  suspendWebgl?: () => boolean
  resumeWebgl?: () => void
}

type CreateTerminalRuntimeParams = {
  terminal: Terminal
  enableWebgl: boolean
}

let webglAddonModulePromise: Promise<typeof import('@xterm/addon-webgl')> | null = null

function loadWebglAddonModule() {
  if (!webglAddonModulePromise) {
    webglAddonModulePromise = import('@xterm/addon-webgl').catch((error) => {
      webglAddonModulePromise = null
      throw error
    })
  }
  return webglAddonModulePromise
}

export function createTerminalRuntime({
  terminal,
  enableWebgl,
}: CreateTerminalRuntimeParams): TerminalRuntime {
  let attached = false
  let disposed = false
  let fitAddon: FitAddon | null = null
  let searchAddon: SearchAddon | null = null
  let webglAddon: { dispose: () => void; onContextLoss: (handler: () => void) => IDisposable } | null = null
  let webglLossDisposable: IDisposable | null = null
  let isWebglActive = false

  const disableWebgl = () => {
    isWebglActive = false
    if (webglLossDisposable) {
      webglLossDisposable.dispose()
      webglLossDisposable = null
    }
    if (webglAddon) {
      try {
        webglAddon.dispose()
      } catch {
        // fallback is intentionally silent
      }
      webglAddon = null
    }
  }

  const enableWebglAddon = () => {
    if (!enableWebgl || disposed || webglAddon) return
    void loadWebglAddonModule()
      .then(({ WebglAddon }) => {
        if (disposed || webglAddon) return
        try {
          const addon = new WebglAddon()
          terminal.loadAddon(addon)
          if (disposed) {
            addon.dispose()
            return
          }
          webglAddon = addon
          isWebglActive = true
          webglLossDisposable = webglAddon.onContextLoss(() => {
            disableWebgl()
          })
        } catch {
          disableWebgl()
        }
      })
      .catch(() => {
        disableWebgl()
      })
  }

  const attachAddons = () => {
    if (attached || disposed) return
    attached = true

    fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)

    if (!enableWebgl) return
    enableWebglAddon()
  }

  return {
    attachAddons,
    fit: () => {
      fitAddon?.fit()
    },
    findNext: (term: string, opts?: SearchOptions) => {
      if (!searchAddon) return false
      return searchAddon.findNext(term, opts)
    },
    findPrevious: (term: string, opts?: SearchOptions) => {
      if (!searchAddon) return false
      return searchAddon.findPrevious(term, opts)
    },
    clearDecorations: () => {
      searchAddon?.clearDecorations()
    },
    onDidChangeResults: (callback: (event: SearchResultChangeEvent) => void) => {
      if (!searchAddon) return { dispose: () => {} }
      return searchAddon.onDidChangeResults(callback)
    },
    dispose: () => {
      disposed = true
      disableWebgl()
      fitAddon = null
      searchAddon = null
    },
    webglActive: () => isWebglActive,
    suspendWebgl: () => {
      if (!isWebglActive && !webglAddon) return false
      disableWebgl()
      return true
    },
    resumeWebgl: () => {
      if (disposed || !enableWebgl || webglAddon) return
      enableWebglAddon()
    },
  }
}
