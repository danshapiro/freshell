import { describe, it, expect } from 'vitest'
import { resolvePaneRepoCwd, pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
import type { PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

const NO_META: Record<string, TerminalMetaRecord> = {}

function terminalContent(overrides: Partial<Extract<PaneContent, { kind: 'terminal' }>> = {}): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'claude',
    ...overrides,
  } as PaneContent
}

describe('resolvePaneRepoCwd', () => {
  it('returns undefined for plain shell terminals', () => {
    expect(resolvePaneRepoCwd(terminalContent({ mode: 'shell', initialCwd: '/x' }), undefined, NO_META)).toBeUndefined()
  })

  it('uses initialCwd for coding-CLI terminals', () => {
    expect(resolvePaneRepoCwd(terminalContent({ initialCwd: '/home/u/proj' }), undefined, NO_META)).toBe('/home/u/proj')
  })

  it('prefers terminalMeta repoRoot over initialCwd (server enrichment)', () => {
    const meta: Record<string, TerminalMetaRecord> = {
      't1': { terminalId: 't1', updatedAt: 1, cwd: '/home/u/proj/sub', repoRoot: '/home/u/proj' },
    }
    expect(
      resolvePaneRepoCwd(terminalContent({ terminalId: 't1', initialCwd: '/home/u/proj/sub' }), undefined, meta),
    ).toBe('/home/u/proj')
  })

  it('falls back to the tab initialCwd', () => {
    const tab = { id: 'tab-1', initialCwd: '/from/tab' } as Tab
    expect(resolvePaneRepoCwd(terminalContent(), tab, NO_META)).toBe('/from/tab')
  })

  it('uses initialCwd for fresh-agent panes', () => {
    const content = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-2',
      status: 'running',
      initialCwd: '/home/u/agent-proj',
    } as unknown as PaneContent
    expect(resolvePaneRepoCwd(content, undefined, NO_META)).toBe('/home/u/agent-proj')
  })

  it('returns undefined for browser/editor/picker panes', () => {
    const browser = { kind: 'browser', url: 'https://x', createRequestId: 'r' } as unknown as PaneContent
    expect(resolvePaneRepoCwd(browser, undefined, NO_META)).toBeUndefined()
  })
})

describe('pathBasename', () => {
  it('handles trailing slashes and both separators', () => {
    expect(pathBasename('/home/u/proj')).toBe('proj')
    expect(pathBasename('/home/u/proj/')).toBe('proj')
    expect(pathBasename('C:\\code\\proj')).toBe('proj')
    expect(pathBasename('proj')).toBe('proj')
  })
})

describe('buildRepoIconUrl', () => {
  it('percent-encodes the cwd', () => {
    expect(buildRepoIconUrl('/home/u/my proj')).toBe('/api/repo-icon?cwd=%2Fhome%2Fu%2Fmy%20proj')
  })
})
