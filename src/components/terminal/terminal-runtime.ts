import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
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
}

type CreateTerminalRuntimeParams = {
  terminal: Terminal
  enableWebgl: boolean
}

export function createTerminalRuntime({
  terminal,
  enableWebgl,
}: CreateTerminalRuntimeParams): TerminalRuntime {
  let attached = false
  let fitAddon: FitAddon | null = null
  let searchAddon: SearchAddon | null = null
  let webglAddon: WebglAddon | null = null
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

  const attachAddons = () => {
    if (attached) return
    attached = true

    fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)

    if (!enableWebgl) return
    try {
      webglAddon = new WebglAddon()
      terminal.loadAddon(webglAddon)
      isWebglActive = true
      webglLossDisposable = webglAddon.onContextLoss(() => {
        disableWebgl()
      })
    } catch {
      disableWebgl()
    }
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
      disableWebgl()
      fitAddon = null
      searchAddon = null
    },
    webglActive: () => isWebglActive,
  }
}
