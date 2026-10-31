import { useId, useState, type FormEvent } from 'react'
import type { FreshAgentElicitationContent, FreshAgentPendingElicitation } from '@shared/fresh-agent-contract'

type Props = {
  request: FreshAgentPendingElicitation
  disabled?: boolean
  onRespond: (action: 'accept' | 'decline' | 'cancel', content: FreshAgentElicitationContent | null) => void
}
const CONTROL = 'rounded border border-border bg-background px-2 py-1 text-sm disabled:opacity-50'
const ACTION = 'rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50'

export default function FreshAgentElicitationBanner({ request, disabled, onRespond }: Props) {
  const formId = useId()
  const [values, setValues] = useState<FreshAgentElicitationContent>(() => Object.fromEntries(
    (request.fields ?? [])
      .filter((field) => !field.secret && field.default !== undefined)
      .map((field) => [field.id, field.default!]),
  ))
  const [error, setError] = useState('')
  const set = (id: string, value: FreshAgentElicitationContent[string] | undefined) => {
    setValues((previous) => {
      const next = { ...previous }
      const required = request.fields?.find((field) => field.id === id)?.required
      const empty = value === '' || (Array.isArray(value) && value.length === 0)
      if (value === undefined || (empty && !required)) delete next[id]
      else next[id] = value
      return next
    })
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled) return
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity()
      return
    }
    for (const field of request.fields ?? []) {
      const value = values[field.id]
      if (field.required && (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))) {
        setError('Complete every required field.')
        return
      }
      if (Array.isArray(value) && ((field.minItems !== undefined && value.length < field.minItems) || (field.maxItems !== undefined && value.length > field.maxItems))) {
        setError('Choose the requested number of options.')
        return
      }
    }
    setError('')
    onRespond('accept', request.mode === 'url' ? null : values)
  }

  return (
    <form onSubmit={submit} role="region" aria-label={`Request from ${request.serverName}`} className="fresh-agent-elicitation-card space-y-3 rounded-md border border-sky-500/50 p-3">
      <p className="font-medium">{request.title ?? request.serverName}</p>
      <p>{request.message}</p>
      {request.mode === 'url' ? (
        <a href={request.url} target="_blank" rel="noreferrer" className="underline">Open {request.serverName} page</a>
      ) : (request.fields ?? []).map((field, index) => {
        const id = `${formId}-${index}`
        const value = values[field.id]
        const numeric = field.type === 'number' || field.type === 'integer'
        return (
          <div key={field.id} className="space-y-1">
            <label htmlFor={id}>{field.title}{field.required ? ' *' : ''}</label>
            {field.description ? <p className="text-xs">{field.description}</p> : null}
            {field.type === 'boolean' ? (
              <select id={id} aria-label={field.title} className={CONTROL} value={value === undefined ? '' : String(value)} required={field.required} disabled={disabled} onChange={(event) => set(field.id, event.target.value === '' ? undefined : event.target.value === 'true')}>
                <option value="">Choose</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : field.choices ? (
              <select id={id} aria-label={field.title} className={CONTROL} multiple={field.type === 'array'} value={(value as string | string[] | undefined) ?? (field.type === 'array' ? [] : '')} required={field.required} disabled={disabled} onChange={(event) => set(field.id, field.type === 'array' ? Array.from(event.target.selectedOptions).map((option) => option.value) : event.target.value)}>
                {field.type !== 'array' ? <option value="">Choose</option> : null}
                {field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            ) : (
              <input
                id={id}
                aria-label={field.title}
                type={field.secret ? 'password' : numeric ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'}
                placeholder={field.format === 'date-time' ? 'YYYY-MM-DDTHH:mm:ssZ' : undefined}
                value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                required={field.required}
                min={field.minimum}
                max={field.maximum}
                minLength={field.minLength}
                maxLength={field.maxLength}
                step={field.type === 'integer' ? 1 : 'any'}
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => set(field.id, numeric ? (event.target.value === '' ? undefined : event.target.valueAsNumber) : event.target.value)}
                className={CONTROL}
              />
            )}
          </div>
        )
      })}
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className={`${ACTION} bg-primary text-primary-foreground`} type="submit" disabled={disabled}>Continue</button>
        <button className={ACTION} type="button" disabled={disabled} onClick={() => onRespond('decline', null)}>Decline</button>
        <button className={ACTION} type="button" disabled={disabled} onClick={() => onRespond('cancel', null)}>Cancel</button>
      </div>
    </form>
  )
}
