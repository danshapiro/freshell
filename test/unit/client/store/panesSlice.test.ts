import { describe, it, expect, vi, beforeEach } from 'vitest'
import panesReducer, {
  initLayout,
  splitPane,
  closePane,
  setActivePane,
  resizePanes,
  updatePaneContent,
  removeLayout,
  hydratePanes,
  PanesState,
} from '../../../../src/store/panesSlice'
import type { PaneNode, PaneContent } from '../../../../src/store/paneTypes'

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
    }
    mockIdCounter = 0
    vi.clearAllMocks()
  })

  describe('initLayout', () => {
    it('creates a single-pane layout for a tab', () => {
      const content: PaneContent = { kind: 'terminal', mode: 'shell' }
      const state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content })
      )

      expect(state.layouts['tab-1']).toBeDefined()
      expect(state.layouts['tab-1'].type).toBe('leaf')
      const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content).toEqual(content)
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
      const content1: PaneContent = { kind: 'terminal', mode: 'shell' }
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
      expect(leaf1.content).toEqual(content1)
      expect(leaf2.content).toEqual(content2)
    })
  })

  describe('splitPane', () => {
    it('converts a leaf pane into a horizontal split with two children', () => {
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

      const root = state.layouts['tab-1']
      expect(root.type).toBe('split')
      const split = root as Extract<PaneNode, { type: 'split' }>
      expect(split.direction).toBe('horizontal')
      expect(split.children).toHaveLength(2)
      expect(split.sizes).toEqual([50, 50])

      const [first, second] = split.children
      expect(first.type).toBe('leaf')
      expect(second.type).toBe('leaf')
      expect((first as Extract<PaneNode, { type: 'leaf' }>).content).toEqual(content1)
      expect((second as Extract<PaneNode, { type: 'leaf' }>).content).toEqual(content2)
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

      // Close the second pane
      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId: pane2Id }))

      // Should collapse back to a single leaf
      const remaining = state.layouts['tab-1']
      expect(remaining.type).toBe('leaf')
      expect((remaining as Extract<PaneNode, { type: 'leaf' }>).id).toBe(pane1Id)
      expect((remaining as Extract<PaneNode, { type: 'leaf' }>).content).toEqual(content1)
    })

    it('collapses to the other pane when the first child is closed', () => {
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

      // Close the first pane
      state = panesReducer(state, closePane({ tabId: 'tab-1', paneId: pane1Id }))

      // Should collapse to the second pane
      const remaining = state.layouts['tab-1']
      expect(remaining.type).toBe('leaf')
      expect((remaining as Extract<PaneNode, { type: 'leaf' }>).content).toEqual(content2)
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
      }

      const state = panesReducer(initialState, hydratePanes(savedState))

      expect(state).toEqual(savedState)
    })

    it('handles empty saved state', () => {
      const savedState: PanesState = {
        layouts: {},
        activePane: {},
      }

      const state = panesReducer(initialState, hydratePanes(savedState))

      expect(state.layouts).toEqual({})
      expect(state.activePane).toEqual({})
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
  })
})
