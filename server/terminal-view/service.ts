import type { TerminalDirectoryQuery } from '../../shared/read-models.js'
import { TerminalViewMirror } from './mirror.js'
import type {
  TerminalDirectoryItem,
  TerminalDirectoryPage,
  TerminalViewService,
  TerminalViewportRuntime,
} from './types.js'

const MAX_DIRECTORY_PAGE_ITEMS = 50

type CursorPayload = {
  lastActivityAt: number
  terminalId: string
}

type TerminalListRecord = TerminalDirectoryItem

type TerminalRecord = {
  terminalId: string
  title: string
  description?: string
  mode: 'shell' | 'claude' | 'codex'
  resumeSessionId?: string
  createdAt: number
  lastActivityAt: number
  status: 'running' | 'exited'
  cwd?: string
  cols: number
  rows: number
  clients: Set<unknown>
  pty?: { pid?: number }
  buffer: { snapshot: () => string }
}

type TerminalViewServiceDeps = {
  configStore: {
    snapshot: () => Promise<{
      terminalOverrides?: Record<string, {
        titleOverride?: string | null
        descriptionOverride?: string | null
        deleted?: boolean
      }>
    }>
  }
  registry: {
    list: () => TerminalListRecord[]
    get: (terminalId: string) => TerminalRecord | undefined
    on?: (event: string, listener: (...args: any[]) => void) => void
  }
}

function buildRuntime(record: TerminalRecord): TerminalViewportRuntime {
  return {
    title: record.title,
    status: record.status === 'exited'
      ? 'exited'
      : (record.clients.size > 0 ? 'running' : 'detached'),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    ...(typeof record.pty?.pid === 'number' ? { pid: record.pty.pid } : {}),
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (
      typeof parsed.lastActivityAt !== 'number' ||
      !Number.isFinite(parsed.lastActivityAt) ||
      typeof parsed.terminalId !== 'string' ||
      parsed.terminalId.length === 0
    ) {
      throw new Error('invalid')
    }
    return {
      lastActivityAt: parsed.lastActivityAt,
      terminalId: parsed.terminalId,
    }
  } catch {
    throw new Error('Invalid terminal-directory cursor')
  }
}

function compareTerminals(a: TerminalDirectoryItem, b: TerminalDirectoryItem): number {
  const activityDiff = b.lastActivityAt - a.lastActivityAt
  if (activityDiff !== 0) return activityDiff
  return b.terminalId.localeCompare(a.terminalId)
}

export function createTerminalViewService(deps: TerminalViewServiceDeps): TerminalViewService {
  const mirrors = new Map<string, TerminalViewMirror>()

  const ensureMirror = (record: TerminalRecord, options: { seedSnapshot?: boolean } = {}): TerminalViewMirror => {
    let mirror = mirrors.get(record.terminalId)
    if (!mirror) {
      mirror = new TerminalViewMirror({
        terminalId: record.terminalId,
        cols: record.cols,
        rows: record.rows,
        runtime: buildRuntime(record),
      })
      mirrors.set(record.terminalId, mirror)
    }

    if (options.seedSnapshot !== false) {
      mirror.seedSnapshot(record.buffer.snapshot())
    }
    mirror.setLayout({ cols: record.cols, rows: record.rows })
    mirror.setRuntime(buildRuntime(record))
    return mirror
  }

  deps.registry.on?.('terminal.output.raw', (event: { terminalId?: string; data?: string }) => {
    if (typeof event.terminalId !== 'string' || typeof event.data !== 'string') return
    const record = deps.registry.get(event.terminalId)
    if (!record) return
    ensureMirror(record, { seedSnapshot: false }).applyOutput(event.data)
  })

  deps.registry.on?.('terminal.exit', (event: { terminalId?: string }) => {
    if (typeof event.terminalId !== 'string') return
    const record = deps.registry.get(event.terminalId)
    if (!record) return
    ensureMirror(record).setRuntime(buildRuntime(record))
  })

  async function listTerminalDirectory(): Promise<TerminalDirectoryItem[]> {
    const config = await deps.configStore.snapshot()
    return deps.registry.list()
      .filter((terminal) => !config.terminalOverrides?.[terminal.terminalId]?.deleted)
      .map((terminal) => {
        const override = config.terminalOverrides?.[terminal.terminalId]
        return {
          ...terminal,
          title: override?.titleOverride || terminal.title,
          description: override?.descriptionOverride || terminal.description,
        }
      })
      .sort(compareTerminals)
  }

  return {
    listTerminalDirectory,

    async getTerminalDirectoryPage(query: TerminalDirectoryQuery): Promise<TerminalDirectoryPage> {
      const limit = Math.min(query.limit ?? MAX_DIRECTORY_PAGE_ITEMS, MAX_DIRECTORY_PAGE_ITEMS)
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      const items = await listTerminalDirectory()
      const revision = items.reduce((maxRevision, item) => Math.max(maxRevision, item.lastActivityAt), 0)

      const filtered = cursor
        ? items.filter((item) => (
          item.lastActivityAt < cursor.lastActivityAt ||
          (item.lastActivityAt === cursor.lastActivityAt && item.terminalId.localeCompare(cursor.terminalId) < 0)
        ))
        : items

      const pageItems = filtered.slice(0, limit)
      const tail = pageItems.at(-1)

      return {
        items: pageItems,
        nextCursor: filtered.length > limit && tail
          ? encodeCursor({ lastActivityAt: tail.lastActivityAt, terminalId: tail.terminalId })
          : null,
        revision,
      }
    },

    async getViewportSnapshot({ terminalId }) {
      const record = deps.registry.get(terminalId)
      if (!record) return null
      return ensureMirror(record).getViewportSnapshot()
    },
  }
}
