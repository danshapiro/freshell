import type { TerminalMode } from '../terminal-registry.js'
import type { TerminalDirectoryQuery } from '../../shared/read-models.js'
import type { SessionLocator } from '../../shared/ws-protocol.js'

export type TerminalDirectoryItem = {
  terminalId: string
  title: string
  description?: string
  mode: TerminalMode
  sessionRef?: SessionLocator
  createdAt: number
  lastActivityAt: number
  status: 'running' | 'exited'
  hasClients: boolean
  cwd?: string
}

export type TerminalDirectoryPage = {
  items: TerminalDirectoryItem[]
  nextCursor: string | null
  revision: number
}

export type TerminalViewportRuntime = {
  title: string
  status: 'running' | 'detached' | 'exited'
  cwd?: string
  pid?: number
}

export type TerminalViewportSnapshot = {
  terminalId: string
  revision: number
  serialized: string
  cols: number
  rows: number
  tailSeq: number
  runtime: TerminalViewportRuntime
}

export type TerminalScrollbackItem = {
  line: number
  text: string
}

export type TerminalScrollbackPage = {
  items: TerminalScrollbackItem[]
  nextCursor: string | null
}

export type TerminalSearchMatch = {
  line: number
  column: number
  text: string
}

export type TerminalSearchPage = {
  matches: TerminalSearchMatch[]
  nextCursor: string | null
}

export type TerminalViewService = {
  listTerminalDirectory: () => Promise<TerminalDirectoryItem[]>
  getTerminalDirectoryPage: (query: TerminalDirectoryQuery & { signal?: AbortSignal }) => Promise<TerminalDirectoryPage>
  getViewportSnapshot: (input: { terminalId: string; signal?: AbortSignal }) => Promise<TerminalViewportSnapshot | null>
  getScrollbackPage: (input: { terminalId: string; cursor?: string; limit?: number; signal?: AbortSignal }) => Promise<TerminalScrollbackPage | null>
  searchTerminal: (input: { terminalId: string; query: string; cursor?: string; limit?: number; signal?: AbortSignal }) => Promise<TerminalSearchPage | null>
}
