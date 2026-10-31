import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import { ApiError } from '@/lib/api'

// Only `api.get` needs stubbing here; the real `ApiError` class must survive the
// mock so the component's instanceof classification keeps working.
const apiGet = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (...args: unknown[]) => apiGet(...args),
    },
  }
})

describe('FreshAgentDiffPanel', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders diff entries', () => {
    render(<FreshAgentDiffPanel diffs={[{ id: 'diff-1', title: 'src/app.tsx' }]} />)
    expect(screen.getByText('Diffs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff: src/app.tsx' })).toBeInTheDocument()
  })

  it('shows supplied native diff and later replacement without a cwd/path fetch', async () => {
    const { rerender } = render(<FreshAgentDiffPanel diffs={[{ id: 'turn:t', title: 'Turn changes', diff: 'diff --git a/one.ts b/one.ts\n@@ -1 +1 @@\n-one\n+two\ndiff --git a/two.ts b/two.ts\n@@ -1 +1 @@\n-old\n+updated' }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff: Turn changes' }))
    expect(await screen.findByText('+two')).toBeVisible()
    expect(screen.getByText('diff --git a/one.ts b/one.ts')).toBeVisible()
    expect(screen.getByText('diff --git a/two.ts b/two.ts')).toBeVisible()
    expect(screen.queryByText(/Diff unavailable/)).toBeNull()
    rerender(<FreshAgentDiffPanel diffs={[{ id: 'turn:t', title: 'Turn changes', diff: '@@ -1 +1 @@\n-one\n+three' }]} cwd="/different" />)
    expect(screen.getByText('+three')).toBeVisible()
    expect(screen.queryByText('+two')).toBeNull()
    expect(screen.queryByText('diff --git a/one.ts b/one.ts')).toBeNull()
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('renders the shared diff view with data-file-path copy target metadata', () => {
    const { container } = render(
      <DiffView oldStr="const value = 1\n" newStr="const value = 2\n" filePath="src/app.tsx" />,
    )

    const diffView = screen.getByRole('figure', { name: 'diff view' })
    expect(diffView).toBeInTheDocument()
    expect(container.querySelector('[data-diff]')).toHaveAttribute('data-file-path', 'src/app.tsx')
    expect(diffView).toHaveTextContent(/const value = 1/)
    expect(diffView).toHaveTextContent(/const value = 2/)
  })

  describe('diff loading', () => {
    const entry = { id: 'd1', path: 'src/a.ts', status: 'modified' as const }

    it('expand → success renders the diff lines', async () => {
      apiGet.mockResolvedValue({ diff: '@@ -1 +1 @@\n-one\n+two' })
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText('+two')
    })

    it('expand → server 500 shows the inline error and a Retry button', async () => {
      apiGet.mockRejectedValue(
        new ApiError(500, 'git diff failed: fatal: not a git repository', { error: 'git diff failed: …' }),
      )
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/git diff failed/)
      const retry = screen.getByRole('button', { name: 'Retry loading diff' })
      apiGet.mockResolvedValue({ diff: 'later' })
      await userEvent.click(retry)
      await screen.findByText('later')
      expect(apiGet).toHaveBeenCalledTimes(2)
      // Discrimination pin: a successful retry must clear the prior error
      // (load() calls setError(null)); without the clear the stale error
      // block would stay visible alongside the recovered diff.
      expect(screen.queryByText(/git diff failed/)).not.toBeInTheDocument()
    })

    it('expand → 404 shows the unsupported-server copy', async () => {
      apiGet.mockRejectedValue(new ApiError(404, 'Not found', { error: 'Not found' }))
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/not supported by this server/)
    })

    it('missing cwd renders an explicit inline state and never fetches', async () => {
      render(<FreshAgentDiffPanel diffs={[entry]} cwd={undefined} />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/Diff unavailable for this file/)
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('missing path renders an explicit inline state and never fetches', async () => {
      render(<FreshAgentDiffPanel diffs={[{ id: 'd1', status: 'modified' }]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: d1' }))
      await screen.findByText(/Diff unavailable for this file/)
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('a loaded diff is one-shot: collapse + re-expand does not refetch', async () => {
      apiGet.mockResolvedValue({ diff: '@@ -1 +1 @@\n-one\n+two' })
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      const trigger = screen.getByRole('button', { name: 'Diff: src/a.ts' })
      await userEvent.click(trigger)
      await screen.findByText('+two')
      await userEvent.click(trigger) // collapse
      await userEvent.click(trigger) // re-expand
      await screen.findByText('+two')
      expect(apiGet).toHaveBeenCalledTimes(1)
    })

    it('retry disappears when a later snapshot drops the prerequisite', async () => {
      apiGet.mockRejectedValue(new ApiError(500, 'git diff failed', { error: 'git diff failed' }))
      const { rerender } = render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/git diff failed/)
      expect(screen.getByRole('button', { name: 'Retry loading diff' })).toBeTruthy()
      apiGet.mockClear()
      // Props are snapshot-fed; if a later snapshot drops cwd, the stale
      // error's Retry affordance must disappear rather than sit as a dead
      // no-op button next to the "Diff unavailable" explanation.
      rerender(<FreshAgentDiffPanel diffs={[entry]} cwd={undefined} />)
      expect(screen.queryByRole('button', { name: 'Retry loading diff' })).toBeNull()
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('empty diff keeps its copy', async () => {
      apiGet.mockResolvedValue({ diff: '' })
      render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/No uncommitted changes for this file/)
    })
  })
})
