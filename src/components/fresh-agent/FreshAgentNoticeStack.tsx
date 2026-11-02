import type { ReactNode } from 'react'

export type FreshAgentNotice = { id: string; text: string; prominent?: boolean; onToggle?: (expanded: boolean) => void }
export type FreshAgentError = { id: string; summary: string; content: ReactNode; level?: 'warning' | 'error'; onToggle?: (expanded: boolean) => void }

/** Keep request controls separate; diagnostic bodies stay mounted across toggles. */
export function FreshAgentNoticeStack({ notices, errors }: {
  notices: FreshAgentNotice[]
  errors: FreshAgentError[]
}) {
  const noticeSummary = <>
    {notices.length} {notices.length === 1 ? 'notice' : 'notices'}
    {notices.filter(notice => notice.prominent).map(notice => <span key={notice.id} className="fresh-agent-notice-summary">{notice.text}</span>)}
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
        <details onToggle={event => notices.forEach(notice => notice.onToggle?.(event.currentTarget.open))}>
          <summary>
            {noticeSummary}
            <span className="ml-2">Notice details</span>
          </summary>
          <div className="fresh-agent-diagnostic-body">
            {notices.map(notice => <p key={notice.id} data-agent-notice={notice.id}>{notice.text}</p>)}
          </div>
        </details>
      </div>
    ) : null}
    {errors.length ? (
      <div className="fresh-agent-errors" role="region" aria-label="Agent errors">
        <span aria-label={diagnosticCount} title={diagnosticCount} className="fresh-agent-diagnostic-count text-xs text-muted-foreground">{errors.length}</span>
        <div className="fresh-agent-error-summaries">{errors.map(error => (
          <details key={error.id} data-agent-error={error.id} onToggle={event => error.onToggle?.(event.currentTarget.open)}>
            <summary aria-label={error.summary}><span role="alert" aria-label={error.level === 'warning' ? 'Agent warning' : undefined}>{error.summary}</span></summary>
            {error.content !== null ? <div className="fresh-agent-diagnostic-body">{error.content}</div> : null}
          </details>
        ))}</div>
      </div>
    ) : null}
  </>
}
