import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalExitBanner } from '@/components/TerminalExitBanner'

const noop = () => {}
const baseProps = {
  crashTrace: null,
  resumeCycles: null,
  canResume: false,
  onRelaunch: noop,
  onCancelAutoResume: noop,
  onDismissCrashTrace: noop,
}

describe('TerminalExitBanner', () => {
  // This repo's vitest setup does not auto-cleanup between tests (globals off);
  // sibling suites (e.g. ReconcileWarmingBanner.test.tsx) call cleanup() explicitly.
  afterEach(() => cleanup())

  it('renders a loud error bar with the exit code and an accessible relaunch button', () => {
    const onRelaunch = vi.fn()
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} notice={null} settledDead onRelaunch={onRelaunch} />)
    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('process exited (code 1)')
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    fireEvent.click(btn)
    expect(onRelaunch).toHaveBeenCalledTimes(1)
  })

  it('renders without a code when the exit code is unknown (post-reload)', () => {
    render(<TerminalExitBanner {...baseProps} mode="codex" exitCode={null} notice={null} settledDead />)
    expect(screen.getByRole('alert')).toHaveTextContent('process exited')
    expect(screen.getByRole('alert')).not.toHaveTextContent('(code')
  })

  it('renders a recovering notice with a cancel button instead of the error bar while auto-resume is in flight', () => {
    const onCancel = vi.fn()
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} settledDead
      notice={{ kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at: Date.now() }}
      onCancelAutoResume={onCancel} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('claude crashed (exit 1) — auto-resuming, attempt 1/2')
    // znhn item 2: the user can opt out of the in-flight auto-resume.
    const cancel = screen.getByRole('button', { name: 'Cancel auto-resume for claude' })
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders the persistent crash trace (role=status, NOT alert) with a dismiss button', () => {
    // znhn item 1: the trace replaces the ephemeral 'resumed' strip. It must
    // NOT be role=alert — e2e happy paths assert alert count 0.
    const onDismiss = vi.fn()
    // 2026-07-29T03:37:00 local — assert on the derived HH:MM.
    const resumedAtMs = new Date(2026, 6, 29, 9, 5).getTime()
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={null} notice={null} settledDead={false}
      crashTrace={{ exitCode: 1, resumedAtMs }}
      onDismissCrashTrace={onDismiss} />)
    expect(screen.queryByRole('alert')).toBeNull()
    const trace = screen.getByTestId('crash-trace')
    expect(trace).toHaveAttribute('role', 'status')
    expect(trace).toHaveTextContent('claude crashed (exit 1) & auto-resumed at 09:05')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude crash notice' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when there is no notice, no settled death, and no trace', () => {
    const { container } = render(
      <TerminalExitBanner {...baseProps} mode="claude" exitCode={null} notice={null} settledDead={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('labels Relaunch honestly when the sessionRef can resume the conversation (znhn#5)', () => {
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} notice={null} settledDead canResume />)
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    expect(btn).toHaveTextContent('Relaunch — resumes this conversation')
  })

  it('keeps plain Relaunch copy when no matching sessionRef exists (degrades to fresh)', () => {
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} notice={null} settledDead canResume={false} />)
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    expect(btn).toHaveTextContent(/^Relaunch$/)
  })

  it('renders the circuit-breaker banner from the typed resumeCycles field (znhn#2)', () => {
    render(<TerminalExitBanner {...baseProps} mode="claude" exitCode={1} notice={null} settledDead resumeCycles={5} />)
    expect(screen.getByRole('alert')).toHaveTextContent('claude crashed 5 times — auto-resume paused')
    // Relaunch stays available — bounded and loud, never dead-ended.
    expect(screen.getByRole('button', { name: 'Relaunch claude session' })).toBeInTheDocument()
  })

  // the-usual ownership-fence-fix focused review 2 (Major): the killed-session
  // recovery affordance. A clean exit (code 0 — the terminal.kill wire
  // contract) on a pane whose canonical runtime-owner record folded VACANT is
  // the cross-device-kill shape: the pane must surface the user-driven
  // reopen action (never an automatic relaunch). Ordinary clean exits (the
  // record still Live, or no record) stay quiet.
  it('surfaces the reopen affordance for a clean-exit killed session whose owner record is vacant', () => {
    const onRelaunch = vi.fn()
    render(
      <TerminalExitBanner
        {...baseProps} mode="codex" exitCode={0} notice={null} settledDead={false}
        vacantRecovery onRelaunch={onRelaunch}
      />,
    )
    const bar = screen.getByTestId('terminal-vacant-recovery-bar')
    expect(bar).toHaveTextContent('codex session was stopped (code 0)')
    // the-usual delta round 6 (rider): honest recovery copy — with NO
    // resumable sessionRef the sentence must NOT promise resumption (the
    // reopen degrades to a fresh conversation in the pane's mode).
    expect(bar).toHaveTextContent('reopen it to start a new conversation')
    expect(bar).not.toHaveTextContent('resume this conversation')
    const btn = screen.getByRole('button', { name: 'Reopen codex session' })
    fireEvent.click(btn)
    // The banner is pure presentational: the recovery-create dispatch is the
    // caller's onRelaunch wiring (TerminalView relays it to the respawn
    // create flow).
    expect(onRelaunch).toHaveBeenCalledTimes(1)
  })

  it('labels Reopen honestly when the sessionRef can resume the conversation', () => {
    render(
      <TerminalExitBanner
        {...baseProps} mode="codex" exitCode={0} notice={null} settledDead={false}
        vacantRecovery canResume
      />,
    )
    // the-usual delta round 6 (rider): the recovery sentence keeps its
    // resume promise ONLY when the sessionRef can actually resume.
    const bar = screen.getByTestId('terminal-vacant-recovery-bar')
    expect(bar).toHaveTextContent('reopen it to resume this conversation')
    expect(bar).not.toHaveTextContent('start a new conversation')
    expect(screen.getByRole('button', { name: 'Reopen codex session' }))
      .toHaveTextContent('Reopen — resumes this conversation')
  })

  it('stays quiet for a clean exit whose session record is still live (a deliberate exit)', () => {
    // exit code 0 WITHOUT the vacant-owner shape (the record still names a
    // live owner, or the pane holds no durable session record at all): no
    // banner, no action — the deliberate clean exit stays quiet.
    const { container } = render(
      <TerminalExitBanner {...baseProps} mode="codex" exitCode={0} notice={null} settledDead={false} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
