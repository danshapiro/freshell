import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import PaneDivider from '@/components/panes/PaneDivider'

describe('PaneDivider', () => {
  let onResize: ReturnType<typeof vi.fn>
  let onResizeEnd: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onResize = vi.fn()
    onResizeEnd = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders horizontal divider with col-resize cursor', () => {
      const { container } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement
      expect(divider.className).toContain('cursor-col-resize')
      expect(divider.className).toContain('w-1')
    })

    it('renders vertical divider with row-resize cursor', () => {
      const { container } = render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement
      expect(divider.className).toContain('cursor-row-resize')
      expect(divider.className).toContain('h-1')
    })
  })

  describe('mouse drag interaction', () => {
    it('calls onResize with delta during horizontal mouse drag', () => {
      const { container } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start drag at x=100
      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // Move to x=150 (delta = 50)
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 })
      expect(onResize).toHaveBeenCalledWith(50)

      // Move to x=200 (delta = 50 from 150)
      fireEvent.mouseMove(document, { clientX: 200, clientY: 50 })
      expect(onResize).toHaveBeenCalledWith(50)

      // End drag
      fireEvent.mouseUp(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('calls onResize with delta during vertical mouse drag', () => {
      const { container } = render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start drag at y=100
      fireEvent.mouseDown(divider, { clientX: 50, clientY: 100 })

      // Move to y=180 (delta = 80)
      fireEvent.mouseMove(document, { clientX: 50, clientY: 180 })
      expect(onResize).toHaveBeenCalledWith(80)

      // End drag
      fireEvent.mouseUp(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('adds dragging style during mouse drag', () => {
      const { container } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Check that only hover variant is present, not the direct class
      const classesBeforeDrag = divider.className.split(' ')
      expect(classesBeforeDrag).not.toContain('bg-muted-foreground')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // Direct class should be added during drag
      const classesWhileDragging = divider.className.split(' ')
      expect(classesWhileDragging).toContain('bg-muted-foreground')

      fireEvent.mouseUp(document)

      // Direct class should be removed after drag ends
      const classesAfterDrag = divider.className.split(' ')
      expect(classesAfterDrag).not.toContain('bg-muted-foreground')
    })
  })

  describe('touch drag interaction', () => {
    it('calls onResize with delta during horizontal touch drag', () => {
      const { container } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start touch at x=100
      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      // Move to x=150 (delta = 50)
      fireEvent.touchMove(document, {
        touches: [{ clientX: 150, clientY: 50 }],
      })
      expect(onResize).toHaveBeenCalledWith(50)

      // Move to x=200 (delta = 50 from 150)
      fireEvent.touchMove(document, {
        touches: [{ clientX: 200, clientY: 50 }],
      })
      expect(onResize).toHaveBeenCalledWith(50)

      // End touch
      fireEvent.touchEnd(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('calls onResize with delta during vertical touch drag', () => {
      const { container } = render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start touch at y=100
      fireEvent.touchStart(divider, {
        touches: [{ clientX: 50, clientY: 100 }],
      })

      // Move to y=180 (delta = 80)
      fireEvent.touchMove(document, {
        touches: [{ clientX: 50, clientY: 180 }],
      })
      expect(onResize).toHaveBeenCalledWith(80)

      // End touch
      fireEvent.touchEnd(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('adds dragging style during touch drag', () => {
      const { container } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Check that only hover variant is present, not the direct class
      const classesBeforeDrag = divider.className.split(' ')
      expect(classesBeforeDrag).not.toContain('bg-muted-foreground')

      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      // Direct class should be added during drag
      const classesWhileDragging = divider.className.split(' ')
      expect(classesWhileDragging).toContain('bg-muted-foreground')

      fireEvent.touchEnd(document)

      // Direct class should be removed after drag ends
      const classesAfterDrag = divider.className.split(' ')
      expect(classesAfterDrag).not.toContain('bg-muted-foreground')
    })

    it('prevents default touch behavior to avoid scrolling', () => {
      const { container } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start touch
      const touchStartEvent = new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientX: 100, clientY: 50 } as Touch],
      })
      const preventDefaultSpy = vi.spyOn(touchStartEvent, 'preventDefault')
      divider.dispatchEvent(touchStartEvent)
      expect(preventDefaultSpy).toHaveBeenCalled()
    })
  })

  describe('event listener cleanup', () => {
    it('removes mouse event listeners when component unmounts during drag', () => {
      const { container, unmount } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start drag
      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // Unmount during drag
      unmount()

      // These should not throw or cause issues
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 })
      fireEvent.mouseUp(document)

      // onResize should not have been called after unmount
      expect(onResize).not.toHaveBeenCalled()
    })

    it('removes touch event listeners when component unmounts during drag', () => {
      const { container, unmount } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = container.firstChild as HTMLElement

      // Start touch
      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      // Unmount during drag
      unmount()

      // These should not throw or cause issues
      fireEvent.touchMove(document, {
        touches: [{ clientX: 150, clientY: 50 }],
      })
      fireEvent.touchEnd(document)

      // onResize should not have been called after unmount
      expect(onResize).not.toHaveBeenCalled()
    })
  })
})
