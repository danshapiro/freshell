import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'react-redux'
import { api } from '@/lib/api'
import { resumeSessionInTab, type ResumeTarget } from '@/lib/resume-session'
import { OVERLAY_Z } from '@/components/ui/overlay'
import { useAppDispatch } from '@/store/hooks'
import type { RootState } from '@/store/store'
import { DEFAULT_ENABLED_CLI_PROVIDERS } from '@shared/coding-cli-defaults'
import { parseResumeInput } from '@shared/resume-input-parser'
import {
  ResumeResolveResponseSchema,
  type ResumeResolveMatch,
  type ResumeResolveProviderError,
} from '@shared/resume-resolve-contract'

const WARMING_RETRY_MS = 2000
// Readiness can stick false FOREVER: the indexer marks itself ready only after
// its startup chain succeeds, while failures are logged. Bound the auto-retry
// so a failed indexer degrades to a manual-retry state instead of an infinite
// spinner.
const WARMING_RETRY_LIMIT = 15 // ~30s of auto-retries
const RESUMED_CLOSE_MS = 1500

type Phase =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'warming' }
  | { kind: 'index-unavailable' }
  | { kind: 'no-token' }
  | { kind: 'no-match'; unsearchedProviders: string[] }
  | { kind: 'disambiguate'; matches: ResumeResolveMatch[] }
  // Provider unavailable ≠ not found: some agent stores could not be searched.
  // MANUAL retry only (the server fire-and-forgets an index refresh on every
  // degraded response, so Retry converges once the provider recovers) — never
  // the warming auto-retry budget, and NEVER auto-resume (a failed higher-
  // priority exact search may have hidden the right session).
  | { kind: 'degraded'; matches: ResumeResolveMatch[]; providerErrors: ResumeResolveProviderError[] }
  | { kind: 'resumed'; note: string }
  | { kind: 'request-failed' }

export interface ResumeSessionDialogProps {
  open: boolean
  onClose: () => void
  onNavigate?: (view: 'terminal') => void
}

const providers = DEFAULT_ENABLED_CLI_PROVIDERS as readonly string[]

// Focus-trap helper — same pattern as src/components/ui/confirm-modal.tsx
// (repo modal a11y convention: trap Tab, restore focus, lock scroll).
function getFocusable(container: HTMLElement): HTMLElement[] {
  const selectors = [
    'button',
    '[href]',
    'input',
    'select',
    'textarea',
    '[tabindex]:not([tabindex="-1"])',
  ]
  return Array.from(container.querySelectorAll<HTMLElement>(selectors.join(',')))
    .filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'))
}

export function ResumeSessionDialog({ open, onClose, onNavigate }: ResumeSessionDialogProps) {
  const dispatch = useAppDispatch()
  const store = useStore<RootState>()
  const [input, setInput] = useState('')
  const [agent, setAgent] = useState<string>(providers[0])
  const [anywayCwd, setAnywayCwd] = useState('~')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // Inline error for confirming a cwd-less match with a blank cwd field.
  const [matchCwdError, setMatchCwdError] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const warmingRetriesRef = useRef(0)
  // Stale-response guard: only the LATEST resolve request may mutate state.
  const resolveSeqRef = useRef(0)
  // homeDir prefill never overwrites a USER-edited working directory.
  const cwdTouchedRef = useRef(false)

  // Advisory parse hint drives the internal agent guess. There is no visible
  // picker (kata 1ffd): the guess surfaces only on the no-match escape hatch's
  // "Resume anyway with {agent}" button, which is the disclosure point.
  useEffect(() => {
    if (!input) return
    const { hint } = parseResumeInput(input)
    if (hint && providers.includes(hint.provider)) setAgent(hint.provider)
  }, [input])

  const finishResume = useCallback(
    (target: ResumeTarget, note: string) => {
      resumeSessionInTab(store.getState(), dispatch, target, onNavigate)
      setPhase({ kind: 'resumed', note })
      closeTimerRef.current = window.setTimeout(onClose, RESUMED_CLOSE_MS)
    },
    [dispatch, onClose, onNavigate, store],
  )

  const resolveInput = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (parseResumeInput(trimmed).candidates.length === 0) {
        setPhase({ kind: 'no-token' })
        return
      }
      // Stale-response guard: bump the sequence; only the LATEST request may
      // mutate state. A stale single-match response must NEVER auto-resume —
      // it could open the WRONG session.
      const seq = ++resolveSeqRef.current
      setMatchCwdError(false)
      setPhase({ kind: 'resolving' })
      let response
      try {
        response = ResumeResolveResponseSchema.parse(
          await api.post<unknown>('/api/sessions/resolve', { input: trimmed }),
        )
      } catch {
        if (seq !== resolveSeqRef.current) return // stale — ignore
        setPhase({ kind: 'request-failed' })
        return
      }
      if (seq !== resolveSeqRef.current) return // stale — ignore
      // Prefill the working directory with the server's CONCRETE home instead
      // of the '~' sentinel — but never clobber a user-edited value.
      if (response.homeDir && !cwdTouchedRef.current) setAnywayCwd(response.homeDir)
      if (response.status === 'degraded') {
        // Provider unavailable ≠ not found — and it must NEVER reach the
        // auto-resume below: a failed provider means a higher-priority exact
        // match may have been missed, so auto-opening a surviving match could
        // open the WRONG session. Surviving matches render for MANUAL
        // confirmation; retry is MANUAL only (the server already schedules an
        // index refresh on every degraded response, so Retry converges).
        setPhase({
          kind: 'degraded',
          matches: response.matches,
          providerErrors: response.providerErrors,
        })
        return
      }
      if (response.status !== 'ready') {
        // Warming is a retry state, never "not found" — and it must NEVER
        // reach the auto-resume below.
        if (warmingRetriesRef.current >= WARMING_RETRY_LIMIT) {
          setPhase({ kind: 'index-unavailable' })
          return
        }
        warmingRetriesRef.current += 1
        setPhase({ kind: 'warming' })
        return
      }
      // Auto-resume needs a healthy response AND a concrete recorded cwd: a
      // lone match without one renders in the match list below alongside an
      // editable working-directory field (spec: never open without a cwd).
      if (response.matches.length === 1 && response.matches[0].cwd) {
        const found = response.matches[0]
        finishResume(found, `Found in ${found.provider}`)
        return
      }
      if (response.matches.length >= 1) {
        setPhase({ kind: 'disambiguate', matches: response.matches })
        return
      }
      // Absence claims must name what was NOT searched (disabled providers) —
      // otherwise "not found" implies the id does not exist anywhere.
      setPhase({ kind: 'no-match', unsearchedProviders: response.unsearchedProviders })
    },
    [finishResume],
  )

  // User-initiated resolves reset the warming auto-retry budget.
  const resolveFromUser = useCallback(
    (text: string) => {
      warmingRetriesRef.current = 0
      return resolveInput(text)
    },
    [resolveInput],
  )

  // Warming is NOT "not found": keep re-resolving until the index is ready —
  // but only within the WARMING_RETRY_LIMIT budget (readiness can stick false
  // forever if the indexer start rejects; see the constant's comment).
  useEffect(() => {
    if (phase.kind !== 'warming') return
    const timer = window.setInterval(() => {
      void resolveInput(inputRef.current?.value ?? '')
    }, WARMING_RETRY_MS)
    return () => window.clearInterval(timer)
  }, [phase.kind, resolveInput])

  useEffect(
    () => () => {
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  // Closing invalidates any in-flight resolve.
  useEffect(() => {
    if (!open) resolveSeqRef.current += 1
  }, [open])

  // Modal a11y (mirrors src/components/ui/confirm-modal.tsx): capture + restore
  // the previously focused element, lock background scroll, focus the paste field.
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    inputRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow || ''
      previousFocus?.focus()
    }
  }, [open])

  if (!open) return null

  const resumeAnyway = () => {
    const token = parseResumeInput(input).candidates[0]?.token
    if (!token) {
      setPhase({ kind: 'no-token' })
      return
    }
    // cwd-required gating: the button is disabled while the field is blank;
    // this is the backstop. '~' stays the documented server-home default.
    const cwd = anywayCwd.trim()
    if (cwd === '') return
    finishResume(
      {
        provider: agent,
        sessionId: token,
        sessionType: agent,
        cwd: cwd === '~' ? undefined : cwd,
      },
      `Resuming with ${agent}`,
    )
  }

  // Confirming a listed match: a match with a recorded cwd resumes directly; a
  // cwd-less match (exact-id fallback hit) requires the editable
  // working-directory field — a session must NEVER open from a blank field.
  const confirmMatch = (candidate: ResumeResolveMatch) => {
    if (candidate.cwd) {
      finishResume(candidate, `Found in ${candidate.provider}`)
      return
    }
    const cwd = anywayCwd.trim()
    if (cwd === '') {
      setMatchCwdError(true)
      return
    }
    finishResume(
      {
        provider: candidate.provider,
        sessionId: candidate.sessionId,
        sessionType: candidate.sessionType,
        cwd: cwd === '~' ? undefined : cwd,
        title: candidate.title,
        firstUserMessage: candidate.firstUserMessage,
      },
      `Found in ${candidate.provider}`,
    )
  }

  const controlClass =
    'min-w-0 flex-1 h-7 px-2 text-xs bg-muted/50 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border'

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      onClick={onClose}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- same convention as App.tsx's update-instructions dialog: the container's onClick is a stopPropagation shield and onKeyDown handles Escape; the dialog's real controls are native buttons/inputs. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Resume a session"
        data-testid="resume-dialog"
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 p-5 flex flex-col gap-3"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          // Focus trap — repo modal pattern (see src/components/ui/confirm-modal.tsx).
          const dialog = dialogRef.current
          if (!dialog) return
          const focusables = getFocusable(dialog)
          if (focusables.length === 0) {
            event.preventDefault()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement as HTMLElement | null
          if (event.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              event.preventDefault()
              last.focus()
            }
          } else if (active === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <h2 className="text-sm font-medium">Resume a session</h2>
        <label className="text-xs text-muted-foreground" htmlFor="resume-input">
          Paste a session id or a resume command
        </label>
        <textarea
          id="resume-input"
          data-testid="resume-input"
          ref={inputRef}
          value={input}
          rows={3}
          className="w-full text-xs bg-muted/50 border-0 rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-border resize-none"
          onChange={(event) => {
            setInput(event.target.value)
            // EDITING invalidates everything derived from the previous text:
            // bump the sequence so in-flight responses go stale, and reset the
            // phase so stale "Resume anyway"/disambiguation actions can never
            // act on old tokens.
            resolveSeqRef.current += 1
            setMatchCwdError(false)
            setPhase({ kind: 'idle' })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void resolveFromUser(event.currentTarget.value)
            }
          }}
          onPaste={() => {
            // Paste-then-Enter fast path: auto-resolve once the value lands.
            window.setTimeout(() => {
              void resolveFromUser(inputRef.current?.value ?? '')
            }, 0)
          }}
        />
        <button
          type="button"
          data-testid="resume-resolve-button"
          onClick={() => void resolveFromUser(input)}
          disabled={phase.kind === 'resolving'}
          className="h-8 px-3 text-xs rounded-md bg-muted/50 hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50"
        >
          {phase.kind === 'resolving' ? 'Resolving…' : 'Resume'}
        </button>

        {phase.kind === 'warming' && (
          <div data-testid="resume-warming" className="text-xs text-muted-foreground" role="status">
            Session index is still warming — retrying…
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => void resolveFromUser(input)}
            >
              Retry now
            </button>
          </div>
        )}
        {phase.kind === 'index-unavailable' && (
          <div
            data-testid="resume-index-unavailable"
            role="alert"
            className="text-xs text-destructive"
          >
            Session index unavailable — retry manually.
            <button
              type="button"
              data-testid="resume-index-retry"
              className="ml-2 underline"
              onClick={() => void resolveFromUser(input)}
            >
              Retry
            </button>
          </div>
        )}
        {phase.kind === 'degraded' && (
          <div data-testid="resume-degraded" role="alert" className="text-xs text-destructive">
            Some agents could not be searched:{' '}
            {phase.providerErrors
              .map(
                (entry) =>
                  `${entry.provider}${entry.code ? ` (${entry.code})` : ''}${entry.message ? ` — ${entry.message}` : ''}`,
              )
              .join('; ')}
            .
            {phase.matches.length > 0
              ? ' The matches below may be incomplete — confirm one manually or retry.'
              : ' This is not a "not found".'}
            <button
              type="button"
              data-testid="resume-degraded-retry"
              className="ml-2 underline"
              onClick={() => void resolveFromUser(input)}
            >
              Retry
            </button>
          </div>
        )}
        {phase.kind === 'no-token' && (
          <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
            No session id found in the pasted text.
          </div>
        )}
        {phase.kind === 'request-failed' && (
          <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
            Could not reach the server. Try again.
          </div>
        )}
        {phase.kind === 'resumed' && (
          <div data-testid="resume-note" role="status" className="text-xs text-muted-foreground">
            {phase.note}
          </div>
        )}
        {(phase.kind === 'disambiguate' || phase.kind === 'degraded') && phase.matches.length > 0 && (
          <ul data-testid="resume-match-list" className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {phase.matches.map((candidate) => (
              <li key={`${candidate.provider}:${candidate.sessionId}`}>
                <button
                  type="button"
                  data-testid="resume-match"
                  className="w-full text-left text-xs p-2 rounded-md bg-muted/50 hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border"
                  onClick={() => confirmMatch(candidate)}
                >
                  <span className="font-medium">
                    {candidate.title ?? candidate.firstUserMessage ?? candidate.sessionId}
                  </span>
                  <span className="block text-muted-foreground">
                    {candidate.provider} · {candidate.sessionId.slice(0, 12)}…
                    {candidate.cwd ? ` · ${candidate.cwd}` : ''}
                    {typeof candidate.lastActivityAt === 'number'
                      ? ` · ${new Date(candidate.lastActivityAt).toLocaleString()}`
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {(phase.kind === 'disambiguate' || phase.kind === 'degraded') &&
          phase.matches.some((candidate) => !candidate.cwd) && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor="resume-anyway-cwd">
                cwd
              </label>
              <input
                id="resume-anyway-cwd"
                data-testid="resume-anyway-cwd"
                value={anywayCwd}
                onChange={(event) => {
                  cwdTouchedRef.current = true
                  setAnywayCwd(event.target.value)
                  setMatchCwdError(false)
                }}
                className={controlClass}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Required for sessions without a recorded working directory. ~ resolves to the
              server&apos;s home directory.
            </p>
            {matchCwdError && (
              <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
                Enter a working directory to open this session.
              </div>
            )}
          </div>
        )}
        {phase.kind === 'no-match' && (
          <div className="flex flex-col gap-2">
            <div data-testid="resume-error" role="alert" className="text-xs text-destructive">
              {phase.unsearchedProviders.length > 0
                ? `No matching session found. Not searched (disabled): ${phase.unsearchedProviders.join(', ')}.`
                : "No matching session found in any agent's store."}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor="resume-anyway-cwd">
                cwd
              </label>
              <input
                id="resume-anyway-cwd"
                data-testid="resume-anyway-cwd"
                value={anywayCwd}
                onChange={(event) => {
                  cwdTouchedRef.current = true
                  setAnywayCwd(event.target.value)
                }}
                className={controlClass}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              ~ resolves to the server&apos;s home directory.
            </p>
            <button
              type="button"
              data-testid="resume-anyway-button"
              onClick={resumeAnyway}
              disabled={anywayCwd.trim() === ''}
              className="h-8 px-3 text-xs rounded-md bg-muted/50 hover:bg-muted focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Resume anyway with {agent}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
