import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import IntersectionDragOverlay from '@/components/panes/IntersectionDragOverlay'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import type { PanesState } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'

function createStore(initialPanesState: Partial<PanesState> = {}) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        ...initialPanesState,
      },
    },
  })
}

function renderWithStore(
  ui: React.ReactElement,
  store: ReturnType<typeof createStore>,
) {
  return render(<Provider store={store}>{ui}</Provider>)
}

/** Create a 2x2 grid layout: V-split(H-split(A, B), H-split(C, D)) */
function create2x2Grid(): PaneNode {
  return {
    type: 'split',
    id: 'v1',
    direction: 'vertical',
    sizes: [50, 50],
    children: [
      {
        type: 'split',
        id: 'h1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'a', content: { kind: 'picker' } },
          { type: 'leaf', id: 'b', content: { kind: 'picker' } },
        ],
      },
      {
        type: 'split',
        id: 'h2',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'c', content: { kind: 'picker' } },
          { type: 'leaf', id: 'd', content: { kind: 'picker' } },
        ],
      },
    ],
  }
}

/** Create a container ref mock with dimensions */
function createContainerRef(width: number, height: number) {
  const div = document.createElement('div')
  Object.defineProperty(div, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(div, 'offsetHeight', { value: height, configurable: true })
  return { current: div }
}

describe('IntersectionDragOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders nothing when layout is a leaf', () => {
      const store = createStore({
        layouts: {
          'tab-1': { type: 'leaf', id: 'a', content: { kind: 'picker' } },
        },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      expect(screen.queryByTestId('intersection-drag-overlay')).not.toBeInTheDocument()
    })

    it('renders nothing for a single split (no intersections)', () => {
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'split',
            id: 's1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'a', content: { kind: 'picker' } },
              { type: 'leaf', id: 'b', content: { kind: 'picker' } },
            ],
          },
        },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      // Single split has no intersections
      expect(screen.queryByTestId('intersection-drag-overlay')).not.toBeInTheDocument()
    })

    it('renders hot zone at intersection in 2x2 grid', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const overlay = screen.getByTestId('intersection-drag-overlay')
      expect(overlay).toBeInTheDocument()

      // 2x2 grid: V-split horizontal bar at Y=300, two H-split vertical bars at X=400
      // Both H-split bars meet the V-split bar at (400, 300)
      const hotzone = screen.getByTestId('intersection-hotzone-400,300')
      expect(hotzone).toBeInTheDocument()

      // Verify position and size
      expect(hotzone.style.left).toBe(`${400 - 12}px`)
      expect(hotzone.style.top).toBe(`${300 - 12}px`)
      expect(hotzone.style.width).toBe('24px')
      expect(hotzone.style.height).toBe('24px')
    })

    it('hot zones have correct cursor and pointer-events', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const hotzone = screen.getByTestId('intersection-hotzone-400,300')
      expect(hotzone.className).toContain('cursor-move')
      expect(hotzone.className).toContain('pointer-events-auto')
    })

    it('overlay container is pointer-events-none', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const overlay = screen.getByTestId('intersection-drag-overlay')
      expect(overlay.className).toContain('pointer-events-none')
    })

    it('hot zones are hidden from assistive technology', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const hotzone = screen.getByTestId('intersection-hotzone-400,300')
      expect(hotzone).toHaveAttribute('aria-hidden', 'true')
      // Should not be in the tab order (no tabIndex or tabIndex=-1)
      expect(hotzone.tabIndex).toBe(-1)
      // Should not have a role that exposes it to screen readers
      expect(hotzone).not.toHaveAttribute('role')
    })
  })

  describe('dragging', () => {
    it('dispatches resizeMultipleSplits on drag', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const hotzone = screen.getByTestId('intersection-hotzone-400,300')

      // Start drag
      fireEvent.mouseDown(hotzone, { clientX: 400, clientY: 300 })

      // Move: 80px right, 60px down
      fireEvent.mouseMove(document, { clientX: 480, clientY: 360 })

      // Check that sizes changed
      const state = store.getState().panes
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>

      // The V-split (root) should have its sizes changed based on Y delta
      // The H-splits should have their sizes changed based on X delta
      // Original: all [50, 50]
      // After moving right 80px on 800px-wide horizontal splits: +10%
      // After moving down 60px on 600px-high vertical split: +10%
      expect(root.sizes[0]).not.toBe(50) // V-split changed
    })

    it('stops dragging on mouseup', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const hotzone = screen.getByTestId('intersection-hotzone-400,300')

      // Start drag
      fireEvent.mouseDown(hotzone, { clientX: 400, clientY: 300 })

      // Move
      fireEvent.mouseMove(document, { clientX: 480, clientY: 360 })

      // End drag
      fireEvent.mouseUp(document)

      // Capture sizes after mouseup
      const stateAfterUp = store.getState().panes
      const rootAfterUp = stateAfterUp.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const sizesAfterUp = [...rootAfterUp.sizes]

      // Move again - should not change sizes
      fireEvent.mouseMove(document, { clientX: 560, clientY: 420 })

      const stateAfterMore = store.getState().panes
      const rootAfterMore = stateAfterMore.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(rootAfterMore.sizes).toEqual(sizesAfterUp)
    })

    it('locks cursor to move during drag', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const hotzone = screen.getByTestId('intersection-hotzone-400,300')

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()

      fireEvent.mouseDown(hotzone, { clientX: 400, clientY: 300 })

      const style = document.querySelector('style[data-drag-cursor]')
      expect(style).toBeInTheDocument()
      expect(style!.textContent).toContain('move')

      fireEvent.mouseUp(document)

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()
    })

    it('clamps sizes to min 10 max 90', () => {
      const store = createStore({
        layouts: { 'tab-1': create2x2Grid() },
      })
      const containerRef = createContainerRef(800, 600)

      renderWithStore(
        <IntersectionDragOverlay tabId="tab-1" containerRef={containerRef} />,
        store,
      )

      const hotzone = screen.getByTestId('intersection-hotzone-400,300')

      // Start drag
      fireEvent.mouseDown(hotzone, { clientX: 400, clientY: 300 })

      // Move far right (way beyond 90%)
      fireEvent.mouseMove(document, { clientX: 1200, clientY: 300 })

      const state = store.getState().panes
      const root = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      const h1 = root.children[0] as Extract<PaneNode, { type: 'split' }>
      expect(h1.sizes[0]).toBeLessThanOrEqual(90)
    })
  })
})
