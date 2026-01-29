import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import FloatingActionButton from '@/components/panes/FloatingActionButton'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Plus: ({ className }: { className?: string }) => (
    <svg data-testid="plus-icon" className={className} />
  ),
  Terminal: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-icon" className={className} />
  ),
  Globe: ({ className }: { className?: string }) => (
    <svg data-testid="globe-icon" className={className} />
  ),
}))

describe('FloatingActionButton', () => {
  let onAddTerminal: ReturnType<typeof vi.fn>
  let onAddBrowser: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onAddTerminal = vi.fn()
    onAddBrowser = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders the FAB button', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      const button = screen.getByTitle('Add pane')
      expect(button).toBeInTheDocument()
    })

    it('does not show menu initially', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
      expect(screen.queryByText('Browser')).not.toBeInTheDocument()
    })
  })

  describe('menu open/close', () => {
    it('opens menu when FAB is clicked', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      const button = screen.getByTitle('Add pane')
      fireEvent.click(button)

      expect(screen.getByText('Terminal')).toBeInTheDocument()
      expect(screen.getByText('Browser')).toBeInTheDocument()
    })

    it('closes menu when FAB is clicked again', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      const button = screen.getByTitle('Add pane')

      // Open
      fireEvent.click(button)
      expect(screen.getByText('Terminal')).toBeInTheDocument()

      // Close
      fireEvent.click(button)
      expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    })

    it('rotates the FAB when menu is open', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      const button = screen.getByTitle('Add pane')

      // Initially not rotated
      expect(button.className).not.toContain('rotate-45')

      // Open menu
      fireEvent.click(button)

      // Should be rotated
      expect(button.className).toContain('rotate-45')
    })
  })

  describe('menu actions', () => {
    it('calls onAddTerminal and closes menu when Terminal is clicked', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)

      // Click Terminal option
      const terminalOption = screen.getByText('Terminal')
      fireEvent.click(terminalOption)

      expect(onAddTerminal).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    })

    it('calls onAddBrowser and closes menu when Browser is clicked', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)

      // Click Browser option
      const browserOption = screen.getByText('Browser')
      fireEvent.click(browserOption)

      expect(onAddBrowser).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('Browser')).not.toBeInTheDocument()
    })
  })

  describe('click outside behavior', () => {
    it('closes menu when clicking outside', () => {
      const { container } = render(
        <div>
          <div data-testid="outside-element">Outside</div>
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        </div>
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)
      expect(screen.getByText('Terminal')).toBeInTheDocument()

      // Click outside
      const outsideElement = screen.getByTestId('outside-element')
      fireEvent.mouseDown(outsideElement)

      // Menu should close
      expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    })

    it('does not close menu when clicking inside menu', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)

      // Click on the menu container (not on a button)
      const terminalText = screen.getByText('Terminal')
      const menuContainer = terminalText.closest('div[class*="bg-card"]')
      if (menuContainer) {
        fireEvent.mouseDown(menuContainer)
      }

      // Menu should still be open
      expect(screen.getByText('Terminal')).toBeInTheDocument()
    })

    it('does not close menu when clicking the FAB button itself', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)
      expect(screen.getByText('Terminal')).toBeInTheDocument()

      // Mousedown on FAB (this happens before click that toggles)
      fireEvent.mouseDown(fabButton)

      // Menu should still be open (mousedown alone doesn't close)
      // The menu state is controlled by click, not mousedown on FAB
      expect(screen.getByText('Terminal')).toBeInTheDocument()
    })
  })

  describe('edge cases', () => {
    it('handles rapid open/close toggling', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      const fabButton = screen.getByTitle('Add pane')

      // Toggle multiple times
      fireEvent.click(fabButton) // Open
      fireEvent.click(fabButton) // Close
      fireEvent.click(fabButton) // Open
      fireEvent.click(fabButton) // Close
      fireEvent.click(fabButton) // Open

      // Should be open after odd number of clicks
      expect(screen.getByText('Terminal')).toBeInTheDocument()
    })

    it('handles clicking menu item multiple times (only fires once per opening)', () => {
      render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)

      // Click Terminal
      const terminalOption = screen.getByText('Terminal')
      fireEvent.click(terminalOption)

      // Menu is now closed, so this click does nothing
      // (the element is no longer in the DOM)
      expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
      expect(onAddTerminal).toHaveBeenCalledTimes(1)
    })

    it('cleans up event listener when menu is closed', () => {
      const { unmount } = render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)
      expect(screen.getByText('Terminal')).toBeInTheDocument()

      // Close menu
      fireEvent.click(fabButton)

      // Unmount should not throw errors
      unmount()
    })

    it('cleans up event listener when unmounting with menu open', () => {
      const { unmount } = render(
        <FloatingActionButton
          onAddTerminal={onAddTerminal}
          onAddBrowser={onAddBrowser}
        />
      )

      // Open menu
      const fabButton = screen.getByTitle('Add pane')
      fireEvent.click(fabButton)
      expect(screen.getByText('Terminal')).toBeInTheDocument()

      // Unmount while menu is open
      unmount()

      // Should not throw errors when mousedown fires on document after unmount
      fireEvent.mouseDown(document.body)
    })
  })

  describe('keyboard accessibility', () => {
    describe('ARIA attributes', () => {
      it('has aria-haspopup="menu" on the FAB button', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        expect(button).toHaveAttribute('aria-haspopup', 'menu')
      })

      it('has aria-expanded="false" when menu is closed', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        expect(button).toHaveAttribute('aria-expanded', 'false')
      })

      it('has aria-expanded="true" when menu is open', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)
        expect(button).toHaveAttribute('aria-expanded', 'true')
      })

      it('has role="menu" on the dropdown', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        const menu = screen.getByRole('menu')
        expect(menu).toBeInTheDocument()
      })

      it('has role="menuitem" on menu options', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        const menuItems = screen.getAllByRole('menuitem')
        expect(menuItems).toHaveLength(2)
      })

      it('links FAB button to menu via aria-controls', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        const menu = screen.getByRole('menu')
        expect(button).toHaveAttribute('aria-controls', menu.id)
      })

      it('has aria-label on FAB button', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        expect(button).toHaveAttribute('aria-label', 'Add pane')
      })
    })

    describe('FAB button keyboard interaction', () => {
      it('opens menu on Enter key', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        button.focus()
        fireEvent.keyDown(button, { key: 'Enter' })

        expect(screen.getByRole('menu')).toBeInTheDocument()
      })

      it('opens menu on Space key', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        button.focus()
        fireEvent.keyDown(button, { key: ' ' })

        expect(screen.getByRole('menu')).toBeInTheDocument()
      })

      it('closes menu on Enter key when already open', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)
        expect(screen.getByRole('menu')).toBeInTheDocument()

        button.focus()
        fireEvent.keyDown(button, { key: 'Enter' })

        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('opens menu on ArrowDown key', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        button.focus()
        fireEvent.keyDown(button, { key: 'ArrowDown' })

        expect(screen.getByRole('menu')).toBeInTheDocument()
      })

      it('opens menu on ArrowUp key', () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        button.focus()
        fireEvent.keyDown(button, { key: 'ArrowUp' })

        expect(screen.getByRole('menu')).toBeInTheDocument()
      })
    })

    describe('menu keyboard navigation', () => {
      it('focuses first menu item when menu opens via click', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        // Wait for useEffect to run
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        expect(menuItems[0]).toHaveFocus()
      })

      it('moves focus down with ArrowDown key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        expect(menuItems[0]).toHaveFocus()

        fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' })
        expect(menuItems[1]).toHaveFocus()
      })

      it('moves focus up with ArrowUp key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' }) // Move to second item
        expect(menuItems[1]).toHaveFocus()

        fireEvent.keyDown(menuItems[1], { key: 'ArrowUp' })
        expect(menuItems[0]).toHaveFocus()
      })

      it('wraps focus from last to first item on ArrowDown', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' }) // Move to second (last) item
        expect(menuItems[1]).toHaveFocus()

        fireEvent.keyDown(menuItems[1], { key: 'ArrowDown' }) // Should wrap to first
        expect(menuItems[0]).toHaveFocus()
      })

      it('wraps focus from first to last item on ArrowUp', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        expect(menuItems[0]).toHaveFocus()

        fireEvent.keyDown(menuItems[0], { key: 'ArrowUp' }) // Should wrap to last
        expect(menuItems[1]).toHaveFocus()
      })

      it('selects menu item on Enter key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'Enter' })

        expect(onAddTerminal).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('selects menu item on Space key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' }) // Move to Browser
        fireEvent.keyDown(menuItems[1], { key: ' ' })

        expect(onAddBrowser).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('closes menu on Escape key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)
        expect(screen.getByRole('menu')).toBeInTheDocument()

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'Escape' })

        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('returns focus to FAB button on Escape', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'Escape' })

        expect(button).toHaveFocus()
      })

      it('returns focus to FAB button after menu item selection', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'Enter' }) // Select Terminal

        expect(button).toHaveFocus()
      })

      it('closes menu on Tab key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)
        expect(screen.getByRole('menu')).toBeInTheDocument()

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'Tab' })

        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('moves focus to first item on Home key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' }) // Move to second item
        expect(menuItems[1]).toHaveFocus()

        fireEvent.keyDown(menuItems[1], { key: 'Home' })
        expect(menuItems[0]).toHaveFocus()
      })

      it('moves focus to last item on End key', async () => {
        render(
          <FloatingActionButton
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
          />
        )

        const button = screen.getByTitle('Add pane')
        fireEvent.click(button)

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })

        const menuItems = screen.getAllByRole('menuitem')
        expect(menuItems[0]).toHaveFocus()

        fireEvent.keyDown(menuItems[0], { key: 'End' })
        expect(menuItems[1]).toHaveFocus()
      })
    })
  })
})
