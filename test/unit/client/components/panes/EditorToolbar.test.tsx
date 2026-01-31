import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import EditorToolbar from '@/components/panes/EditorToolbar'

const defaultProps = {
  filePath: '',
  onPathChange: vi.fn(),
  onPathSelect: vi.fn(),
  onOpenFilePicker: vi.fn(),
  suggestions: [],
  viewMode: 'source' as const,
  onViewModeToggle: vi.fn(),
  showViewToggle: false,
}

describe('EditorToolbar', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders path input', () => {
    render(<EditorToolbar {...defaultProps} />)

    expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
  })

  it('renders file picker button', () => {
    render(<EditorToolbar {...defaultProps} />)

    expect(screen.getByRole('button', { name: /open file picker/i })).toBeInTheDocument()
  })

  it('calls onPathSelect when Enter is pressed', () => {
    const onPathSelect = vi.fn()

    render(<EditorToolbar {...defaultProps} onPathSelect={onPathSelect} />)

    const input = screen.getByPlaceholderText(/enter file path/i)
    fireEvent.change(input, { target: { value: '/path/to/file.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onPathSelect).toHaveBeenCalledWith('/path/to/file.ts')
  })

  it('shows view toggle only when showViewToggle is true', () => {
    const { rerender } = render(<EditorToolbar {...defaultProps} filePath="/test.md" />)

    expect(screen.queryByRole('button', { name: /preview|source/i })).not.toBeInTheDocument()

    rerender(<EditorToolbar {...defaultProps} filePath="/test.md" showViewToggle={true} />)

    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
  })
})
