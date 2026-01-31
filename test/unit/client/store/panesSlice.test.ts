import { describe, it, expect, vi, beforeEach } from 'vitest'
import panesReducer, {
  initLayout,
  splitPane,
  addPane,
  closePane,
  setActivePane,
  resizePanes,
  updatePaneContent,
  removeLayout,
  hydratePanes,
  updatePaneTitle,
  PanesState,
} from '../../../../src/store/panesSlice'
import type { PaneNode, PaneContent, TerminalPaneContent, BrowserPaneContent, EditorPaneContent } from '../../../../src/store/paneTypes'

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

  describe('closePane', () => {
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

  describe('addPane (grid layout)', () => {
    // Helper to count leaves in a pane tree
    function countLeaves(node: PaneNode): number {
      if (node.type === 'leaf') return 1
      return countLeaves(node.children[0]) + countLeaves(node.children[1])
    }

    // Helper to collect all leaf contents in order (left-to-right, top-to-bottom)
    function collectLeaves(node: PaneNode): PaneContent[] {
      if (node.type === 'leaf') return [node.content]
      return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])]
    }

    it('does nothing if layout does not exist', () => {
      const state = panesReducer(
        initialState,
        addPane({ tabId: 'non-existent', newContent: { kind: 'terminal', mode: 'shell' } })
      )
      expect(state.layouts['non-existent']).toBeUndefined()
    })

    it('adds 2nd pane: creates horizontal split [1][2]', () => {
      // Start with 1 pane
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      // Add 2nd pane
      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude' } })
      )

      const root = state.layouts['tab-1']
      expect(root.type).toBe('split')
      expect(countLeaves(root)).toBe(2)

      const split = root as Extract<PaneNode, { type: 'split' }>
      expect(split.direction).toBe('horizontal')
      expect(split.children[0].type).toBe('leaf')
      expect(split.children[1].type).toBe('leaf')

      const leaves = collectLeaves(root)
      expect(leaves[0].kind).toBe('terminal')
      expect((leaves[0] as any).mode).toBe('shell')
      expect(leaves[1].kind).toBe('terminal')
      expect((leaves[1] as any).mode).toBe('claude')
    })

    it('adds 3rd pane: [1][2] on top, [3] full width bottom', () => {
      // Start with 1 pane
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      // Add 2nd pane
      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude' } })
      )

      // Add 3rd pane
      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'codex' } })
      )

      const root = state.layouts['tab-1']
      expect(countLeaves(root)).toBe(3)

      // Structure: vertical split with top row (horizontal split) and bottom (single pane)
      expect(root.type).toBe('split')
      const outerSplit = root as Extract<PaneNode, { type: 'split' }>
      expect(outerSplit.direction).toBe('vertical')

      // Top row: horizontal split of [1][2]
      expect(outerSplit.children[0].type).toBe('split')
      const topRow = outerSplit.children[0] as Extract<PaneNode, { type: 'split' }>
      expect(topRow.direction).toBe('horizontal')
      expect(topRow.children[0].type).toBe('leaf')
      expect(topRow.children[1].type).toBe('leaf')

      // Bottom row: single pane [3]
      expect(outerSplit.children[1].type).toBe('leaf')

      const leaves = collectLeaves(root)
      expect((leaves[0] as any).mode).toBe('shell')
      expect((leaves[1] as any).mode).toBe('claude')
      expect((leaves[2] as any).mode).toBe('codex')
    })

    it('adds 4th pane: 2x2 grid [1][2] / [3][4]', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      // Add panes 2, 3, 4
      state = panesReducer(state, addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude' } }))
      state = panesReducer(state, addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'codex' } }))
      state = panesReducer(state, addPane({ tabId: 'tab-1', newContent: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } }))

      const root = state.layouts['tab-1']
      expect(countLeaves(root)).toBe(4)

      // Structure: vertical split with two horizontal splits
      expect(root.type).toBe('split')
      const outerSplit = root as Extract<PaneNode, { type: 'split' }>
      expect(outerSplit.direction).toBe('vertical')

      // Top row: [1][2]
      expect(outerSplit.children[0].type).toBe('split')
      const topRow = outerSplit.children[0] as Extract<PaneNode, { type: 'split' }>
      expect(topRow.direction).toBe('horizontal')

      // Bottom row: [3][4]
      expect(outerSplit.children[1].type).toBe('split')
      const bottomRow = outerSplit.children[1] as Extract<PaneNode, { type: 'split' }>
      expect(bottomRow.direction).toBe('horizontal')

      const leaves = collectLeaves(root)
      expect((leaves[0] as any).mode).toBe('shell')
      expect((leaves[1] as any).mode).toBe('claude')
      expect((leaves[2] as any).mode).toBe('codex')
      expect(leaves[3].kind).toBe('browser')
    })

    it('adds 5th pane: [1][2][3] on top, [4][5] on bottom', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      // Add panes 2-5
      for (let i = 2; i <= 5; i++) {
        state = panesReducer(state, addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'shell' } }))
      }

      const root = state.layouts['tab-1']
      expect(countLeaves(root)).toBe(5)

      // Top row should have 3 panes, bottom row should have 2
      const outerSplit = root as Extract<PaneNode, { type: 'split' }>
      expect(outerSplit.direction).toBe('vertical')

      // Top row: 3 panes
      expect(countLeaves(outerSplit.children[0])).toBe(3)
      // Bottom row: 2 panes
      expect(countLeaves(outerSplit.children[1])).toBe(2)
    })

    it('adds 6th pane: 3x2 grid [1][2][3] / [4][5][6]', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      // Add panes 2-6
      for (let i = 2; i <= 6; i++) {
        state = panesReducer(state, addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'shell' } }))
      }

      const root = state.layouts['tab-1']
      expect(countLeaves(root)).toBe(6)

      const outerSplit = root as Extract<PaneNode, { type: 'split' }>
      expect(outerSplit.direction).toBe('vertical')

      // Both rows should have 3 panes
      expect(countLeaves(outerSplit.children[0])).toBe(3)
      expect(countLeaves(outerSplit.children[1])).toBe(3)
    })

    it('sets the new pane as active', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )

      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude' } })
      )

      // Find the new pane (should be the second leaf)
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const newPane = root.children[1] as Extract<PaneNode, { type: 'leaf' }>
      expect(state.activePane['tab-1']).toBe(newPane.id)
    })

    it('preserves existing pane IDs when restructuring', () => {
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

    it('preserves pane contents when restructuring for 3rd pane', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } })
      )
      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'claude', createRequestId: 'req-2', status: 'running' } })
      )

      // Capture pane IDs
      const split2 = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const pane1Id = (split2.children[0] as Extract<PaneNode, { type: 'leaf' }>).id
      const pane2Id = (split2.children[1] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'codex', createRequestId: 'req-3', status: 'running' } })
      )

      // After restructure, original panes should have same IDs and content
      const leaves = collectLeaves(state.layouts['tab-1'])
      expect(leaves[0].kind).toBe('terminal')
      expect((leaves[0] as any).createRequestId).toBe('req-1')
      expect(leaves[1].kind).toBe('terminal')
      expect((leaves[1] as any).createRequestId).toBe('req-2')
      expect(leaves[2].kind).toBe('terminal')
      expect((leaves[2] as any).createRequestId).toBe('req-3')

      // Check IDs are preserved
      function findLeafById(node: PaneNode, id: string): PaneNode | null {
        if (node.type === 'leaf') return node.id === id ? node : null
        return findLeafById(node.children[0], id) || findLeafById(node.children[1], id)
      }

      expect(findLeafById(state.layouts['tab-1'], pane1Id)).not.toBeNull()
      expect(findLeafById(state.layouts['tab-1'], pane2Id)).not.toBeNull()
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
      expect(result.paneTitles['tab-1'][newPaneId]).toBe('Claude')
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
      expect(result.paneTitles['tab-1'][newPaneId]).toBe('Codex')
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
})
