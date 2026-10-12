import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

const apiPost = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}))

const resumeSessionInTab = vi.fn(() => ({ deduped: false }))
const findCheckpointWorkspaceForSession = vi.fn(() => undefined as unknown)
vi.mock('@/lib/resume-session', () => ({
  resumeSessionInTab: (...args: unknown[]) => resumeSessionInTab(...args),
  findCheckpointWorkspaceForSession: (...args: unknown[]) => findCheckpointWorkspaceForSession(...args),
}))

import { ResumeSessionDialog } from '@/components/ResumeSessionDialog'

const V4 = 'ed2afda6-a340-443e-ba60-024a1b3554b4'
const V7 = '019fac27-69d7-78a0-b972-b339d551042e'
const SES = 'ses_root0000000000000000000000'

const match = (overrides: Record<string, unknown> = {}) => ({
  provider: 'codex',
  sessionId: V7,
  cwd: '/repo/alpha',
  sessionType: 'codex',
  matchKind: 'exact',
  ...overrides,
})

const ok = (matches: unknown[], hint: unknown = null) =>
  Promise.resolve({ status: 'ready', matches, hint })

const degraded = (
  matches: unknown[],
  providerErrors: unknown[] = [{ provider: 'opencode', message: 'database is locked' }],
) => Promise.resolve({ status: 'degraded', matches, hint: null, providerErrors })

function renderDialog() {
  const store = configureStore({
    reducer: { connection: () => ({ serverInstanceId: 'srv-1' }) },
  })
  const onClose = vi.fn()
  const onNavigate = vi.fn()
  render(
    <Provider store={store}>
      <ResumeSessionDialog open onClose={onClose} onNavigate={onNavigate} />
    </Provider>,
  )
  return { onClose, onNavigate }
}

const typeAndResolve = (text: string) => {
  const input = screen.getByTestId('resume-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('ResumeSessionDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    // No vitest globals in this repo's config, so RTL auto-cleanup is off;
    // unmount the portal explicitly (matches existing component tests).
    cleanup()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('resolves on Enter and resumes a single match with a note', async () => {
    apiPost.mockReturnValue(ok([match()]))
    renderDialog()
    typeAndResolve(`codex resume ${V7}`)
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/sessions/resolve', {
        input: `codex resume ${V7}`,
      }),
    )
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      provider: 'codex',
      sessionId: V7,
      cwd: '/repo/alpha',
      sessionType: 'codex',
    })
    expect(screen.getByTestId('resume-note').textContent).toContain('codex')
  })

  it('server evidence decides the agent even when the parse hint disagrees', async () => {
    apiPost.mockReturnValue(ok([match({ provider: 'opencode', sessionId: SES, sessionType: undefined })]))
    renderDialog()
    // "claude --resume" hints claude, but the session store says opencode.
    typeAndResolve(`claude --resume ${SES}`)
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({ provider: 'opencode' })
    expect(screen.getByTestId('resume-note').textContent).toContain('opencode')
  })

  it('shows a disambiguation list and resumes the clicked match', async () => {
    apiPost.mockReturnValue(
      ok([
        match({ sessionId: '417e8345-aaaa-4bbb-8ccc-000000000001', provider: 'amplifier', matchKind: 'prefix', lastActivityAt: 900 }),
        match({ sessionId: '417e8345-bbbb-4ccc-8ddd-000000000002', provider: 'amplifier', matchKind: 'prefix', lastActivityAt: 100 }),
      ]),
    )
    renderDialog()
    typeAndResolve('417e8345')
    const rows = await screen.findAllByTestId('resume-match')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      sessionId: '417e8345-bbbb-4ccc-8ddd-000000000002',
    })
  })

  it('zero matches: inline error, input preserved, resume-anyway uses the parse-hint agent', async () => {
    apiPost.mockReturnValue(ok([]))
    renderDialog()
    typeAndResolve(V4)
    await screen.findByTestId('resume-error')
    expect((screen.getByTestId('resume-input') as HTMLTextAreaElement).value).toBe(V4)
    // The v4 id shape hints claude; the button discloses that guess before launch.
    expect(screen.getByTestId('resume-anyway-button').textContent).toBe('Resume anyway with claude')
    expect((screen.getByTestId('resume-anyway-cwd') as HTMLInputElement).value).toBe('~')
    fireEvent.click(screen.getByTestId('resume-anyway-button'))
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      provider: 'claude',
      sessionId: V4,
      sessionType: 'claude',
      cwd: undefined, // '~' means server default (home directory)
    })
  })

  it('the command form steers the guess: "codex resume <id>" discloses codex on the escape hatch', async () => {
    apiPost.mockReturnValue(ok([]))
    renderDialog()
    typeAndResolve('codex resume abc123def0')
    await screen.findByTestId('resume-error')
    expect(screen.getByTestId('resume-anyway-button').textContent).toBe('Resume anyway with codex')
    fireEvent.click(screen.getByTestId('resume-anyway-button'))
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      provider: 'codex',
      sessionId: 'abc123def0',
      sessionType: 'codex',
    })
  })

  it('warming is not "not found": shows retry state and re-resolves', async () => {
    apiPost
      .mockReturnValueOnce(Promise.resolve({ status: 'warming', matches: [], hint: null }))
      .mockReturnValueOnce(ok([match()]))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-warming')
    expect(screen.queryByTestId('resume-error')).toBeNull()
    await vi.advanceTimersByTimeAsync(2100)
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
  })

  it('warming auto-retry is bounded: exhaustion shows "index unavailable" with a working manual Retry', async () => {
    // Readiness can stick false forever (indexer start rejection is only
    // logged) — the dialog must not spin the auto-retry loop indefinitely.
    apiPost.mockReturnValue(Promise.resolve({ status: 'warming', matches: [], hint: null }))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-warming')
    // Burn through the budget: 15 auto-retries, then the terminal state.
    for (let i = 0; i < 16; i += 1) {
      await vi.advanceTimersByTimeAsync(2100)
    }
    await screen.findByTestId('resume-index-unavailable')
    expect(screen.queryByTestId('resume-warming')).toBeNull()
    // The manual Retry still works (it resets the budget) and can succeed.
    apiPost.mockReturnValue(ok([match()]))
    fireEvent.click(screen.getByTestId('resume-index-retry'))
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
  })

  it('garbage input: inline error, no server call, no tab', async () => {
    renderDialog()
    typeAndResolve('hello decade facade!!')
    await screen.findByTestId('resume-error')
    expect(apiPost).not.toHaveBeenCalled()
    expect(resumeSessionInTab).not.toHaveBeenCalled()
  })

  it('renders NO always-visible agent picker or unverified-guess hint (kata 1ffd removal)', () => {
    renderDialog()
    expect(screen.queryByTestId('resume-agent-picker')).toBeNull()
    expect(screen.queryByLabelText(/agent/i)).toBeNull()
    expect(screen.queryByText(/unverified guess/i)).toBeNull()
  })

  it('closes on Escape', () => {
    const { onClose } = renderDialog()
    fireEvent.keyDown(screen.getByTestId('resume-dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('ignores STALE responses: a late first response cannot override or auto-resume', async () => {
    // Overlapping resolves (edit-then-Enter) can deliver out of order; a stale
    // single-match response must NEVER auto-resume — it could open the WRONG session.
    let resolveFirst!: (value: unknown) => void
    apiPost
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(ok([]))
    renderDialog()
    typeAndResolve('ed2afda6')
    typeAndResolve(V4)
    await screen.findByTestId('resume-error')
    expect(screen.getByTestId('resume-error').textContent).toMatch(/no matching session/i)
    // The stale FIRST response now arrives with a single match: ignore it.
    await act(async () => {
      resolveFirst({ status: 'ready', matches: [match()], hint: null })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resumeSessionInTab).not.toHaveBeenCalled()
    expect(screen.getByTestId('resume-error').textContent).toMatch(/no matching session/i)
  })

  it('EDITING the input invalidates the previous result: stale resume-anyway cannot act', async () => {
    // Without this, resolve(A) -> "not found" -> replace text with B ->
    // "Resume anyway" would still be actionable against STALE id A.
    apiPost.mockReturnValue(ok([]))
    renderDialog()
    typeAndResolve(V4)
    await screen.findByTestId('resume-anyway-button')
    fireEvent.change(screen.getByTestId('resume-input'), { target: { value: SES } })
    expect(screen.queryByTestId('resume-anyway-button')).toBeNull()
    expect(screen.queryByTestId('resume-error')).toBeNull()
  })

  it('single match WITHOUT a cwd does NOT auto-resume: asks for a working directory instead', async () => {
    // Exact-id fallback hits can lack a recorded cwd; the spec requires a
    // concrete working directory before opening — never auto-open without one.
    apiPost.mockReturnValue(ok([match({ cwd: undefined })]))
    renderDialog()
    typeAndResolve(V7)
    const row = await screen.findByTestId('resume-match')
    expect(resumeSessionInTab).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('resume-anyway-cwd'), { target: { value: '/repo/beta' } })
    fireEvent.click(row)
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({
      provider: 'codex',
      sessionId: V7,
      cwd: '/repo/beta',
    })
  })

  it('cwd-less match with a BLANK working-directory field: confirm is blocked with an inline error', async () => {
    apiPost.mockReturnValue(ok([match({ cwd: undefined })]))
    renderDialog()
    typeAndResolve(V7)
    const row = await screen.findByTestId('resume-match')
    fireEvent.change(screen.getByTestId('resume-anyway-cwd'), { target: { value: '   ' } })
    fireEvent.click(row)
    expect(resumeSessionInTab).not.toHaveBeenCalled()
    expect(screen.getByTestId('resume-error').textContent).toMatch(/working directory/i)
  })

  it('"Resume anyway" is DISABLED while the working-directory field is blank', async () => {
    apiPost.mockReturnValue(ok([]))
    renderDialog()
    typeAndResolve(V4)
    const anyway = await screen.findByTestId('resume-anyway-button')
    fireEvent.change(screen.getByTestId('resume-anyway-cwd'), { target: { value: '  ' } })
    expect(anyway).toBeDisabled()
    fireEvent.click(anyway)
    expect(resumeSessionInTab).not.toHaveBeenCalled()
  })

  it('passes the local checkpoint workspace through the resume-anyway fallback', async () => {
    const checkpointWorkspace = { path: '/selected/project', provenance: 'directory-picker' as const }
    findCheckpointWorkspaceForSession.mockReturnValue(checkpointWorkspace)
    apiPost.mockReturnValue(ok([]))
    renderDialog()
    typeAndResolve(V7)
    const anyway = await screen.findByTestId('resume-anyway-button')
    fireEvent.click(anyway)

    expect(findCheckpointWorkspaceForSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'codex',
      sessionId: V7,
    }))
    expect(resumeSessionInTab.mock.calls[0]?.[2]).toMatchObject({
      provider: 'codex',
      sessionId: V7,
      checkpointWorkspace,
    })
  })

  it('a NON-ready response never auto-resumes, even with a single cwd match (degraded seam)', async () => {
    // Pins the ordering the future 'degraded' status depends on: any non-ready
    // response must be handled as a retry state BEFORE match handling.
    apiPost.mockReturnValue(Promise.resolve({ status: 'warming', matches: [match()], hint: null }))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-warming')
    expect(resumeSessionInTab).not.toHaveBeenCalled()
  })

  it('degraded (provider unavailable): explicit "could not be searched" state with details, NOT "no matching session"', async () => {
    apiPost.mockReturnValue(degraded([], [
      { provider: 'opencode', code: 'EACCES', message: 'database is locked' },
    ]))
    renderDialog()
    typeAndResolve(SES)
    const notice = await screen.findByTestId('resume-degraded')
    expect(notice.textContent).toMatch(/could not be searched/i)
    expect(notice.textContent).toContain('opencode')
    expect(notice.textContent).toContain('EACCES')
    expect(screen.queryByTestId('resume-error')).toBeNull()
    expect(resumeSessionInTab).not.toHaveBeenCalled()
  })

  it('degraded MANUAL retry re-resolves and can succeed', async () => {
    apiPost
      .mockReturnValueOnce(degraded([]))
      .mockReturnValueOnce(ok([match()]))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-degraded')
    fireEvent.click(screen.getByTestId('resume-degraded-retry'))
    await waitFor(() => expect(resumeSessionInTab).toHaveBeenCalled())
  })

  it('degraded does NOT auto-retry: no warming-style interval polling', async () => {
    apiPost.mockReturnValue(degraded([]))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-degraded')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  it('degraded single match WITH cwd: NEVER auto-resumes — listed for manual confirmation instead', async () => {
    // A failed provider means a higher-priority exact match may have been
    // missed: auto-opening the surviving match could open the WRONG session.
    apiPost.mockReturnValue(degraded([match()], [{ provider: 'claude', message: 'EACCES' }]))
    renderDialog()
    typeAndResolve(V7)
    await screen.findByTestId('resume-degraded')
    expect(resumeSessionInTab).not.toHaveBeenCalled()
    // The surviving match is still offered for MANUAL confirmation.
    const row = await screen.findByTestId('resume-match')
    fireEvent.click(row)
    expect(resumeSessionInTab).toHaveBeenCalledTimes(1)
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({ provider: 'codex', sessionId: V7 })
  })

  it('prefills the working directory from the server homeDir instead of the "~" sentinel', async () => {
    apiPost.mockReturnValue(Promise.resolve({
      status: 'ready', matches: [], hint: null, homeDir: '/home/serveruser',
    }))
    renderDialog()
    typeAndResolve(V4)
    await screen.findByTestId('resume-anyway-button')
    expect((screen.getByTestId('resume-anyway-cwd') as HTMLInputElement).value).toBe('/home/serveruser')
    fireEvent.click(screen.getByTestId('resume-anyway-button'))
    expect(resumeSessionInTab.mock.calls[0][2]).toMatchObject({ cwd: '/home/serveruser' })
  })

  it('homeDir prefill never overwrites a user-edited working directory', async () => {
    apiPost.mockReturnValue(Promise.resolve({
      status: 'ready', matches: [], hint: null, homeDir: '/home/serveruser',
    }))
    renderDialog()
    typeAndResolve(V4)
    await screen.findByTestId('resume-anyway-cwd')
    fireEvent.change(screen.getByTestId('resume-anyway-cwd'), { target: { value: '/repo/mine' } })
    typeAndResolve(V4)
    await screen.findByTestId('resume-anyway-cwd')
    expect((screen.getByTestId('resume-anyway-cwd') as HTMLInputElement).value).toBe('/repo/mine')
  })

  it('names DISABLED (unsearched) providers in the no-match message', async () => {
    apiPost.mockReturnValue(Promise.resolve({
      status: 'ready', matches: [], hint: null, unsearchedProviders: ['codex', 'amplifier'],
    }))
    renderDialog()
    typeAndResolve(V4)
    const error = await screen.findByTestId('resume-error')
    expect(error.textContent).toMatch(/not searched \(disabled\): codex, amplifier/i)
    // Resume-anyway stays available.
    expect(screen.getByTestId('resume-anyway-button')).toBeInTheDocument()
  })

  it('traps Tab focus inside the dialog: wraps last→first and first→last (Shift+Tab)', () => {
    renderDialog()
    const dialog = screen.getByTestId('resume-dialog')
    const input = screen.getByTestId('resume-input')
    const resolveBtn = screen.getByTestId('resume-resolve-button')
    resolveBtn.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(resolveBtn)
  })

  it('locks background scroll while open; restores scroll and focus on close', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const store = configureStore({
      reducer: { connection: () => ({ serverInstanceId: 'srv-1' }) },
    })
    const onClose = vi.fn()
    const { rerender } = render(
      <Provider store={store}>
        <ResumeSessionDialog open onClose={onClose} />
      </Provider>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    rerender(
      <Provider store={store}>
        <ResumeSessionDialog open={false} onClose={onClose} />
      </Provider>,
    )
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
