import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ContextMenu } from '@/components/context-menu/ContextMenu'

afterEach(() => cleanup())

describe('ContextMenu mobile touch targets', () => {
  it('menu items have mobile-first padding (py-3 px-4) and desktop overrides (md:py-2 md:px-3)', () => {
    render(
      <ContextMenu
        open={true}
        position={{ x: 100, y: 100 }}
        onClose={() => {}}
        items={[
          { type: 'item', id: 'test', label: 'Test Item', onSelect: () => {} },
        ]}
      />
    )

    const menuItem = screen.getByRole('menuitem', { name: 'Test Item' })
    expect(menuItem.className).toMatch(/py-3/)
    expect(menuItem.className).toMatch(/md:py-2/)
    expect(menuItem.className).toMatch(/px-4/)
    expect(menuItem.className).toMatch(/md:px-3/)
  })
})
