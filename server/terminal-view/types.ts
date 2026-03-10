import type { TerminalDirectoryQuery } from '../../shared/read-models.js'

export type TerminalDirectoryItem = {
  terminalId: string
  title: string
  description?: string
  mode: 'shell' | 'claude' | 'codex'
  resumeSessionId?: string
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

export type TerminalViewService = {
  listTerminalDirectory: () => Promise<TerminalDirectoryItem[]>
  getTerminalDirectoryPage: (query: TerminalDirectoryQuery) => Promise<TerminalDirectoryPage>
  getViewportSnapshot: (input: { terminalId: string }) => Promise<TerminalViewportSnapshot | null>
}
