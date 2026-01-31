import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import EditorToolbar from '@/components/panes/EditorToolbar'

describe('EditorToolbar', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders path input', () => {
    render(
      <EditorToolbar
        filePath=""
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
  })

  it('renders file picker button', () => {
    render(
      <EditorToolbar
        filePath=""
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument()
  })

  it('calls onPathChange when Enter is pressed', () => {
    const onPathChange = vi.fn()

    render(
      <EditorToolbar
        filePath=""
        onPathChange={onPathChange}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    const input = screen.getByPlaceholderText(/enter file path/i)
    fireEvent.change(input, { target: { value: '/path/to/file.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onPathChange).toHaveBeenCalledWith('/path/to/file.ts')
  })

  it('shows view toggle only when showViewToggle is true', () => {
    const { rerender } = render(
      <EditorToolbar
        filePath="/test.md"
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={false}
      />
    )

    expect(screen.queryByRole('button', { name: /preview|source/i })).not.toBeInTheDocument()

    rerender(
      <EditorToolbar
        filePath="/test.md"
        onPathChange={vi.fn()}
        onOpenFile={vi.fn()}
        viewMode="source"
        onViewModeToggle={vi.fn()}
        showViewToggle={true}
      />
    )

    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
  })
})
