import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { ComponentProps } from 'react'
import DirectoryPicker from '@/components/panes/DirectoryPicker'

const { mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => mockApiGet(path),
    post: (path: string, body: unknown) => mockApiPost(path, body),
  },
}))

function renderDirectoryPicker(overrides: Partial<ComponentProps<typeof DirectoryPicker>> = {}) {
  const onConfirm = vi.fn()
  const onBack = vi.fn()
  render(
    <DirectoryPicker
      providerType="claude"
      providerLabel="Claude"
      defaultCwd="/home/user/project"
      onConfirm={onConfirm}
      onBack={onBack}
      {...overrides}
    />
  )
  return { onConfirm, onBack }
}

describe('DirectoryPicker', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiGet.mockResolvedValue({ directories: [] })
    mockApiPost.mockResolvedValue({ valid: true, resolvedPath: '/resolved/path' })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders with defaultCwd and selects input text on mount', async () => {
    renderDirectoryPicker({ defaultCwd: '/tmp/work' })

    const input = screen.getByLabelText('Starting directory for Claude') as HTMLInputElement
    expect(input.value).toBe('/tmp/work')

    await waitFor(() => {
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('/tmp/work'.length)
    })
  })

  it('shows fuzzy search suggestions ranked by score', async () => {
    mockApiGet.mockResolvedValueOnce({
      directories: [
        '/home/user/projects/foo-bar',
        '/home/user/projects/sidebar',
        '/home/user/projects/alpha',
      ],
    })
    renderDirectoryPicker({ defaultCwd: 'project' })

    const input = screen.getByLabelText('Starting directory for Claude')
    fireEvent.change(input, { target: { value: 'bar' } })

    const options = await screen.findAllByRole('option')
    expect(options[0]).toHaveTextContent('/home/user/projects/foo-bar')
    expect(options[1]).toHaveTextContent('/home/user/projects/sidebar')
  })

  it('switches to path completion mode and requests directory-only completions', async () => {
    mockApiGet
      .mockResolvedValueOnce({ directories: [] })
      .mockResolvedValueOnce({
        suggestions: [
          { path: '/workspace/apps', isDirectory: true },
        ],
      })

    renderDirectoryPicker({ defaultCwd: '' })
    const input = screen.getByLabelText('Starting directory for Claude')
    fireEvent.change(input, { target: { value: '/workspace/a' } })

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/api/files/complete?prefix=%2Fworkspace%2Fa&dirs=true')
    })

    expect(await screen.findByRole('option', { name: '/workspace/apps' })).toBeInTheDocument()
  })

  it('supports arrow navigation and tab autocomplete', async () => {
    mockApiGet.mockResolvedValueOnce({
      directories: ['/tmp/alpha', '/tmp/beta'],
    })

    renderDirectoryPicker({ defaultCwd: '' })
    const input = screen.getByLabelText('Starting directory for Claude')

    await screen.findByRole('option', { name: '/tmp/alpha' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })

    expect((input as HTMLInputElement).value).toBe('/tmp/beta')
  })

  it('validates and confirms directory on Enter', async () => {
    const { onConfirm } = renderDirectoryPicker()
    const input = screen.getByLabelText('Starting directory for Claude')

    fireEvent.change(input, { target: { value: '/tmp/selected' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/api/files/validate-dir', { path: '/tmp/selected' })
    })
    expect(onConfirm).toHaveBeenCalledWith('/resolved/path')
  })

  it('confirms typed input on Enter when no suggestion is actively selected', async () => {
    mockApiGet.mockResolvedValueOnce({
      directories: ['/home/user/project-a', '/home/user/project-b'],
    })

    renderDirectoryPicker({ defaultCwd: '' })
    const input = screen.getByLabelText('Starting directory for Claude')

    fireEvent.change(input, { target: { value: '/home/user/custom' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/api/files/validate-dir', { path: '/home/user/custom' })
    })
  })

  it('shows inline validation error when directory is invalid', async () => {
    mockApiPost.mockResolvedValueOnce({ valid: false })
    renderDirectoryPicker()
    const input = screen.getByLabelText('Starting directory for Claude')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('directory not found')).toBeInTheDocument()
  })

  it('shows sandbox validation error when path is blocked', async () => {
    mockApiPost.mockRejectedValueOnce({ status: 403, message: 'Path not allowed' })
    renderDirectoryPicker()
    const input = screen.getByLabelText('Starting directory for Claude')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('path not allowed')).toBeInTheDocument()
  })

  it('returns to pane picker on Escape', async () => {
    const { onBack } = renderDirectoryPicker()
    const input = screen.getByLabelText('Starting directory for Claude')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('exposes combobox/listbox accessibility attributes', async () => {
    mockApiGet.mockResolvedValueOnce({ directories: ['/tmp/alpha'] })
    renderDirectoryPicker({ defaultCwd: '' })

    const input = screen.getByRole('combobox', { name: 'Starting directory for Claude' })
    expect(input).toHaveAttribute('aria-controls')
    await waitFor(() => {
      expect(input).toHaveAttribute('aria-expanded', 'true')
    })

    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '/tmp/alpha' })).toBeInTheDocument()
  })

  it('keeps combobox collapsed when no suggestions are available', async () => {
    mockApiGet.mockResolvedValueOnce({ directories: [] })
    renderDirectoryPicker({ defaultCwd: '' })

    const input = screen.getByRole('combobox', { name: 'Starting directory for Claude' })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByText('No suggestions')).toBeInTheDocument()
  })

  describe('tab-aware candidate re-ranking', () => {
    it('renders candidates from API in original order without tab context', async () => {
      mockApiGet.mockResolvedValueOnce({
        directories: ['/code/gamma', '/code/alpha', '/code/beta'],
      })

      renderDirectoryPicker({ defaultCwd: '' })

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      const options = screen.getAllByRole('option')
      expect(options.map(o => o.textContent)).toEqual([
        '/code/gamma',
        '/code/alpha',
        '/code/beta',
      ])
    })

    it('boosts tab directories and global default above API candidates', async () => {
      mockApiGet.mockResolvedValueOnce({
        directories: ['/code/gamma', '/code/alpha', '/code/beta', '/code/delta'],
      })

      renderDirectoryPicker({
        defaultCwd: '',
        tabDirectories: ['/code/beta', '/code/alpha'],
        globalDefault: '/code/delta',
      })

      await waitFor(() => {
        const options = screen.getAllByRole('option')
        expect(options.length).toBeGreaterThanOrEqual(4)
      })

      const options = screen.getAllByRole('option')
      // Tab dirs first (in provided order), then global default, then rest
      expect(options.map(o => o.textContent)).toEqual([
        '/code/beta',
        '/code/alpha',
        '/code/delta',
        '/code/gamma',
      ])
    })

    it('pre-fills input with tab-preferred defaultCwd', () => {
      mockApiGet.mockResolvedValueOnce({ directories: [] })

      renderDirectoryPicker({ defaultCwd: '/code/tab-preferred' })

      const input = screen.getByRole('combobox')
      expect(input).toHaveValue('/code/tab-preferred')
    })
  })
})
