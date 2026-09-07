import { describe, expect, it } from 'vitest'
import type { PaneContent } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { getPaneDisplayTitle, matchesDerivedPaneTitle } from '@/lib/pane-title'

const opencodeExtensions: ClientExtensionEntry[] = [{
  name: 'opencode',
  version: '1.0.0',
  label: 'OpenCode',
  description: '',
  category: 'cli',
  picker: { shortcut: 'O' },
  cli: {
    supportsModel: true,
    supportsPermissionMode: true,
    supportsResume: true,
    resumeCommandTemplate: ['opencode', '--session', '{{sessionId}}'],
  },
}]

const opencodeContent: PaneContent = {
  kind: 'terminal',
  mode: 'opencode',
  status: 'running',
  createRequestId: 'req-1',
}

const hostStatsContent: PaneContent = { kind: 'host-stats' }

describe('pane-title helpers', () => {
  it('matches extension-aware derived titles', () => {
    expect(matchesDerivedPaneTitle('OpenCode', opencodeContent, opencodeExtensions)).toBe(true)
  })

  it('matches legacy extension-blind derived titles when extensions are available', () => {
    expect(matchesDerivedPaneTitle('Opencode', opencodeContent, opencodeExtensions)).toBe(true)
  })

  it('does not treat runtime titles as derived defaults', () => {
    expect(matchesDerivedPaneTitle('Release prep', opencodeContent, opencodeExtensions)).toBe(false)
  })

  it('prefers the extension-aware label when the stored title is only a legacy default', () => {
    expect(getPaneDisplayTitle(opencodeContent, 'Opencode', opencodeExtensions)).toBe('OpenCode')
  })

  it('preserves explicit runtime titles', () => {
    expect(getPaneDisplayTitle(opencodeContent, 'Release prep', opencodeExtensions)).toBe('Release prep')
  })

  it('treats every host-stats stored title as derived (legacy, canonical, or user-renamed)', () => {
    // The host-stats pane is always named by the app: stored titles from
    // before the rename, the canonical name, and hypothetical user overrides
    // must all resolve to the derived title.
    expect(matchesDerivedPaneTitle('Host Stats', hostStatsContent)).toBe(true)
    expect(matchesDerivedPaneTitle('System Status', hostStatsContent)).toBe(true)
    expect(matchesDerivedPaneTitle('My meter', hostStatsContent)).toBe(true)
  })

  it('displays the canonical System Status name for host-stats panes regardless of stored title', () => {
    expect(getPaneDisplayTitle(hostStatsContent, undefined)).toBe('System Status')
    expect(getPaneDisplayTitle(hostStatsContent, 'Host Stats')).toBe('System Status')
    expect(getPaneDisplayTitle(hostStatsContent, 'My meter')).toBe('System Status')
  })
})
