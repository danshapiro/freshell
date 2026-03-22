import { describe, it, expect } from 'vitest'
import type { PaneNode } from '@/store/paneTypes'
import {
  bootstrapLegacyTabTitleSource,
  inferLegacyPaneTitleSource,
  normalizeRuntimeTitle,
  resolveEffectiveLegacyTabTitleSource,
  shouldDecorateExitTitle,
  shouldReplaceDurableTitleSource,
} from '@/lib/title-source'

const singleShellPane: PaneNode = {
  type: 'leaf',
  id: 'pane-shell',
  content: {
    kind: 'terminal',
    createRequestId: 'req-shell',
    status: 'running',
    mode: 'shell',
    shell: 'system',
  },
}

const singleCodexPane: PaneNode = {
  type: 'leaf',
  id: 'pane-codex',
  content: {
    kind: 'terminal',
    createRequestId: 'req-codex',
    status: 'running',
    mode: 'codex',
    shell: 'system',
  },
}

describe('title-source helpers', () => {
  it('replaces durable titles when the next source has equal precedence', () => {
    expect(shouldReplaceDurableTitleSource('stable', 'stable')).toBe(true)
  })

  it('does not replace a stronger durable title with a weaker source', () => {
    expect(shouldReplaceDurableTitleSource('stable', 'derived')).toBe(false)
  })

  it('boots legacy user tab titles as user sources', () => {
    expect(bootstrapLegacyTabTitleSource({ titleSetByUser: true })).toBe('user')
  })

  it('boots placeholder legacy tab titles as derived sources', () => {
    expect(bootstrapLegacyTabTitleSource({ title: 'Tab 3', titleSetByUser: false })).toBe('derived')
  })

  it('does not guess a non-placeholder legacy tab title without layout context', () => {
    expect(
      bootstrapLegacyTabTitleSource({
        title: 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346',
        titleSetByUser: false,
      }),
    ).toBeUndefined()
  })

  it('resolves a legacy single-shell tab title as derived when it still matches the layout default', () => {
    expect(
      resolveEffectiveLegacyTabTitleSource({
        storedTitle: 'Shell',
        layout: singleShellPane,
        paneTitleSource: 'derived',
      }),
    ).toBe('derived')
  })

  it('resolves a legacy single-pane session title as stable when pane context proves it', () => {
    expect(
      resolveEffectiveLegacyTabTitleSource({
        storedTitle: 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346',
        layout: singleCodexPane,
        paneTitle: 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346',
        paneTitleSource: 'stable',
      }),
    ).toBe('stable')
  })

  it('infers a legacy pane title as derived when it still matches the derived pane title', () => {
    expect(
      inferLegacyPaneTitleSource({
        storedTitle: 'Shell',
        derivedTitle: 'Shell',
        titleSetByUser: false,
      }),
    ).toBe('derived')
  })

  it('infers a legacy pane title as stable when it no longer matches the derived pane title', () => {
    expect(
      inferLegacyPaneTitleSource({
        storedTitle: 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346',
        derivedTitle: 'Shell',
        titleSetByUser: false,
      }),
    ).toBe('stable')
  })

  it('normalizes runtime titles by stripping spinner prefixes', () => {
    expect(normalizeRuntimeTitle('⠋ codex')).toBe('codex')
  })

  it('decorates exit titles for derived titles only', () => {
    expect(shouldDecorateExitTitle('derived')).toBe(true)
    expect(shouldDecorateExitTitle('stable')).toBe(false)
  })
})
