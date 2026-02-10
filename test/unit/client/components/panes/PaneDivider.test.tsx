import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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
    it('renders horizontal divider with col-resize cursor and 12px hit area', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      expect(divider.className).toContain('cursor-col-resize')
      expect(divider.className).toContain('w-3')
    })

    it('renders vertical divider with row-resize cursor and 12px hit area', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      expect(divider.className).toContain('cursor-row-resize')
      expect(divider.className).toContain('h-3')
    })

    it('renders a centered visible bar inside the hit area', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const visibleBar = divider.querySelector('[data-visible-bar]')
      expect(visibleBar).toBeInTheDocument()
      expect(visibleBar!.className).toContain('absolute')
      expect(visibleBar!.className).toContain('bg-border')
    })

    it('renders horizontal visible bar as a 1px wide line', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const visibleBar = divider.querySelector('[data-visible-bar]')
      expect(visibleBar!.className).toContain('w-px')
      expect(visibleBar!.className).toContain('h-full')
    })

    it('renders vertical visible bar as a 1px tall line', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const visibleBar = divider.querySelector('[data-visible-bar]')
      expect(visibleBar!.className).toContain('h-px')
      expect(visibleBar!.className).toContain('w-full')
    })

    it('has separator role with correct aria-orientation', () => {
      const { rerender } = render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical')

      rerender(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      // Note: a vertical divider splits content top/bottom, so aria-orientation is horizontal
      expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal')
    })

    it('shows grab indicator with data-grab-handle attribute', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const grabHandle = divider.querySelector('[data-grab-handle]')
      expect(grabHandle).toBeInTheDocument()
    })

    it('renders three grab dots for horizontal divider in a column', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const grabHandle = divider.querySelector('[data-grab-handle]')
      // The dots container should use flex-col for horizontal (vertical column of dots)
      const dotsContainer = grabHandle!.firstChild as HTMLElement
      expect(dotsContainer.className).toContain('flex-col')
      // Should have 3 dot children
      expect(dotsContainer.children).toHaveLength(3)
    })

    it('renders three grab dots for vertical divider in a row', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const grabHandle = divider.querySelector('[data-grab-handle]')
      // The dots container should use flex-row for vertical (horizontal row of dots)
      const dotsContainer = grabHandle!.firstChild as HTMLElement
      expect(dotsContainer.className).toContain('flex-row')
      expect(dotsContainer.children).toHaveLength(3)
    })

    it('passes data attributes to divider element', () => {
      render(
        <PaneDivider
          direction="horizontal"
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          dataContext="test-context"
          dataTabId="tab-1"
          dataSplitId="split-1"
        />
      )
      const divider = screen.getByRole('separator')
      expect(divider).toHaveAttribute('data-context', 'test-context')
      expect(divider).toHaveAttribute('data-tab-id', 'tab-1')
      expect(divider).toHaveAttribute('data-split-id', 'split-1')
    })
  })

  describe('mouse drag interaction', () => {
    it('calls onResize with delta during horizontal mouse drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Start drag at x=100
      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // Move to x=150 (delta = 50)
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 })
      expect(onResize).toHaveBeenCalledWith(50, false)

      // Move to x=200 (delta = 50 from 150)
      fireEvent.mouseMove(document, { clientX: 200, clientY: 50 })
      expect(onResize).toHaveBeenCalledWith(50, false)

      // End drag
      fireEvent.mouseUp(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('calls onResize with delta during vertical mouse drag', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Start drag at y=100
      fireEvent.mouseDown(divider, { clientX: 50, clientY: 100 })

      // Move to y=180 (delta = 80)
      fireEvent.mouseMove(document, { clientX: 50, clientY: 180 })
      expect(onResize).toHaveBeenCalledWith(80, false)

      // End drag
      fireEvent.mouseUp(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('highlights visible bar during mouse drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const visibleBar = divider.querySelector('[data-visible-bar]') as HTMLElement

      // Before drag: visible bar has bg-border but not a direct bg-muted-foreground class
      // (group-hover:bg-muted-foreground is present, but not the direct class)
      const classesBefore = visibleBar.className.split(' ')
      expect(classesBefore).toContain('bg-border')
      expect(classesBefore).not.toContain('bg-muted-foreground')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // During drag: direct bg-muted-foreground class should be added
      const classesDuring = visibleBar.className.split(' ')
      expect(classesDuring).toContain('bg-muted-foreground')

      fireEvent.mouseUp(document)

      // After drag: direct class removed (only group-hover variant remains)
      const classesAfter = visibleBar.className.split(' ')
      expect(classesAfter).not.toContain('bg-muted-foreground')
    })

    it('widens visible bar to 3px during mouse drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const visibleBar = divider.querySelector('[data-visible-bar]') as HTMLElement

      // Before drag: 1px width (only group-hover:w-[3px], not direct w-[3px])
      const classesBefore = visibleBar.className.split(' ')
      expect(classesBefore).toContain('w-px')
      expect(classesBefore).not.toContain('w-[3px]')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // During drag: direct w-[3px] class added
      const classesDuring = visibleBar.className.split(' ')
      expect(classesDuring).toContain('w-[3px]')

      fireEvent.mouseUp(document)

      // After drag: direct class removed
      const classesAfter = visibleBar.className.split(' ')
      expect(classesAfter).not.toContain('w-[3px]')
    })

    it('shows grab dots during mouse drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const grabHandle = divider.querySelector('[data-grab-handle]') as HTMLElement

      // Before drag: dots are hidden (opacity-0, only group-hover:opacity-40)
      const classesBefore = grabHandle.className.split(' ')
      expect(classesBefore).toContain('opacity-0')
      expect(classesBefore).not.toContain('opacity-40')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // During drag: direct opacity-40 class applied
      const classesDuring = grabHandle.className.split(' ')
      expect(classesDuring).toContain('opacity-40')

      fireEvent.mouseUp(document)

      // After drag: direct opacity-40 removed
      const classesAfter = grabHandle.className.split(' ')
      expect(classesAfter).not.toContain('opacity-40')
    })
  })

  describe('touch drag interaction', () => {
    it('calls onResize with delta during horizontal touch drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Start touch at x=100
      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      // Move to x=150 (delta = 50)
      fireEvent.touchMove(document, {
        touches: [{ clientX: 150, clientY: 50 }],
      })
      expect(onResize).toHaveBeenCalledWith(50, false)

      // Move to x=200 (delta = 50 from 150)
      fireEvent.touchMove(document, {
        touches: [{ clientX: 200, clientY: 50 }],
      })
      expect(onResize).toHaveBeenCalledWith(50, false)

      // End touch
      fireEvent.touchEnd(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('calls onResize with delta during vertical touch drag', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Start touch at y=100
      fireEvent.touchStart(divider, {
        touches: [{ clientX: 50, clientY: 100 }],
      })

      // Move to y=180 (delta = 80)
      fireEvent.touchMove(document, {
        touches: [{ clientX: 50, clientY: 180 }],
      })
      expect(onResize).toHaveBeenCalledWith(80, false)

      // End touch
      fireEvent.touchEnd(document)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('highlights visible bar during touch drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')
      const visibleBar = divider.querySelector('[data-visible-bar]') as HTMLElement

      // Before drag: no direct bg-muted-foreground class
      const classesBefore = visibleBar.className.split(' ')
      expect(classesBefore).not.toContain('bg-muted-foreground')

      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      // During drag: highlighted with direct class
      const classesDuring = visibleBar.className.split(' ')
      expect(classesDuring).toContain('bg-muted-foreground')

      fireEvent.touchEnd(document)

      // After drag: direct class removed
      const classesAfter = visibleBar.className.split(' ')
      expect(classesAfter).not.toContain('bg-muted-foreground')
    })

    it('prevents default touch behavior to avoid scrolling', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

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

  describe('keyboard interaction', () => {
    it('resizes on arrow key press for horizontal divider', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      fireEvent.keyDown(divider, { key: 'ArrowRight' })
      expect(onResize).toHaveBeenCalledWith(10)
      expect(onResizeEnd).toHaveBeenCalled()

      onResize.mockClear()
      onResizeEnd.mockClear()

      fireEvent.keyDown(divider, { key: 'ArrowLeft' })
      expect(onResize).toHaveBeenCalledWith(-10)
      expect(onResizeEnd).toHaveBeenCalled()
    })

    it('resizes on arrow key press for vertical divider', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      fireEvent.keyDown(divider, { key: 'ArrowDown' })
      expect(onResize).toHaveBeenCalledWith(10)
      expect(onResizeEnd).toHaveBeenCalled()

      onResize.mockClear()
      onResizeEnd.mockClear()

      fireEvent.keyDown(divider, { key: 'ArrowUp' })
      expect(onResize).toHaveBeenCalledWith(-10)
      expect(onResizeEnd).toHaveBeenCalled()
    })
  })

  describe('snap integration', () => {
    it('calls onResizeStart on mouse drag begin', () => {
      const onResizeStart = vi.fn()
      render(
        <PaneDivider
          direction="horizontal"
          onResize={onResize}
          onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd}
        />
      )
      const divider = screen.getByRole('separator')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })
      expect(onResizeStart).toHaveBeenCalledOnce()

      fireEvent.mouseUp(document)
    })

    it('calls onResizeStart on touch drag begin', () => {
      const onResizeStart = vi.fn()
      render(
        <PaneDivider
          direction="horizontal"
          onResize={onResize}
          onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd}
        />
      )
      const divider = screen.getByRole('separator')

      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })
      expect(onResizeStart).toHaveBeenCalledOnce()

      fireEvent.touchEnd(document)
    })

    it('forwards shiftKey=true during mouse drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50, shiftKey: true })
      expect(onResize).toHaveBeenCalledWith(50, true)

      fireEvent.mouseUp(document)
    })

    it('works without onResizeStart prop', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Should not throw when onResizeStart is not provided
      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 })
      expect(onResize).toHaveBeenCalledWith(50, false)

      fireEvent.mouseUp(document)
    })
  })

  describe('cursor locking during drag', () => {
    afterEach(() => {
      // Clean up any leaked style tags
      document.querySelectorAll('style[data-drag-cursor]').forEach((el) => el.remove())
    })

    it('locks cursor to col-resize during horizontal mouse drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      const style = document.querySelector('style[data-drag-cursor]')
      expect(style).toBeInTheDocument()
      expect(style!.textContent).toContain('col-resize')

      fireEvent.mouseUp(document)

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()
    })

    it('locks cursor to row-resize during vertical mouse drag', () => {
      render(
        <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      fireEvent.mouseDown(divider, { clientX: 50, clientY: 100 })

      const style = document.querySelector('style[data-drag-cursor]')
      expect(style).toBeInTheDocument()
      expect(style!.textContent).toContain('row-resize')

      fireEvent.mouseUp(document)

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()
    })

    it('locks cursor during touch drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      expect(document.querySelector('style[data-drag-cursor]')).toBeInTheDocument()

      fireEvent.touchEnd(document)

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()
    })

    it('cleans up cursor lock on unmount during drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })
      expect(document.querySelector('style[data-drag-cursor]')).toBeInTheDocument()

      cleanup()

      expect(document.querySelector('style[data-drag-cursor]')).not.toBeInTheDocument()
    })
  })

  describe('event listener cleanup', () => {
    it('removes mouse event listeners when component unmounts during drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Start drag
      fireEvent.mouseDown(divider, { clientX: 100, clientY: 50 })

      // Unmount during drag
      cleanup()

      // These should not throw or cause issues
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 })
      fireEvent.mouseUp(document)

      // onResize should not have been called after unmount
      expect(onResize).not.toHaveBeenCalled()
    })

    it('removes touch event listeners when component unmounts during drag', () => {
      render(
        <PaneDivider direction="horizontal" onResize={onResize} onResizeEnd={onResizeEnd} />
      )
      const divider = screen.getByRole('separator')

      // Start touch
      fireEvent.touchStart(divider, {
        touches: [{ clientX: 100, clientY: 50 }],
      })

      // Unmount during drag
      cleanup()

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
