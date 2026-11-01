import type { ReactNode } from 'react'

export type FreshAgentNotice = { id: string; text: string; prominent?: boolean }
export type FreshAgentError = { id: string; summary: string; content: ReactNode; level?: 'warning' | 'error' }

/** Keep request controls separate; diagnostic bodies stay mounted across toggles. */
export function FreshAgentNoticeStack({ notices, errors }: {
  notices: FreshAgentNotice[]
  errors: FreshAgentError[]
}) {
  return <>
    {notices.length ? (
      <div className="fresh-agent-notices" role="status" aria-label="Agent notices">
        <details>
          <summary>
            {notices.length} {notices.length === 1 ? 'notice' : 'notices'}
            <span className="ml-2">Notice details</span>
            {notices.filter(notice => notice.prominent).map(notice => <span key={notice.id} className="fresh-agent-notice-summary">{notice.text}</span>)}
          </summary>
          <div className="fresh-agent-diagnostic-body">
            {notices.filter(notice => !notice.prominent).map(notice => <p key={notice.id} data-agent-notice={notice.id}>{notice.text}</p>)}
          </div>
        </details>
      </div>
    ) : null}
    {errors.length ? (
      <div className="fresh-agent-errors" role="region" aria-label="Agent errors">
        <span className="text-xs text-muted-foreground">{errors.length} {errors.length === 1 ? 'error' : 'errors'}</span>
        {errors.map(error => error.content === null ? (
          <p key={error.id} data-agent-error={error.id} role="alert" aria-label={error.level === 'warning' ? 'Agent warning' : undefined}>{error.summary}</p>
        ) : (
          <details key={error.id} data-agent-error={error.id}>
            <summary><span role="alert" aria-label={error.level === 'warning' ? 'Agent warning' : undefined}>{error.summary}</span></summary>
            <div className="fresh-agent-diagnostic-body">{error.content}</div>
          </details>
        ))}
      </div>
    ) : null}
  </>
}
