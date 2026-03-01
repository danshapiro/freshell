import { describe, it, expect, vi, beforeEach } from 'vitest'
import panesReducer, {
  initLayout,
  splitPane,
  swapPanes,
  addPane,
  closePane,
  setActivePane,
  resizePanes,
  resizeMultipleSplits,
  updatePaneContent,
  replacePane,
  removeLayout,
  hydratePanes,
  updatePaneTitle,
  updatePaneTitleByTerminalId,
  requestPaneRename,
  clearPaneRenameRequest,
  toggleZoom,
  PanesState,
} from '../../../../src/store/panesSlice'
import type { PaneNode, PaneContent, TerminalPaneContent, BrowserPaneContent, EditorPaneContent, ExtensionPaneContent } from '../../../../src/store/paneTypes'

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

// Mock nanoid to return predictable IDs for testing
let mockIdCounter = 0
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `pane-${++mockIdCounter}`),
}))

describe('panesSlice', () => {
  let initialState: PanesState

  beforeEach(() => {
    initialState = {
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
    }
    mockIdCounter = 0
    vi.clearAllMocks()
  })

  describe('initLayout', () => {
    it('creates a single-pane layout for a tab', () => {
      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      expect(state.layouts['tab-1']).toBeDefined()
      expect(state.layouts['tab-1'].type).toBe('leaf')
      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.kind).toBe('terminal')
      if (leaf.content.kind === 'terminal') {
        expect(leaf.content.mode).toBe('shell')
        expect(leaf.content.createRequestId).toBeDefined()
        expect(leaf.content.status).toBe('creating')
      }
      expect(leaf.id).toBeDefined()
    })

    it('sets the new pane as active', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(state.activePane['tab-1']).toBe(leaf.id)
    })

    it('uses the provided paneId when supplied', () => {
      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', paneId: 'pane-fixed', content: { kind: 'terminal', mode: 'shell' } })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.id).toBe('pane-fixed')
      expect(state.activePane['tab-1']).toBe('pane-fixed')
    })

    it('does not overwrite existing layout for a tab', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const originalLayout = state.layouts['tab-1']
      const originalActivePane = state.activePane['tab-1']

      state = panesReducer(
        state,
        initLayout({ tabId: 'tab-1', content: content2 })
      )

      expect(state.layouts['tab-1']).toBe(originalLayout)
      expect(state.activePane['tab-1']).toBe(originalActivePane)
    })

    it('creates layouts for different tabs independently', () => {
      const content1 = { kind: 'terminal' as const, mode: 'shell' as const }
      const content2: PaneContent = { kind: 'browser', url: 'https://example.com', devToolsOpen: false }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      state = panesReducer(
        state,
        initLayout({ tabId: 'tab-2', content: content2 })
      )

      expect(state.layouts['tab-1']).toBeDefined()
      expect(state.layouts['tab-2']).toBeDefined()
      const leaf1 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      const leaf2 = state.layouts['tab-2'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf1.content.kind).toBe('terminal')
      expect(leaf2.content).toEqual(content2)
    })

    it('generates createRequestId and status for terminal content', () => {
      // Initialize with minimal terminal input
      const state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', mode: 'shell' },
        })
      )

      const layout = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>

      expect(layout.content.kind).toBe('terminal')
      if (layout.content.kind === 'terminal') {
        expect(layout.content.createRequestId).toBeDefined()
        expect(layout.content.createRequestId.length).toBeGreaterThan(0)
        expect(layout.content.status).toBe('creating')
        expect(layout.content.shell).toBe('system')
      }
    })

    it('preserves provided createRequestId and status', () => {
      const state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', createRequestId: 'custom-req', status: 'running', mode: 'claude' },
        })
      )

      const layout = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>

      if (layout.content.kind === 'terminal') {
        expect(layout.content.createRequestId).toBe('custom-req')
        expect(layout.content.status).toBe('running')
        expect(layout.content.mode).toBe('claude')
      }
    })

    it('does not auto-assign resumeSessionId for claude panes', () => {
      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'claude' } })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      if (leaf.content.kind === 'terminal') {
        expect(leaf.content.resumeSessionId).toBeUndefined()
      }
    })

    it('preserves existing resumeSessionId for claude panes', () => {
      const state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', mode: 'claude', resumeSessionId: VALID_CLAUDE_SESSION_ID },
        })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      if (leaf.content.kind === 'terminal') {
        expect(leaf.content.resumeSessionId).toBe(VALID_CLAUDE_SESSION_ID)
      }
    })

    it('does not assign resumeSessionId for shell panes', () => {
      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      if (leaf.content.kind === 'terminal') {
        expect(leaf.content.resumeSessionId).toBeUndefined()
      }
    })

    it('drops invalid resumeSessionId for claude panes', () => {
      const state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', mode: 'claude', resumeSessionId: 'not-a-uuid' },
        })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      if (leaf.content.kind === 'terminal') {
        expect(leaf.content.resumeSessionId).toBeUndefined()
      }
    })
  })

  describe('splitPane', () => {
    it('converts a leaf pane into a horizontal split with two children', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newContent: { kind: 'terminal', mode: 'claude' },
        })
      )

      const root = state.layouts['tab-1']
      expect(root.type).toBe('split')
      const split = root as Extract<PaneNode, { type: 'split' }>
      expect(split.direction).toBe('horizontal')
      expect(split.children).toHaveLength(2)
      expect(split.sizes).toEqual([50, 50])

      const [first, second] = split.children
      expect(first.type).toBe('leaf')
      expect(second.type).toBe('leaf')
      const firstContent = (first as Extract<PaneNode, { type: 'leaf' }>).content
      const secondContent = (second as Extract<PaneNode, { type: 'leaf' }>).content
      expect(firstContent.kind).toBe('terminal')
      expect(secondContent.kind).toBe('terminal')
      if (firstContent.kind === 'terminal') {
        expect(firstContent.mode).toBe('shell')
      }
      if (secondContent.kind === 'terminal') {
        expect(secondContent.mode).toBe('claude')
      }
    })

    it('uses the provided newPaneId when supplied', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newPaneId: 'pane-fixed',
          newContent: { kind: 'terminal', mode: 'claude' },
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const claudeLeaf = split.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(claudeLeaf.id).toBe('pane-fixed')
      expect(state.activePane['tab-1']).toBe('pane-fixed')
      if (claudeLeaf.content.kind === 'terminal') {
        expect(claudeLeaf.content.resumeSessionId).toBeUndefined()
      }
    })

    it('converts a leaf pane into a vertical split', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'browser', url: 'https://test.com', devToolsOpen: true }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'vertical',
          newContent: content2,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(split.direction).toBe('vertical')
    })

    it('sets the new pane as active', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const newPane = split.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(state.activePane['tab-1']).toBe(newPane.id)
    })

    it('handles nested splits correctly', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }
      const content3: PaneContent = { kind: 'terminal', mode: 'codex' }

      // Create initial layout
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      // First split: horizontal
      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      // Get the second pane ID from the split
      const split1 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane2Id = (split1.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      // Second split: vertical on the second pane
      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane2Id,
          direction: 'vertical',
          newContent: content3,
        })
      )

      // Check the nested structure
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(root.type).toBe('split')
      expect(root.direction).toBe('horizontal')

      const [left, right] = root.children
      expect(left.type).toBe('leaf')
      expect(right.type).toBe('split')

      const nestedSplit = right as Extract<PaneNode, { type: 'split' }>
      expect(nestedSplit.direction).toBe('vertical')
      expect(nestedSplit.children[0].type).toBe('leaf')
      expect(nestedSplit.children[1].type).toBe('leaf')
    })

    it('preserves the original pane ID after split', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const firstPane = split.children[0] as Extract<PaneNode, { type: 'leaf' }>
      expect(firstPane.id).toBe(originalPaneId)
    })

    it('does nothing if tab layout does not exist', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      const state = panesReducer(
        initialState,
        splitPane({
          tabId: 'non-existent-tab',
          paneId: 'some-pane',
          direction: 'horizontal',
          newContent: content,
        })
      )

      expect(state.layouts['non-existent-tab']).toBeUndefined()
    })

    it('does nothing if pane ID is not found', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const originalLayout = state.layouts['tab-1']

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: 'non-existent-pane',
          direction: 'horizontal',
          newContent: content2,
        })
      )

      // Layout should be unchanged
      expect(state.layouts['tab-1']).toEqual(originalLayout)
    })

    it('generates createRequestId for new terminal panes', () => {
      // Initialize with terminal content (full form)
      let state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', createRequestId: 'orig-req', status: 'running', mode: 'shell' }
        })
      )

      const layoutBefore = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>

      // Split with partial terminal content (no createRequestId/status)
      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: layoutBefore.id,
          direction: 'horizontal',
          newContent: { kind: 'terminal', mode: 'shell' },
        })
      )

      const layout = state.layouts['tab-1']
      expect(layout.type).toBe('split')

      const split = layout as Extract<PaneNode, { type: 'split' }>
      const newPane = split.children[1] as Extract<PaneNode, { type: 'leaf' }>

      expect(newPane.content.kind).toBe('terminal')
      if (newPane.content.kind === 'terminal') {
        expect(newPane.content.createRequestId).toBeDefined()
        expect(newPane.content.createRequestId).not.toBe('orig-req')
        expect(newPane.content.status).toBe('creating')
        expect(newPane.content.shell).toBe('system') // Default applied
      }
    })

    it('preserves browser content unchanged in splitPane', () => {
      let state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' }
        })
      )

      const layoutBefore = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>

      // Split with browser content
      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: layoutBefore.id,
          direction: 'horizontal',
          newContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: true },
        })
      )

      const layout = state.layouts['tab-1']
      const split = layout as Extract<PaneNode, { type: 'split' }>
      const newPane = split.children[1] as Extract<PaneNode, { type: 'leaf' }>

      expect(newPane.content.kind).toBe('browser')
      if (newPane.content.kind === 'browser') {
        expect(newPane.content.url).toBe('https://example.com')
        expect(newPane.content.devToolsOpen).toBe(true)
      }
    })
  })

  describe('swapPanes', () => {
    it('swaps pane content by pane id', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: false },
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const left = split.children[0] as Extract<PaneNode, { type: 'leaf' }>
      const right = split.children[1] as Extract<PaneNode, { type: 'leaf' }>

      expect(left.content.kind).toBe('terminal')
      expect(right.content.kind).toBe('browser')

      state = panesReducer(
        state,
        swapPanes({ tabId: 'tab-1', paneId: left.id, otherId: right.id })
      )

      const swapped = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const swappedLeft = swapped.children[0] as Extract<PaneNode, { type: 'leaf' }>
      const swappedRight = swapped.children[1] as Extract<PaneNode, { type: 'leaf' }>

      expect(swappedLeft.content.kind).toBe('browser')
      expect(swappedRight.content.kind).toBe('terminal')
    })
  })

  describe('closePane', () => {
    // Helpers for constructing pane trees directly
    function terminalContent(createRequestId: string): PaneContent {
      return { kind: 'terminal', createRequestId, status: 'running', mode: 'shell' }
    }

    function makeClosePaneState(
      layouts: Record<string, PaneNode>,
      activePane: Record<string, string>
    ): PanesState {
      return {
        layouts,
        activePane,
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }
    }

    it('does nothing when there is only one pane', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )
      const paneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id
      const originalLayout = state.layouts['tab-1']

      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId }))

      expect(state.layouts['tab-1']).toEqual(originalLayout)
    })

    it('collapses a split to the remaining pane when one child is closed', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: { kind: 'terminal', mode: 'claude' },
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane2Id = (split.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      // Close the second pane
      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId: pane2Id }))

      // Should collapse back to a single leaf
      const remaining = state.layouts['tab-1']
      expect(remaining.type).toBe('leaf')
      expect((remaining as Extract<PaneNode, { type: 'leaf' }>).id).toBe(pane1Id)
      const remainingContent = (remaining as Extract<PaneNode, { type: 'leaf' }>).content
      expect(remainingContent.kind).toBe('terminal')
      if (remainingContent.kind === 'terminal') {
        expect(remainingContent.mode).toBe('shell')
      }
    })

    it('collapses to the other pane when the first child is closed', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: { kind: 'terminal', mode: 'claude' },
        })
      )

      // Close the first pane
      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId: pane1Id }))

      // Should collapse to the second pane
      const remaining = state.layouts['tab-1']
      expect(remaining.type).toBe('leaf')
      const remainingContent = (remaining as Extract<PaneNode, { type: 'leaf' }>).content
      expect(remainingContent.kind).toBe('terminal')
      if (remainingContent.kind === 'terminal') {
        expect(remainingContent.mode).toBe('claude')
      }
    })

    it('updates active pane when the active pane is closed', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane2Id = (split.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      // Pane 2 is active (set by splitPane)
      expect(state.activePane['tab-1']).toBe(pane2Id)

      // Close the active pane
      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId: pane2Id }))

      // Active pane should update to the remaining pane
      expect(state.activePane['tab-1']).toBe(pane1Id)
    })

    it('handles nested splits correctly when closing a pane', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }
      const content3: PaneContent = { kind: 'terminal', mode: 'codex' }

      // Create: pane1 | (pane2 / pane3)
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const split1 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane2Id = (split1.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane2Id,
          direction: 'vertical',
          newContent: content3,
        })
      )

      // Get pane3 id
      const split2 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const nestedSplit = split2.children[1] as Extract<PaneNode, { type: 'split' }>
      const pane3Id = (nestedSplit.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      // Close pane3
      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId: pane3Id }))

      // The nested split should collapse, leaving: pane1 | pane2
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(root.type).toBe('split')
      expect(root.direction).toBe('horizontal')
      expect(root.children[0].type).toBe('leaf')
      expect(root.children[1].type).toBe('leaf')
      expect((root.children[1] as Extract<PaneNode, { type: 'leaf' }>).id).toBe(pane2Id)
    })

    it('does nothing if tab layout does not exist', () => {
      const state = panesReducer(
        initialState,
        closePane({ tabId: 'non-existent-tab', paneId: 'some-pane' })
      )

      expect(state).toEqual(initialState)
    })

    it('does nothing if pane ID is not found', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )
      const originalLayout = state.layouts['tab-1']

      state = panesReducer(
        state,
        closePane({ tabId: 'tab-1', paneId: 'non-existent-pane' })
      )

      expect(state.layouts['tab-1']).toEqual(originalLayout)
    })

    it('removes pane title when pane is closed', () => {
      const layout: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } },
          { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'req-2', status: 'running', mode: 'shell' } },
        ],
      }
      const state: PanesState = {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'First', 'pane-2': 'Second' } },
      }

      const result = panesReducer(state, closePane({ tabId: 'tab-1', paneId: 'pane-1' }))

      expect(result.paneTitles['tab-1']['pane-1']).toBeUndefined()
      expect(result.paneTitles['tab-1']['pane-2']).toBe('Second')
    })

    // --- Sibling promotion tests ---

    it('promotes sibling when closing right child of a split', () => {
      const tabId = 'tab1'
      const leftLeaf: PaneNode = { type: 'leaf', id: 'left', content: terminalContent('left-req') }
      const rightLeaf: PaneNode = { type: 'leaf', id: 'right', content: terminalContent('right-req') }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [60, 40], children: [leftLeaf, rightLeaf],
      }
      const state = makeClosePaneState({ [tabId]: root }, { [tabId]: 'right' })
      const result = panesReducer(state, closePane({ tabId, paneId: 'right' }))
      // Root should now be the left leaf directly (promoted)
      expect(result.layouts[tabId]).toEqual(leftLeaf)
      expect(result.activePane[tabId]).toBe('left')
    })

    it('promotes sibling when closing left child of a split', () => {
      const tabId = 'tab1'
      const leftLeaf: PaneNode = { type: 'leaf', id: 'left', content: terminalContent('left-req') }
      const rightLeaf: PaneNode = { type: 'leaf', id: 'right', content: terminalContent('right-req') }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'vertical',
        sizes: [50, 50], children: [leftLeaf, rightLeaf],
      }
      const state = makeClosePaneState({ [tabId]: root }, { [tabId]: 'left' })
      const result = panesReducer(state, closePane({ tabId, paneId: 'left' }))
      expect(result.layouts[tabId]).toEqual(rightLeaf)
      expect(result.activePane[tabId]).toBe('right')
    })

    it('preserves tree structure when closing a pane in a nested split', () => {
      // Setup: root is V-split(H-split(A, B), C)
      // Action: close A
      // Expected: root becomes V-split(B, C) -- B promoted to replace H-split
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'b', content: terminalContent('b-req') }
      const c: PaneNode = { type: 'leaf', id: 'c', content: terminalContent('c-req') }
      const innerSplit: PaneNode = {
        type: 'split', id: 'inner', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const root: PaneNode = {
        type: 'split', id: 'outer', direction: 'vertical',
        sizes: [70, 30], children: [innerSplit, c],
      }
      const state = makeClosePaneState({ [tabId]: root }, { [tabId]: 'a' })
      const result = panesReducer(state, closePane({ tabId, paneId: 'a' }))
      // Outer split should remain with same sizes, but inner replaced by b
      expect(result.layouts[tabId]).toEqual({
        type: 'split', id: 'outer', direction: 'vertical',
        sizes: [70, 30], children: [b, c],
      })
      expect(result.activePane[tabId]).toBe('b')
    })

    it('preserves deeply nested tree structure', () => {
      // Setup: root = V-split(H-split(A, B), H-split(C, D))
      // Close B
      // Expected: root = V-split(A, H-split(C, D))
      // H-split(C, D) is completely untouched including sizes
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'b', content: terminalContent('b-req') }
      const c: PaneNode = { type: 'leaf', id: 'c', content: terminalContent('c-req') }
      const d: PaneNode = { type: 'leaf', id: 'd', content: terminalContent('d-req') }
      const top: PaneNode = {
        type: 'split', id: 'top', direction: 'horizontal',
        sizes: [40, 60], children: [a, b],
      }
      const bottom: PaneNode = {
        type: 'split', id: 'bottom', direction: 'horizontal',
        sizes: [30, 70], children: [c, d],
      }
      const root: PaneNode = {
        type: 'split', id: 'root', direction: 'vertical',
        sizes: [50, 50], children: [top, bottom],
      }
      const state = makeClosePaneState({ [tabId]: root }, { [tabId]: 'b' })
      const result = panesReducer(state, closePane({ tabId, paneId: 'b' }))
      expect(result.layouts[tabId]).toEqual({
        type: 'split', id: 'root', direction: 'vertical',
        sizes: [50, 50], children: [a, bottom],
      })
      // Untouched subtree should preserve referential identity (Immer structural sharing)
      const resultRoot = result.layouts[tabId] as Extract<PaneNode, { type: 'split' }>
      expect(resultRoot.children[1]).toBe(bottom)
    })

    it('does nothing when closing the only pane (leaf root)', () => {
      const tabId = 'tab1'
      const leaf: PaneNode = { type: 'leaf', id: 'only', content: terminalContent('only-req') }
      const state = makeClosePaneState({ [tabId]: leaf }, { [tabId]: 'only' })
      const result = panesReducer(state, closePane({ tabId, paneId: 'only' }))
      expect(result.layouts[tabId]).toEqual(leaf)
    })
  })

  describe('setActivePane', () => {
    it('updates the active pane for a tab', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane2Id = (split.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      // Currently pane2 is active
      expect(state.activePane['tab-1']).toBe(pane2Id)

      // Set pane1 as active
      state = panesReducer(
        state,
        setActivePane({ tabId: 'tab-1', paneId: pane1Id })
      )

      expect(state.activePane['tab-1']).toBe(pane1Id)
    })

    it('allows setting active pane even if tab has no layout', () => {
      const state = panesReducer(
        initialState,
        setActivePane({ tabId: 'tab-1', paneId: 'some-pane' })
      )

      expect(state.activePane['tab-1']).toBe('some-pane')
    })
  })

  describe('resizePanes', () => {
    it('updates split sizes', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const splitId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>).id

      state = panesReducer(
        state,
        resizePanes({ tabId: 'tab-1', splitId, sizes: [30, 70] })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(split.sizes).toEqual([30, 70])
    })

    it('updates nested split sizes', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }
      const content3: PaneContent = { kind: 'terminal', mode: 'codex' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const split1 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane2Id = (split1.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane2Id,
          direction: 'vertical',
          newContent: content3,
        })
      )

      // Get nested split id
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const nestedSplitId = (root.children[1] as Extract<PaneNode, { type: 'split' }>).id

      state = panesReducer(
        state,
        resizePanes({ tabId: 'tab-1', splitId: nestedSplitId, sizes: [25, 75] })
      )

      const updatedRoot = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const nestedSplit = updatedRoot.children[1] as Extract<PaneNode, { type: 'split' }>
      expect(nestedSplit.sizes).toEqual([25, 75])
    })

    it('does nothing if tab layout does not exist', () => {
      const state = panesReducer(
        initialState,
        resizePanes({ tabId: 'non-existent-tab', splitId: 'some-split', sizes: [40, 60] })
      )

      expect(state).toEqual(initialState)
    })

    it('does nothing if split ID is not found', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      const originalSizes = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>).sizes

      state = panesReducer(
        state,
        resizePanes({ tabId: 'tab-1', splitId: 'non-existent-split', sizes: [40, 60] })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(split.sizes).toEqual(originalSizes)
    })
  })

  describe('resizeMultipleSplits', () => {
    it('updates multiple splits at once', () => {
      // Build a 2x2 grid: V-split(H-split(A, B), H-split(C, D))
      const stateWithA = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const paneAId = (stateWithA.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      // Split A vertically to get top/bottom
      const stateWithAB = panesReducer(
        stateWithA,
        splitPane({ tabId: 'tab-1', paneId: paneAId, direction: 'vertical', newContent: { kind: 'terminal', mode: 'shell' } })
      )
      const vSplit = stateWithAB.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const vSplitId = vSplit.id
      const topPaneId = (vSplit.children[0] as Extract<PaneNode, { type: 'leaf' }>).id
      const botPaneId = (vSplit.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      // Split top pane horizontally
      const stateWithTop = panesReducer(
        stateWithAB,
        splitPane({ tabId: 'tab-1', paneId: topPaneId, direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' } })
      )
      const root1 = stateWithTop.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const topHSplit = root1.children[0] as Extract<PaneNode, { type: 'split' }>
      const topHSplitId = topHSplit.id

      // Split bottom pane horizontally
      const stateWithAll = panesReducer(
        stateWithTop,
        splitPane({ tabId: 'tab-1', paneId: botPaneId, direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' } })
      )
      const root2 = stateWithAll.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const botHSplit = root2.children[1] as Extract<PaneNode, { type: 'split' }>
      const botHSplitId = botHSplit.id

      // Now resize both H-splits and the V-split in one action
      const finalState = panesReducer(
        stateWithAll,
        resizeMultipleSplits({
          tabId: 'tab-1',
          resizes: [
            { splitId: topHSplitId, sizes: [60, 40] },
            { splitId: botHSplitId, sizes: [60, 40] },
            { splitId: vSplitId, sizes: [40, 60] },
          ],
        })
      )

      const finalRoot = finalState.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(finalRoot.sizes).toEqual([40, 60])
      const finalTopH = finalRoot.children[0] as Extract<PaneNode, { type: 'split' }>
      expect(finalTopH.sizes).toEqual([60, 40])
      const finalBotH = finalRoot.children[1] as Extract<PaneNode, { type: 'split' }>
      expect(finalBotH.sizes).toEqual([60, 40])
    })

    it('does nothing if tab layout does not exist', () => {
      const state = panesReducer(
        initialState,
        resizeMultipleSplits({
          tabId: 'non-existent',
          resizes: [{ splitId: 's1', sizes: [60, 40] }],
        })
      )
      expect(state).toEqual(initialState)
    })

    it('preserves sizes of splits not in the resizes array', () => {
      // Build a simple H-split(A, B) with [50,50]
      const s1 = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const pId = (s1.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id
      const s2 = panesReducer(
        s1,
        splitPane({ tabId: 'tab-1', paneId: pId, direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' } })
      )
      const splitId = (s2.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>).id

      // Resize with empty array - nothing changes
      const s3 = panesReducer(
        s2,
        resizeMultipleSplits({ tabId: 'tab-1', resizes: [] })
      )
      const split = s3.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(split.sizes).toEqual([50, 50])
    })
  })

  describe('updatePaneContent', () => {
    it('updates the content of a leaf pane', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', terminalId: 'term-123', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const paneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        updatePaneContent({ tabId: 'tab-1', paneId, content: content2 })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content).toEqual(content2)
    })

    it('updates pane content in a split layout', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }
      const content3: PaneContent = { kind: 'browser', url: 'https://updated.com', devToolsOpen: true }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: pane1Id,
          direction: 'horizontal',
          newContent: content2,
        })
      )

      state = panesReducer(
        state,
        updatePaneContent({ tabId: 'tab-1', paneId: pane1Id, content: content3 })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const firstPane = split.children[0] as Extract<PaneNode, { type: 'leaf' }>
      expect(firstPane.content).toEqual(content3)
    })

    it('does nothing if tab layout does not exist', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      const state = panesReducer(
        initialState,
        updatePaneContent({ tabId: 'non-existent-tab', paneId: 'some-pane', content })
      )

      expect(state).toEqual(initialState)
    })

    it('does nothing if pane ID is not found', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      const originalLayout = JSON.parse(JSON.stringify(state.layouts['tab-1']))

      state = panesReducer(
        state,
        updatePaneContent({ tabId: 'tab-1', paneId: 'non-existent-pane', content: content2 })
      )

      expect(state.layouts['tab-1']).toEqual(originalLayout)
    })
  })

  describe('replacePane', () => {
    it('sets pane content to picker', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell', terminalId: 'term-1' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }

      const result = panesReducer(state, replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))

      const resultLeaf = result.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(resultLeaf.content).toEqual({ kind: 'picker' })
    })

    it('clears paneTitleSetByUser and resets derived title', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'My Custom Name' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }

      const result = panesReducer(state, replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))

      expect(result.paneTitles['tab-1']['pane-1']).toBe('New Tab')
      expect(result.paneTitleSetByUser['tab-1']?.['pane-1']).toBeUndefined()
    })

    it('is a no-op on non-existent tab', () => {
      const result = panesReducer(initialState, replacePane({ tabId: 'nope', paneId: 'pane-1' }))
      expect(result).toEqual(initialState)
    })

    it('is a no-op on non-existent pane (layout unchanged)', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }

      const result = panesReducer(state, replacePane({ tabId: 'tab-1', paneId: 'non-existent' }))

      // Content should be unchanged
      const resultLeaf = result.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(resultLeaf.content.kind).toBe('terminal')

      // No ghost title entry should be created for non-existent pane
      expect(result.paneTitles['tab-1']['non-existent']).toBeUndefined()
    })

    it('works on a pane inside a split', () => {
      const layout: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } },
          { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'req-2', status: 'running', mode: 'claude' } },
        ],
      }
      const state: PanesState = {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell', 'pane-2': 'Claude CLI' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-2': true } },
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }

      const result = panesReducer(state, replacePane({ tabId: 'tab-1', paneId: 'pane-2' }))

      // pane-2 should be picker, pane-1 untouched
      const split = result.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane1 = split.children[0] as Extract<PaneNode, { type: 'leaf' }>
      const pane2 = split.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(pane1.content.kind).toBe('terminal')
      expect(pane2.content).toEqual({ kind: 'picker' })
      expect(result.paneTitles['tab-1']['pane-2']).toBe('New Tab')
      expect(result.paneTitleSetByUser['tab-1']?.['pane-2']).toBeUndefined()
    })
  })

  describe('removeLayout', () => {
    it('removes the layout for a tab', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )

      expect(state.layouts['tab-1']).toBeDefined()

      state = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

      expect(state.layouts['tab-1']).toBeUndefined()
    })

    it('removes the active pane entry for the tab', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )

      expect(state.activePane['tab-1']).toBeDefined()

      state = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

      expect(state.activePane['tab-1']).toBeUndefined()
    })

    it('does not affect other tabs', () => {
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
      const content2: PaneContent = { kind: 'terminal', mode: 'claude' }

      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: content1 })
      )
      state = panesReducer(
        state,
        initLayout({ tabId: 'tab-2', content: content2 })
      )

      state = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

      expect(state.layouts['tab-1']).toBeUndefined()
      expect(state.layouts['tab-2']).toBeDefined()
      expect(state.activePane['tab-1']).toBeUndefined()
      expect(state.activePane['tab-2']).toBeDefined()
    })

    it('does nothing if tab does not exist', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )
      const originalState = { ...state }

      state = panesReducer(state, removeLayout({ tabId: 'non-existent-tab' }))

      expect(state.layouts).toEqual(originalState.layouts)
      expect(state.activePane).toEqual(originalState.activePane)
    })

    it('removes paneTitles for the tab', () => {
      const state: PanesState = {
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'My Title' } },
      }

      const result = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

      expect(result.paneTitles['tab-1']).toBeUndefined()
    })

    it('preserves paneTitles for other tabs when removing one', () => {
      const state: PanesState = {
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } },
          'tab-2': { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'req-2', status: 'running', mode: 'shell' } },
        },
        activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2' },
        paneTitles: { 'tab-1': { 'pane-1': 'Title 1' }, 'tab-2': { 'pane-2': 'Title 2' } },
      }

      const result = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

      expect(result.paneTitles['tab-1']).toBeUndefined()
      expect(result.paneTitles['tab-2']).toEqual({ 'pane-2': 'Title 2' })
    })
  })

  describe('hydratePanes', () => {
    it('restores persisted state', () => {
      const savedState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-saved-1',
            content: { kind: 'terminal', mode: 'shell' },
          },
          'tab-2': {
            type: 'split',
            id: 'split-saved-1',
            direction: 'horizontal',
            children: [
              { type: 'leaf', id: 'pane-saved-2', content: { kind: 'terminal', mode: 'claude' } },
              { type: 'leaf', id: 'pane-saved-3', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
            ],
            sizes: [40, 60],
          },
        },
        activePane: {
          'tab-1': 'pane-saved-1',
          'tab-2': 'pane-saved-3',
        },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const state = panesReducer(initialState, hydratePanes(savedState))

      expect(state).toEqual(savedState)
    })

    it('handles empty saved state', () => {
      const savedState: PanesState = {
        layouts: {},
        activePane: {},
        paneTitles: {},
      }

      const state = panesReducer(initialState, hydratePanes(savedState))

      expect(state.layouts).toEqual({})
      expect(state.activePane).toEqual({})
      expect(state.paneTitles).toEqual({})
    })

    it('preserves complex nested structures', () => {
      const savedState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'root-split',
            direction: 'horizontal',
            children: [
              { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell' } },
              {
                type: 'split',
                id: 'nested-split',
                direction: 'vertical',
                children: [
                  { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', mode: 'claude' } },
                  { type: 'leaf', id: 'pane-3', content: { kind: 'terminal', mode: 'codex' } },
                ],
                sizes: [30, 70],
              },
            ],
            sizes: [50, 50],
          },
        },
        activePane: {
          'tab-1': 'pane-2',
        },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const state = panesReducer(initialState, hydratePanes(savedState))

      expect(state).toEqual(savedState)

      // Verify structure
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(root.type).toBe('split')
      expect(root.children[1].type).toBe('split')
      const nested = root.children[1] as Extract<PaneNode, { type: 'split' }>
      expect(nested.sizes).toEqual([30, 70])
    })

    it('restores paneTitles from persisted state', () => {
      const savedState: PanesState = {
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'My Shell' } },
      }

      const state = panesReducer(initialState, hydratePanes(savedState))

      expect(state.paneTitles).toEqual({ 'tab-1': { 'pane-1': 'My Shell' } })
    })

    it('preserves local resumeSessionId when incoming has different session (same createRequestId)', () => {
      // Simulate local state: Claude pane with SESSION_A, still creating
      const localState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'creating',
              resumeSessionId: 'session-A',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      // Incoming: same createRequestId but different resumeSessionId
      const incoming: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              terminalId: 'remote-t1',
              resumeSessionId: 'session-B',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const state = panesReducer(localState, hydratePanes(incoming))
      const content = (state.layouts['tab-1'] as any).content

      expect(content.resumeSessionId).toBe('session-A')
    })

    it('preserves local resumeSessionId inside split pane trees', () => {
      const localState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'terminal',
                  mode: 'shell',
                  createRequestId: 'req-1',
                  status: 'running',
                  terminalId: 't1',
                },
              },
              {
                type: 'leaf',
                id: 'pane-2',
                content: {
                  kind: 'terminal',
                  mode: 'claude',
                  createRequestId: 'req-2',
                  status: 'creating',
                  resumeSessionId: 'session-X',
                },
              },
            ],
          } as any,
        },
        activePane: { 'tab-1': 'pane-2' },
        paneTitles: {},
      }

      const incoming: PanesState = {
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'terminal',
                  mode: 'shell',
                  createRequestId: 'req-1',
                  status: 'running',
                  terminalId: 't1',
                },
              },
              {
                type: 'leaf',
                id: 'pane-2',
                content: {
                  kind: 'terminal',
                  mode: 'claude',
                  createRequestId: 'req-2',
                  status: 'running',
                  terminalId: 'remote-t2',
                  resumeSessionId: 'session-Y',
                },
              },
            ],
          } as any,
        },
        activePane: { 'tab-1': 'pane-2' },
        paneTitles: {},
      }

      const state = panesReducer(localState, hydratePanes(incoming))
      const split = state.layouts['tab-1'] as any
      const pane2Content = split.children[1].content

      expect(pane2Content.resumeSessionId).toBe('session-X')
    })

    it('accepts incoming when resumeSessionId matches local (no conflict)', () => {
      const localState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'creating',
              resumeSessionId: 'session-A',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const incoming: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              terminalId: 'remote-t1',
              resumeSessionId: 'session-A',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const state = panesReducer(localState, hydratePanes(incoming))
      const content = (state.layouts['tab-1'] as any).content

      // Same session — incoming accepted wholesale (lifecycle progress propagated)
      expect(content.resumeSessionId).toBe('session-A')
      expect(content.terminalId).toBe('remote-t1')
      expect(content.status).toBe('running')
    })

    it('preserves local resumeSessionId even when incoming has exited status', () => {
      const localState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              terminalId: 't1',
              resumeSessionId: 'session-A',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      // Incoming: same createRequestId, exited, but different resumeSessionId
      const incoming: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'exited',
              terminalId: 't1',
              resumeSessionId: 'session-B',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const state = panesReducer(localState, hydratePanes(incoming))
      const content = (state.layouts['tab-1'] as any).content

      // Session identity preserved, but exit status propagated
      expect(content.resumeSessionId).toBe('session-A')
      expect(content.status).toBe('exited')
    })

    it('allows resumeSessionId update when local has no session', () => {
      // Local pane has no resumeSessionId (new terminal, not yet associated)
      const localState: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'creating',
              // no resumeSessionId
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const incoming: PanesState = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              terminalId: 'remote-t1',
              resumeSessionId: 'session-new',
            },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const state = panesReducer(localState, hydratePanes(incoming))
      const content = (state.layouts['tab-1'] as any).content

      // When local has NO resumeSessionId, incoming's session should be accepted
      expect(content.resumeSessionId).toBe('session-new')
    })

    it('handles missing paneTitles in persisted state', () => {
      const savedStateWithoutTitles = {
        layouts: {},
        activePane: {},
        // paneTitles is missing
      } as PanesState

      const state = panesReducer(initialState, hydratePanes(savedStateWithoutTitles))

      expect(state.paneTitles).toEqual({})
    })
  })

  describe('PaneContent types', () => {
    it('TerminalPaneContent has required lifecycle fields', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-123',
        status: 'creating',
        mode: 'shell',
      }
      expect(content.kind).toBe('terminal')
      expect(content.createRequestId).toBe('req-123')
      expect(content.status).toBe('creating')
    })

    it('TerminalPaneContent shell is optional with default behavior', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-123',
        status: 'creating',
        mode: 'shell',
        // shell is optional - defaults handled by reducer
      }
      expect(content.shell).toBeUndefined()
    })

    it('BrowserPaneContent unchanged', () => {
      const content: BrowserPaneContent = {
        kind: 'browser',
        url: 'https://example.com',
        devToolsOpen: false,
      }
      expect(content.kind).toBe('browser')
    })

    it('PaneContent is union of both types', () => {
      const terminal: PaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'shell',
      }
      const browser: PaneContent = {
        kind: 'browser',
        url: '',
        devToolsOpen: false,
      }
      expect(terminal.kind).toBe('terminal')
      expect(browser.kind).toBe('browser')
    })
  })

  describe('EditorPaneContent type', () => {
    it('can be created with required fields', () => {
      const content: EditorPaneContent = {
        kind: 'editor',
        filePath: '/path/to/file.ts',
        language: 'typescript',
        readOnly: false,
        content: 'const x = 1',
        viewMode: 'source',
      }
      expect(content.kind).toBe('editor')
      expect(content.filePath).toBe('/path/to/file.ts')
    })

    it('supports scratch pad mode with null filePath', () => {
      const content: EditorPaneContent = {
        kind: 'editor',
        filePath: null,
        language: null,
        readOnly: false,
        content: '',
        viewMode: 'source',
      }
      expect(content.filePath).toBeNull()
    })

    it('is part of PaneContent union', () => {
      const editor: PaneContent = {
        kind: 'editor',
        filePath: '/test.md',
        language: 'markdown',
        readOnly: false,
        content: '# Hello',
        viewMode: 'preview',
      }
      expect(editor.kind).toBe('editor')
    })
  })

  describe('ExtensionPaneContent type', () => {
    it('can be created with required fields', () => {
      const content: ExtensionPaneContent = {
        kind: 'extension',
        extensionName: 'my-widget',
        props: { foo: 'bar', count: 42 },
      }
      expect(content.kind).toBe('extension')
      expect(content.extensionName).toBe('my-widget')
      expect(content.props).toEqual({ foo: 'bar', count: 42 })
    })

    it('is part of PaneContent union', () => {
      const ext: PaneContent = {
        kind: 'extension',
        extensionName: 'some-ext',
        props: {},
      }
      expect(ext.kind).toBe('extension')
    })

    it('passes through normalizeContent unchanged via initLayout', () => {
      const state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-ext',
          content: { kind: 'extension', extensionName: 'my-ext', props: { key: 'value' } },
        })
      )

      const leaf = state.layouts['tab-ext'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content).toEqual({
        kind: 'extension',
        extensionName: 'my-ext',
        props: { key: 'value' },
      })
    })

    it('survives hydratePanes round-trip', () => {
      const savedState: PanesState = {
        layouts: {
          'tab-ext': {
            type: 'leaf',
            id: 'pane-ext-1',
            content: { kind: 'extension', extensionName: 'my-widget', props: { theme: 'dark' } },
          },
        },
        activePane: { 'tab-ext': 'pane-ext-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const state = panesReducer(initialState, hydratePanes(savedState))
      const leaf = state.layouts['tab-ext'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content).toEqual({
        kind: 'extension',
        extensionName: 'my-widget',
        props: { theme: 'dark' },
      })
    })

    it('survives mergeTerminalState when extension pane exists locally and remotely', () => {
      const extensionContent: PaneContent = {
        kind: 'extension',
        extensionName: 'my-ext',
        props: { key: 'value' },
      }

      // Set up local state with an extension pane
      const localState = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-ext', content: extensionContent })
      )

      // Hydrate incoming state with the same extension pane
      const incoming: PanesState = {
        layouts: {
          'tab-ext': {
            type: 'leaf',
            id: (localState.layouts['tab-ext'] as any).id,
            content: extensionContent,
          },
        },
        activePane: localState.activePane,
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const merged = panesReducer(localState, hydratePanes(incoming))
      const leaf = merged.layouts['tab-ext'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content).toEqual(extensionContent)
    })
  })

  describe('addPane', () => {
    // Helper to construct state with explicit layouts and activePane
    function terminalContent(createRequestId: string): PaneContent {
      return { kind: 'terminal', createRequestId, status: 'running', mode: 'shell' }
    }

    function makeState(
      layouts: Record<string, PaneNode>,
      activePane: Record<string, string>
    ): PanesState {
      return {
        layouts,
        activePane,
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }
    }

    // Helper to count leaves in a pane tree
    function countLeaves(node: PaneNode): number {
      if (node.type === 'leaf') return 1
      return countLeaves(node.children[0]) + countLeaves(node.children[1])
    }

    it('does nothing if layout does not exist', () => {
      const state = panesReducer(
        initialState,
        addPane({ tabId: 'non-existent', newContent: { kind: 'terminal', mode: 'shell' } })
      )
      expect(state.layouts['non-existent']).toBeUndefined()
    })

    it('falls back to first leaf when no active pane is set', () => {
      const tabId = 'tab1'
      const leaf: PaneNode = { type: 'leaf', id: 'only', content: terminalContent('only-req') }
      // activePane is empty — no active pane set for this tab
      const state = makeState({ [tabId]: leaf }, {})
      const result = panesReducer(state, addPane({ tabId, newContent: { kind: 'picker' } }))
      // Should still split the only leaf
      const root = result.layouts[tabId]
      expect(root.type).toBe('split')
      if (root.type !== 'split') return
      expect(root.children[0]).toEqual(leaf)
      expect(root.children[1].type).toBe('leaf')
    })

    it('splits the active pane to the right', () => {
      const tabId = 'tab1'
      const leaf: PaneNode = { type: 'leaf', id: 'active', content: terminalContent('active-req') }
      const state = makeState({ [tabId]: leaf }, { [tabId]: 'active' })
      const result = panesReducer(state, addPane({
        tabId,
        newContent: { kind: 'picker' },
      }))
      // Root should be a horizontal split with active pane on left, new pane on right
      const root = result.layouts[tabId]
      expect(root.type).toBe('split')
      if (root.type !== 'split') return
      expect(root.direction).toBe('horizontal')
      expect(root.sizes).toEqual([50, 50])
      expect(root.children[0]).toEqual(leaf) // Original pane preserved
      expect(root.children[1].type).toBe('leaf')
      if (root.children[1].type === 'leaf') {
        expect(root.children[1].content.kind).toBe('picker')
      }
    })

    it('splits only the active pane, preserving the rest of the tree', () => {
      // Setup: H-split(A, B), A is active
      // Action: addPane
      // Expected: H-split(H-split(A, new), B) — only A was split
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'b', content: terminalContent('b-req') }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const state = makeState({ [tabId]: root }, { [tabId]: 'a' })
      const result = panesReducer(state, addPane({ tabId, newContent: { kind: 'picker' } }))
      const newRoot = result.layouts[tabId]
      expect(newRoot.type).toBe('split')
      if (newRoot.type !== 'split') return
      // B should be completely untouched
      expect(newRoot.children[1]).toBe(b)
      // A's position should now contain a split
      expect(newRoot.children[0].type).toBe('split')
    })

    it('sets the new pane as active', () => {
      const tabId = 'tab1'
      const leaf: PaneNode = { type: 'leaf', id: 'active', content: terminalContent('active-req') }
      const state = makeState({ [tabId]: leaf }, { [tabId]: 'active' })
      const result = panesReducer(state, addPane({ tabId, newContent: { kind: 'picker' } }))
      expect(result.activePane[tabId]).not.toBe('active')
      // Active should be the new pane's id
      const root = result.layouts[tabId]
      if (root.type === 'split' && root.children[1].type === 'leaf') {
        expect(result.activePane[tabId]).toBe(root.children[1].id)
      }
    })

    it('preserves existing pane IDs when splitting', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const pane1Id = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude' } })
      )

      // First pane should keep its ID
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const firstPane = root.children[0] as Extract<PaneNode, { type: 'leaf' }>
      expect(firstPane.id).toBe(pane1Id)
    })

    it('generates createRequestId for new terminal panes', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude' } })
      )

      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const newPane = root.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(newPane.content.kind).toBe('terminal')
      if (newPane.content.kind === 'terminal') {
        expect(newPane.content.createRequestId).toBeDefined()
        expect(newPane.content.status).toBe('creating')
      }
    })

    it('preserves pane contents when adding a 3rd pane (splits active, not grid rebuild)', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } })
      )
      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude', createRequestId: 'req-2', status: 'running' } })
      )

      // After first addPane: H-split(shell, claude) with claude as active
      const split2 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane1Id = (split2.children[0] as Extract<PaneNode, { type: 'leaf' }>).id

      // Add 3rd pane — should split the active (claude) pane, not rebuild grid
      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'codex', createRequestId: 'req-3', status: 'running' } })
      )

      // Root should still be H-split; left child is original shell pane
      const root = state.layouts['tab-1']
      expect(root.type).toBe('split')
      if (root.type !== 'split') return
      expect(root.direction).toBe('horizontal')
      // Left child should be the original shell pane (untouched)
      expect(root.children[0].type).toBe('leaf')
      const leftLeaf = root.children[0] as Extract<PaneNode, { type: 'leaf' }>
      expect(leftLeaf.id).toBe(pane1Id)
      // Right child should now be a split (claude | codex)
      expect(root.children[1].type).toBe('split')

      expect(countLeaves(root)).toBe(3)
    })
  })

  describe('updatePaneTitle', () => {
    it('updates the title for a specific pane', () => {
      const initialLayout: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': initialLayout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const result = panesReducer(state, updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'My Terminal' }))

      expect(result.paneTitles['tab-1']).toBeDefined()
      expect(result.paneTitles['tab-1']['pane-1']).toBe('My Terminal')
    })

    it('preserves other pane titles when updating one', () => {
      const state: PanesState = {
        layouts: {},
        activePane: {},
        paneTitles: { 'tab-1': { 'pane-2': 'Other Pane' } },
      }

      const result = panesReducer(state, updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'First Pane' }))

      expect(result.paneTitles['tab-1']['pane-1']).toBe('First Pane')
      expect(result.paneTitles['tab-1']['pane-2']).toBe('Other Pane')
    })
  })

  describe('splitPane title initialization', () => {
    it('initializes title for new pane using derivePaneTitle', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const result = panesReducer(state, splitPane({
        tabId: 'tab-1',
        paneId: 'pane-1',
        direction: 'horizontal',
        newContent: { kind: 'terminal', mode: 'claude' },
      }))

      // Find the new pane ID (it's the active pane after split)
      const newPaneId = result.activePane['tab-1']
      expect(result.paneTitles['tab-1'][newPaneId]).toBe('Claude CLI')
    })
  })

  describe('addPane title initialization', () => {
    it('initializes title for new pane using derivePaneTitle', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      }

      const result = panesReducer(state, addPane({
        tabId: 'tab-1',
        newContent: { kind: 'terminal', mode: 'codex' },
      }))

      const newPaneId = result.activePane['tab-1']
      expect(result.paneTitles['tab-1'][newPaneId]).toBe('Codex CLI')
    })
  })

  describe('paneTitleSetByUser guard', () => {
    const makeState = (setByUser: boolean): PanesState => ({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'User Title' } },
      paneTitleSetByUser: setByUser ? { 'tab-1': { 'pane-1': true } } : {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
    })

    it('updatePaneContent does NOT overwrite title when paneTitleSetByUser is true', () => {
      const state = makeState(true)
      const result = panesReducer(state, updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'claude' },
      }))

      expect(result.paneTitles['tab-1']['pane-1']).toBe('User Title')
    })

    it('updatePaneContent DOES overwrite title when paneTitleSetByUser is false/missing', () => {
      const state = makeState(false)
      const result = panesReducer(state, updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'claude' },
      }))

      // derivePaneTitle for claude mode returns 'Claude CLI'
      expect(result.paneTitles['tab-1']['pane-1']).toBe('Claude CLI')
    })

    it('updatePaneTitle sets paneTitleSetByUser to true', () => {
      const state = makeState(false)
      const result = panesReducer(state, updatePaneTitle({
        tabId: 'tab-1',
        paneId: 'pane-1',
        title: 'Custom Name',
      }))

      expect(result.paneTitleSetByUser['tab-1']?.['pane-1']).toBe(true)
    })

    it('updatePaneTitle with setByUser=false does NOT set paneTitleSetByUser', () => {
      const state = makeState(false)
      const result = panesReducer(state, updatePaneTitle({
        tabId: 'tab-1',
        paneId: 'pane-1',
        title: 'System Title',
        setByUser: false,
      }))

      expect(result.paneTitles['tab-1']['pane-1']).toBe('System Title')
      expect(result.paneTitleSetByUser['tab-1']?.['pane-1']).toBeUndefined()
    })

    it('updatePaneTitle with setByUser=false skips update when user already set the title', () => {
      const state = makeState(true)
      const result = panesReducer(state, updatePaneTitle({
        tabId: 'tab-1',
        paneId: 'pane-1',
        title: 'System Override Attempt',
        setByUser: false,
      }))

      // User title should be preserved
      expect(result.paneTitles['tab-1']['pane-1']).toBe('User Title')
    })

    it('closePane cleans up paneTitleSetByUser entry', () => {
      // Need a split so we can actually close a pane
      const state: PanesState = {
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } },
              { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'req-2', status: 'running', mode: 'claude' } },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell', 'pane-2': 'Claude CLI' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': true, 'pane-2': true } },
        renameRequestTabId: null,
        renameRequestPaneId: null,
      }

      const result = panesReducer(state, closePane({ tabId: 'tab-1', paneId: 'pane-2' }))

      expect(result.paneTitleSetByUser['tab-1']?.['pane-2']).toBeUndefined()
      // pane-1 should still be there
      expect(result.paneTitleSetByUser['tab-1']?.['pane-1']).toBe(true)
    })

    it('removeLayout cleans up paneTitleSetByUser for the tab', () => {
      const state: PanesState = {
        ...initialState,
        layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell' } } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
      }

      const result = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

      expect(result.paneTitleSetByUser['tab-1']).toBeUndefined()
    })
  })

  describe('requestPaneRename / clearPaneRenameRequest', () => {
    it('requestPaneRename sets tabId and paneId', () => {
      const result = panesReducer(initialState, requestPaneRename({ tabId: 'tab-1', paneId: 'pane-1' }))

      expect(result.renameRequestTabId).toBe('tab-1')
      expect(result.renameRequestPaneId).toBe('pane-1')
    })

    it('clearPaneRenameRequest resets to null', () => {
      const state: PanesState = {
        ...initialState,
        renameRequestTabId: 'tab-1',
        renameRequestPaneId: 'pane-1',
      }

      const result = panesReducer(state, clearPaneRenameRequest())

      expect(result.renameRequestTabId).toBeNull()
      expect(result.renameRequestPaneId).toBeNull()
    })
  })

  describe('editor content normalization', () => {
    it('passes editor content through unchanged', () => {
      const editorContent: EditorPaneContent = {
        kind: 'editor',
        filePath: '/test.ts',
        language: 'typescript',
        readOnly: false,
        content: 'code',
        viewMode: 'source',
      }

      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: editorContent })
      )

      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content).toEqual(editorContent)
    })

    it('creates editor pane via addPane', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      state = panesReducer(
        state,
        addPane({
          tabId: 'tab-1',
          newContent: {
            kind: 'editor',
            filePath: null,
            language: null,
            readOnly: false,
            content: '',
            viewMode: 'source',
          },
        })
      )

      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const editorPane = root.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(editorPane.content.kind).toBe('editor')
    })
  })

  describe('toggleZoom', () => {
    function terminalContent(createRequestId: string): PaneContent {
      return { kind: 'terminal', createRequestId, status: 'running', mode: 'shell' }
    }

    function makeZoomState(
      layouts: Record<string, PaneNode>,
      activePane: Record<string, string>,
      zoomedPane: Record<string, string | undefined> = {}
    ): PanesState {
      return {
        layouts,
        activePane,
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane,
      }
    }

    it('sets zoomedPane when not zoomed', () => {
      const tabId = 'tab1'
      const leaf: PaneNode = { type: 'leaf', id: 'pane-a', content: terminalContent('a-req') }
      const state = makeZoomState({ [tabId]: leaf }, { [tabId]: 'pane-a' })

      const result = panesReducer(state, toggleZoom({ tabId, paneId: 'pane-a' }))

      expect(result.zoomedPane[tabId]).toBe('pane-a')
    })

    it('clears zoomedPane when same pane already zoomed (toggle off)', () => {
      const tabId = 'tab1'
      const leaf: PaneNode = { type: 'leaf', id: 'pane-a', content: terminalContent('a-req') }
      const state = makeZoomState(
        { [tabId]: leaf },
        { [tabId]: 'pane-a' },
        { [tabId]: 'pane-a' }
      )

      const result = panesReducer(state, toggleZoom({ tabId, paneId: 'pane-a' }))

      expect(result.zoomedPane[tabId]).toBeUndefined()
    })

    it('switches zoom to different pane', () => {
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'pane-a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'pane-b', content: terminalContent('b-req') }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const state = makeZoomState(
        { [tabId]: root },
        { [tabId]: 'pane-a' },
        { [tabId]: 'pane-a' }
      )

      const result = panesReducer(state, toggleZoom({ tabId, paneId: 'pane-b' }))

      expect(result.zoomedPane[tabId]).toBe('pane-b')
    })

    it('does not affect other tabs', () => {
      const a: PaneNode = { type: 'leaf', id: 'pane-a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'pane-b', content: terminalContent('b-req') }
      const state = makeZoomState(
        { 'tab1': a, 'tab2': b },
        { 'tab1': 'pane-a', 'tab2': 'pane-b' },
        { 'tab2': 'pane-b' }
      )

      const result = panesReducer(state, toggleZoom({ tabId: 'tab1', paneId: 'pane-a' }))

      expect(result.zoomedPane['tab1']).toBe('pane-a')
      expect(result.zoomedPane['tab2']).toBe('pane-b')
    })
  })

  describe('closePane clears zoom', () => {
    function terminalContent(createRequestId: string): PaneContent {
      return { kind: 'terminal', createRequestId, status: 'running', mode: 'shell' }
    }

    it('clears zoom when zoomed pane is closed', () => {
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'pane-a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'pane-b', content: terminalContent('b-req') }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const state: PanesState = {
        layouts: { [tabId]: root },
        activePane: { [tabId]: 'pane-b' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: { [tabId]: 'pane-b' },
      }

      const result = panesReducer(state, closePane({ tabId, paneId: 'pane-b' }))

      expect(result.zoomedPane[tabId]).toBeUndefined()
    })

    it('preserves zoom when non-zoomed pane is closed', () => {
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'pane-a', content: terminalContent('a-req') }
      const b: PaneNode = { type: 'leaf', id: 'pane-b', content: terminalContent('b-req') }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const state: PanesState = {
        layouts: { [tabId]: root },
        activePane: { [tabId]: 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: { [tabId]: 'pane-a' },
      }

      const result = panesReducer(state, closePane({ tabId, paneId: 'pane-b' }))

      expect(result.zoomedPane[tabId]).toBe('pane-a')
    })
  })

  describe('addPane clears zoom', () => {
    it('clears zoom when adding a pane while zoomed', () => {
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', createRequestId: 'a-req', status: 'running', mode: 'shell' } }
      const b: PaneNode = { type: 'leaf', id: 'pane-b', content: { kind: 'terminal', createRequestId: 'b-req', status: 'running', mode: 'shell' } }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const state: PanesState = {
        layouts: { [tabId]: root },
        activePane: { [tabId]: 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: { [tabId]: 'pane-a' },
      }

      const result = panesReducer(state, addPane({ tabId, newContent: { kind: 'picker' } }))

      // Zoom should be cleared so the new pane is visible
      expect(result.zoomedPane[tabId]).toBeUndefined()
    })
  })

  describe('splitPane clears zoom', () => {
    it('clears zoom when splitting a pane while zoomed', () => {
      const tabId = 'tab1'
      const a: PaneNode = { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', createRequestId: 'a-req', status: 'running', mode: 'shell' } }
      const b: PaneNode = { type: 'leaf', id: 'pane-b', content: { kind: 'terminal', createRequestId: 'b-req', status: 'running', mode: 'shell' } }
      const root: PaneNode = {
        type: 'split', id: 'split1', direction: 'horizontal',
        sizes: [50, 50], children: [a, b],
      }
      const state: PanesState = {
        layouts: { [tabId]: root },
        activePane: { [tabId]: 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: { [tabId]: 'pane-a' },
      }

      const result = panesReducer(state, splitPane({
        tabId,
        paneId: 'pane-a',
        direction: 'horizontal',
        newContent: { kind: 'picker' },
      }))

      // Zoom should be cleared so the new pane is visible
      expect(result.zoomedPane[tabId]).toBeUndefined()
    })
  })

  describe('updatePaneTitleByTerminalId', () => {
    it('updates paneTitles when a leaf has matching terminalId', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', terminalId: 'term-42', createRequestId: 'req-1', status: 'running', mode: 'claude' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const result = panesReducer(state, updatePaneTitleByTerminalId({ terminalId: 'term-42', title: 'My Session' }))

      expect(result.paneTitles['tab-1']['pane-a']).toBe('My Session')
    })

    it('does nothing when no pane matches the terminalId', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', terminalId: 'term-99', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: { 'tab-1': { 'pane-a': 'Original Title' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const result = panesReducer(state, updatePaneTitleByTerminalId({ terminalId: 'term-42', title: 'New Title' }))

      expect(result.paneTitles['tab-1']['pane-a']).toBe('Original Title')
    })

    it('updates pane title in a nested split tree', () => {
      const leaf1: PaneNode = {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', terminalId: 'term-1', createRequestId: 'req-1', status: 'running', mode: 'shell' },
      }
      const leaf2: PaneNode = {
        type: 'leaf',
        id: 'pane-b',
        content: { kind: 'terminal', terminalId: 'term-target', createRequestId: 'req-2', status: 'running', mode: 'claude' },
      }
      const leaf3: PaneNode = {
        type: 'leaf',
        id: 'pane-c',
        content: { kind: 'terminal', terminalId: 'term-3', createRequestId: 'req-3', status: 'running', mode: 'shell' },
      }
      const innerSplit: PaneNode = {
        type: 'split',
        id: 'split-inner',
        direction: 'vertical',
        sizes: [50, 50],
        children: [leaf2, leaf3],
      }
      const root: PaneNode = {
        type: 'split',
        id: 'split-root',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [leaf1, innerSplit],
      }
      const state: PanesState = {
        layouts: { 'tab-1': root },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const result = panesReducer(state, updatePaneTitleByTerminalId({ terminalId: 'term-target', title: 'Deep Rename' }))

      expect(result.paneTitles['tab-1']['pane-b']).toBe('Deep Rename')
      // Other panes should not be affected
      expect(result.paneTitles['tab-1']['pane-a']).toBeUndefined()
      expect(result.paneTitles['tab-1']['pane-c']).toBeUndefined()
    })

    it('updates across multiple tabs when both have matching terminalId', () => {
      const leaf1: PaneNode = {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', terminalId: 'term-shared', createRequestId: 'req-1', status: 'running', mode: 'claude' },
      }
      const leaf2: PaneNode = {
        type: 'leaf',
        id: 'pane-b',
        content: { kind: 'terminal', terminalId: 'term-shared', createRequestId: 'req-2', status: 'running', mode: 'claude' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf1, 'tab-2': leaf2 },
        activePane: { 'tab-1': 'pane-a', 'tab-2': 'pane-b' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const result = panesReducer(state, updatePaneTitleByTerminalId({ terminalId: 'term-shared', title: 'Shared Title' }))

      expect(result.paneTitles['tab-1']['pane-a']).toBe('Shared Title')
      expect(result.paneTitles['tab-2']['pane-b']).toBe('Shared Title')
    })

    it('skips non-terminal panes', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const result = panesReducer(state, updatePaneTitleByTerminalId({ terminalId: 'term-42', title: 'Title' }))

      expect(result.paneTitles['tab-1']).toBeUndefined()
    })

    it('skips panes where terminalId is undefined', () => {
      const leaf: PaneNode = {
        type: 'leaf',
        id: 'pane-a',
        content: { kind: 'terminal', createRequestId: 'req-1', status: 'creating', mode: 'claude' },
      }
      const state: PanesState = {
        layouts: { 'tab-1': leaf },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      }

      const result = panesReducer(state, updatePaneTitleByTerminalId({ terminalId: 'term-42', title: 'Title' }))

      expect(result.paneTitles['tab-1']).toBeUndefined()
    })
  })
})
