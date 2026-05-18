type FreshAgentComposerProps = {
  disabled?: boolean
  onSend?: (value: string) => void
}

export function FreshAgentComposer({ disabled = false, onSend }: FreshAgentComposerProps) {
  return (
    <form
      className="border-t border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const input = new FormData(form).get('message')
        const text = typeof input === 'string' ? input.trim() : ''
        if (!text || disabled) return
        onSend?.(text)
        form.reset()
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          name="message"
          aria-label="Chat message input"
          disabled={disabled}
          rows={2}
          placeholder={disabled ? 'Read-only session' : 'Send a message'}
          className="min-h-[52px] flex-1 resize-none rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}
