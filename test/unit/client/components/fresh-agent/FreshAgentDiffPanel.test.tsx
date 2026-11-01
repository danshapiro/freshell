import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('counts session paths independently of latest-turn preview and opens changes only on demand', async () => {
    const user = userEvent.setup()
    render(<FreshAgentDiffPanel diffs={[
      { id: 'one', path: '/repo/one.ts' },
      { id: 'prior', path: '/repo/prior.ts' },
      { id: 'older', path: '/repo/older.ts' },
      { id: 'codex-turn:turn-1', title: 'Turn changes', diff: 'diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two.ts b/two.ts\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-x\n+y' },
    ]} cwd="/repo" />)
    const trigger = screen.getByRole('button', { name: 'Diffs: 3 changed files' })
    expect(screen.queryByRole('button', { name: 'Diff: Turn changes' })).toBeNull()
    expect(apiGet).not.toHaveBeenCalled()
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Changes' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Diff: Turn changes' }))
    expect(screen.getByText('+new')).toBeVisible()
    expect(apiGet).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Changes' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it.each([
    ['Claude paths', [{ id: 'a', path: '/repo/a' }, { id: 'b', path: '/repo/b' }], '2 changed files'],
    ['Kilroy duplicates', [{ id: 'a', path: '/repo/a' }, { id: 'b', path: '/repo/a' }], '1 changed file'],
    ['opaque summaries', [{ id: 'opaque-id' }], 'file count unavailable'],
    ['opaque patch', [{ id: 'native', diff: '@@ -1 +1 @@\n-old\n+new' }], 'file count unavailable'],
    ['empty native', [{ id: 'native', diff: '' }], '0 changed files'],
    ['whitespace native', [{ id: 'native', diff: '  \n' }], '0 changed files'],
    ['additions and deletions', [{ id: 'native', diff: 'diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+new\ndiff --git a/deleted b/deleted\ndeleted file mode 100644\n--- a/deleted\n+++ /dev/null\n@@ -1 +0,0 @@\n-old' }], '2 changed files'],
    ['rename destination identity', [{ id: 'native', diff: 'diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\ndiff --git a/new b/new\n@@ -1 +1 @@\n-x\n+y' }], '1 changed file'],
    ['rename source distinct from destination', [{ id: 'native', diff: 'diff --git a/old b/new\nrename from old\nrename to new\ndiff --git a/old b/old\n+++ /dev/null' }], '2 changed files'],
    ['binary headers', [{ id: 'native', diff: 'diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\ndiff --git a/b.png b/b.png\nGIT binary patch\nliteral 1\nA' }], '2 changed files'],
    ['unquoted spaces', [{ id: 'native', diff: 'diff --git a/has spaces.ts b/has spaces.ts\n@@ -1 +1 @@\n-x\n+y' }], '1 changed file'],
    ['unquoted delimiter-like spaces', [{ id: 'native', diff: 'diff --git a/one b/shared.ts b/one b/shared.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two b/shared.ts b/two b/shared.ts\n@@ -1 +1 @@\n-old\n+new' }], '2 changed files'],
    ['ambiguous unequal unquoted paths', [{ id: 'native', diff: 'diff --git a/old b/shared.ts b/new b/shared.ts\n@@ -1 +1 @@\n-old\n+new' }], 'file count unavailable'],
    ['quoted and UTF-8 octal paths', [{ id: 'native', diff: 'diff --git "a/has spaces.ts" "b/has spaces.ts"\n@@ -1 +1 @@\n-x\n+y\ndiff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/é.ts b/é.ts\n@@ -1 +1 @@\n-x\n+y' }], '2 changed files'],
    ['hunk content resembling headers', [{ id: 'native', diff: 'diff --git a/a b/a\n@@ -1,3 +1,3 @@\n --- a/fake\n +++ b/fake\n+diff --git a/fake b/fake\n+rename to fake' }], '1 changed file'],
    ['overlapping structured and native paths', [{ id: 'a', path: '/repo/a' }, { id: 'native', diff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\n@@ -1 +1 @@\n-x\n+y' }], '1 changed file'],
  ])('reports honest cardinality for %s', (_name, diffs, label) => {
    render(<FreshAgentDiffPanel diffs={diffs} />)
    expect(screen.getByRole('button', { name: `Diffs: ${label}` })).toBeVisible()
  })

  it('keeps the complete Codex session count and all rows across latest-turn replacement, clearing and invalidation', async () => {
    const structured = ['A', 'B', 'C', 'D'].map((path) => ({ id: path, path: `/repo/${path}` }))
    const patch = { id: 'codex-turn:later', title: 'Turn changes', diff: 'diff --git a/D b/D\n@@ -1 +1 @@\n-old\n+later' }
    const { rerender } = render(<FreshAgentDiffPanel diffs={[...structured, patch]} cwd="/repo/subdir" />)
    await userEvent.click(screen.getByRole('button', { name: 'Diffs: 4 changed files' }))
    await userEvent.click(screen.getByRole('button', { name: 'Diff: Turn changes' }))
    expect(screen.getByText('+later')).toBeVisible()
    for (const diff of ['diff --git a/extra b/extra\n@@ -1 +1 @@\n-x\n+replacement', '', undefined]) {
      rerender(<FreshAgentDiffPanel diffs={[...structured, { ...patch, diff }]} cwd="/repo/subdir" />)
      expect(screen.getByRole('button', { name: 'Diffs: 4 changed files' })).toBeVisible()
      for (const path of ['A', 'B', 'C', 'D']) expect(screen.getByRole('button', { name: `Diff: /repo/${path}` })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Diff: Turn changes' })).toBeVisible()
    }
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('updates native-only cardinality and content while open', async () => {
    const patch = (paths: string[]) => paths.map((path) => `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+${path}`).join('\n')
    const { rerender } = render(<FreshAgentDiffPanel diffs={[{ id: 'native', diff: patch(['one']) }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Diffs: 1 changed file' }))
    await userEvent.click(screen.getByRole('button', { name: 'Diff: native' }))
    rerender(<FreshAgentDiffPanel diffs={[{ id: 'native', diff: patch(['two', 'three']) }]} />)
    expect(screen.getByRole('button', { name: 'Diffs: 2 changed files' })).toBeVisible()
    expect(screen.getByText('+two')).toBeVisible()
    expect(screen.queryByText('+one')).toBeNull()
    expect(screen.getByRole('button', { name: 'Diff: native' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('wraps focus among live enabled controls and dismisses through Close and outside click', async () => {
    const user = userEvent.setup()
    render(<FreshAgentDiffPanel diffs={[{ id: 'a', diff: '@@ -1 +1 @@\n-old\n+new' }]} onComment={() => {}} />)
    const trigger = screen.getByRole('button', { name: /^Diffs:/ })
    await user.click(trigger)
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Diff: a' })).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Diff: a' }))
    const comments = screen.getAllByRole('button', { name: 'Comment on this line for the agent' })
    comments.at(-1)!.focus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(comments.at(-1)).toHaveFocus()
    await user.click(close)
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    fireEvent.click(screen.getByRole('dialog', { name: 'Changes' }))
    expect(screen.getByRole('dialog', { name: 'Changes' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close Changes' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('comments close Changes and preserve composer insertion focus', async () => {
    const composer = document.createElement('textarea')
    document.body.append(composer)
    const onComment = vi.fn((text: string) => { composer.value = text; composer.focus() })
    render(<FreshAgentDiffPanel diffs={[{ id: 'a', path: '/a', diff: '+new' }]} onComment={onComment} />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Diff: /a' }))
    await userEvent.click(screen.getByRole('button', { name: 'Comment on this line for the agent' }))
    expect(composer).toHaveValue('On /a at `+new`: ')
    expect(composer).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    composer.remove()
  })

  it('closes and drops old fetched content when the conversation scope changes', async () => {
    apiGet.mockResolvedValueOnce({ diff: '+old-session' }).mockResolvedValueOnce({ diff: '+new-session' })
    const diffs = [{ id: 'same', path: '/same' }]
    const { rerender } = render(<FreshAgentDiffPanel diffs={diffs} cwd="/repo" scopeKey="old" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Diff: /same' }))
    expect(await screen.findByText('+old-session')).toBeVisible()
    rerender(<FreshAgentDiffPanel diffs={diffs} cwd="/repo" scopeKey="new" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Diff: /same' }))
    expect(await screen.findByText('+new-session')).toBeVisible()
    expect(screen.queryByText('+old-session')).toBeNull()
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('copies complete pane context without inventing an absent session (%s)', async (hasSession) => {
    const root = document.createElement('div')
    root.className = 'fresh-agent-pane fresh-agent-style-serif'
    Object.assign(root.dataset, { context: 'fresh-agent', tabId: 'tab', paneId: 'pane', provider: 'codex', sessionType: 'freshcodex', ...(hasSession ? { sessionId: 'session' } : {}) })
    root.style.setProperty('--fresh-agent-text', 'red')
    document.body.append(root)
    render(<FreshAgentDiffPanel diffs={[{ id: 'a', path: '/a' }]} paneRoot={root} />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
    const portal = screen.getByRole('dialog').parentElement!
    for (const [key, value] of Object.entries(root.dataset)) expect(portal.dataset[key]).toBe(value)
    if (!hasSession) expect(portal).not.toHaveAttribute('data-session-id')
    expect(portal).toHaveClass('fresh-agent-style-serif')
    expect(portal.style.getPropertyValue('--fresh-agent-text')).toBe('red')
    act(() => { root.className = 'fresh-agent-pane fresh-agent-style-mono'; root.style.setProperty('--fresh-agent-text', 'blue') })
    await waitFor(() => expect(portal).toHaveClass('fresh-agent-style-mono'))
    expect(portal).not.toHaveClass('fresh-agent-style-serif')
    expect(portal.style.getPropertyValue('--fresh-agent-text')).toBe('blue')
    root.remove()
  })

  it('renders diff entries', async () => {
    render(<FreshAgentDiffPanel diffs={[{ id: 'diff-1', title: 'src/app.tsx' }]} />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
    expect(screen.getByText('Diffs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff: src/app.tsx' })).toBeInTheDocument()
  })

  it('shows supplied native diff and later replacement without a cwd/path fetch', async () => {
    const { rerender } = render(<FreshAgentDiffPanel scopeKey="native" diffs={[{ id: 'turn:t', title: 'Turn changes', diff: 'diff --git a/one.ts b/one.ts\n@@ -1 +1 @@\n-one\n+two\ndiff --git a/two.ts b/two.ts\n@@ -1 +1 @@\n-old\n+updated' }]} />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Diff: Turn changes' }))
    expect(await screen.findByText('+two')).toBeVisible()
    expect(screen.getByText('diff --git a/one.ts b/one.ts')).toBeVisible()
    expect(screen.getByText('diff --git a/two.ts b/two.ts')).toBeVisible()
    expect(screen.queryByText(/Diff unavailable/)).toBeNull()
    rerender(<FreshAgentDiffPanel scopeKey="native" diffs={[{ id: 'turn:t', title: 'Turn changes', diff: '@@ -1 +1 @@\n-one\n+three' }]} cwd="/different" />)
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
      render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText('+two')
    })

    it('expand → server 500 shows the inline error and a Retry button', async () => {
      apiGet.mockRejectedValue(
        new ApiError(500, 'git diff failed: fatal: not a git repository', { error: 'git diff failed: …' }),
      )
      render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
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
      render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/not supported by this server/)
    })

    it('missing cwd renders an explicit inline state and never fetches', async () => {
      render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd={undefined} />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/Diff unavailable for this file/)
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('missing path renders an explicit inline state and never fetches', async () => {
      render(<FreshAgentDiffPanel diffs={[{ id: 'd1', status: 'modified' }]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Diff: d1' }))
      await screen.findByText(/Diff unavailable for this file/)
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('a loaded diff is one-shot: collapse + re-expand does not refetch', async () => {
      apiGet.mockResolvedValue({ diff: '@@ -1 +1 @@\n-one\n+two' })
      render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
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
      const { rerender } = render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/git diff failed/)
      expect(screen.getByRole('button', { name: 'Retry loading diff' })).toBeTruthy()
      apiGet.mockClear()
      // Props are snapshot-fed; if a later snapshot drops cwd, the stale
      // error's Retry affordance must disappear rather than sit as a dead
      // no-op button next to the "Diff unavailable" explanation.
      rerender(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd={undefined} />)
      expect(screen.queryByRole('button', { name: 'Retry loading diff' })).toBeNull()
      expect(apiGet).not.toHaveBeenCalled()
    })

    it('empty diff keeps its copy', async () => {
      apiGet.mockResolvedValue({ diff: '' })
      render(<FreshAgentDiffPanel scopeKey="session" diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: /^Diffs:/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
      await screen.findByText(/No uncommitted changes for this file/)
    })
  })
})
