import type { ReactNode } from 'react'

export type FreshAgentNotice = { id: string; text: string; prominent?: boolean }
export type FreshAgentError = { id: string; summary: string; content: ReactNode; level?: 'warning' | 'error'; onToggle?: (expanded: boolean) => void }

/** Keep request controls separate; diagnostic bodies stay mounted across toggles. */
export function FreshAgentNoticeStack({ notices, errors }: {
  notices: FreshAgentNotice[]
  errors: FreshAgentError[]
}) {
  const routineNotices = notices.filter(notice => !notice.prominent)
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
        {routineNotices.length ? <details>
          <summary>
            {noticeSummary}
            <span className="ml-2">Notice details</span>
          </summary>
          <div className="fresh-agent-diagnostic-body">
            {routineNotices.map(notice => <p key={notice.id} data-agent-notice={notice.id}>{notice.text}</p>)}
          </div>
        </details> : <div>{noticeSummary}</div>}
      </div>
    ) : null}
    {errors.length ? (
      <div className="fresh-agent-errors" role="region" aria-label="Agent errors">
        <span className="text-xs text-muted-foreground">{diagnosticCount}</span>
        {errors.map(error => (
          <details key={error.id} data-agent-error={error.id} onToggle={event => error.onToggle?.(event.currentTarget.open)}>
            <summary aria-label={error.summary}><span role="alert" aria-label={error.level === 'warning' ? 'Agent warning' : undefined}>{error.summary}</span></summary>
            {error.content !== null ? <div className="fresh-agent-diagnostic-body">{error.content}</div> : null}
          </details>
        ))}
      </div>
    ) : null}
  </>
}
