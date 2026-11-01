import type { ReactNode } from 'react'

export type FreshAgentNotice = { id: string; text: string }
export type FreshAgentError = { id: string; summary: string; content: ReactNode }

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
          </summary>
          <div className="fresh-agent-diagnostic-body">
            {notices.map(notice => <p key={notice.id}>{notice.text}</p>)}
          </div>
        </details>
      </div>
    ) : null}
    {errors.length ? (
      <div className="fresh-agent-errors" aria-label="Agent errors">
        <span className="text-xs text-muted-foreground">{errors.length} {errors.length === 1 ? 'error' : 'errors'}</span>
        {errors.map(error => (
          <details key={error.id} data-agent-error={error.id}>
            <summary><span role="alert">{error.summary}</span></summary>
            <div className="fresh-agent-diagnostic-body">{error.content}</div>
          </details>
        ))}
      </div>
    ) : null}
  </>
}
