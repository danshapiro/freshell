import { useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'

export type FreshAgentNotice = { id: string; text: string; prominent?: boolean }
export type FreshAgentError = { id: string; summary: string; content: ReactNode; level?: 'warning' | 'error'; initiallyExpanded?: boolean; onToggle?: (expanded: boolean) => void }

function NoticeDisclosure({ children, errorId, initiallyExpanded, onExpandedChange }: {
  children: ReactNode
  errorId?: string
  initiallyExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded ?? false)
  useLayoutEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])

  return <details open={expanded} data-agent-error={errorId} onToggle={event => setExpanded(event.currentTarget.open)}>{children}</details>
}

/** Keep request controls separate; diagnostic bodies stay mounted across toggles. */
export function FreshAgentNoticeStack({ notices, errors, onNoticesExpandedChange }: {
  notices: FreshAgentNotice[]
  errors: FreshAgentError[]
  onNoticesExpandedChange?: (expanded: boolean) => void
}) {
  const summarizeNotice = (text: string) => text.length > 160 ? `${text.slice(0, 160)}…` : text
  const latestRoutineNotice = [...notices].reverse().find(notice => !notice.prominent)
  const noticeSummary = notices.length === 1 ? summarizeNotice(notices[0].text) : <>
    {notices.length} notices
    {latestRoutineNotice ? <span className="fresh-agent-notice-summary">{summarizeNotice(latestRoutineNotice.text)}</span> : null}
    {notices.filter(notice => notice.prominent).map(notice => <span key={notice.id} className="fresh-agent-notice-summary">{summarizeNotice(notice.text)}</span>)}
  </>
  const warningCount = errors.filter(error => error.level === 'warning').length
  const errorCount = errors.length - warningCount
  const diagnosticCount = [
    ...(errorCount ? [`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`] : []),
    ...(warningCount ? [`${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`] : []),
  ].join(', ')
  return <>
    {notices.length ? (
      <div className="fresh-agent-notices" role="status" aria-label="Agent notices">
        <NoticeDisclosure onExpandedChange={onNoticesExpandedChange}>
          <summary>
            {noticeSummary}
            <span className="ml-2">Notice details</span>
          </summary>
          <div className="fresh-agent-diagnostic-body">
            {notices.map(notice => <p key={notice.id} data-agent-notice={notice.id}>{notice.text}</p>)}
          </div>
        </NoticeDisclosure>
      </div>
    ) : null}
    {errors.length ? (
      <div className="fresh-agent-errors" role="region" aria-label="Agent errors">
        <span role="img" aria-label={diagnosticCount} title={diagnosticCount} className="fresh-agent-diagnostic-count text-xs text-muted-foreground">{errors.length}</span>
        <div className="fresh-agent-error-summaries">{errors.map(error => (
          <NoticeDisclosure key={error.id} errorId={error.id} initiallyExpanded={error.initiallyExpanded} onExpandedChange={error.onToggle}>
            <summary aria-label={error.summary}><span role="alert" aria-label={error.level === 'warning' ? 'Agent warning' : undefined}>{error.summary}</span></summary>
            {error.content !== null ? <div className="fresh-agent-diagnostic-body">{error.content}</div> : null}
          </NoticeDisclosure>
        ))}</div>
      </div>
    ) : null}
  </>
}
