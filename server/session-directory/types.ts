import type {
  SessionDirectoryQuery as SharedSessionDirectoryQuery,
} from '../shared/read-models.js'

export type SessionDirectoryQuery = SharedSessionDirectoryQuery

export type SessionDirectoryItem = {
  sessionId: string
  provider: string
  projectPath: string
  title?: string
  summary?: string
  snippet?: string
  matchedIn?: 'title' | 'summary' | 'firstUserMessage'
  updatedAt: number
  createdAt?: number
  archived?: boolean
  cwd?: string
  sessionType?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
  firstUserMessage?: string
  isRunning: boolean
  runningTerminalId?: string
}

export type SessionDirectoryPage = {
  items: SessionDirectoryItem[]
  nextCursor: string | null
  revision: number
}
