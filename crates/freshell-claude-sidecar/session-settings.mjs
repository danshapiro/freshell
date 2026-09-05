const SETTING_KEYS = ['model', 'effort', 'permissionMode', 'cwd']

/** Apply only explicitly supplied settings. The caller serializes this with sends. */
export async function configureSession(session, requested, { busy = false } = {}) {
  const next = { ...session.settings }
  for (const key of SETTING_KEYS) {
    if (requested[key] !== undefined && (requested[key] !== null || key === 'effort')) next[key] = requested[key] ?? undefined
  }
  if (next.model !== session.settings.model && requested.effort === undefined) next.effort = undefined
  const changed = SETTING_KEYS.filter((key) => next[key] !== session.settings[key])
  if (changed.length === 0) return { ...session.settings }
  if (busy) throw new Error('Wait for the current turn to finish before changing agent settings.')
  if (changed.includes('cwd')) throw new Error('Start a new conversation to change the working directory.')

  if (changed.includes('model')) {
    await session.query.setModel(next.model)
    session.settings.model = next.model
  }
  if (changed.includes('effort')) {
    await session.query.applyFlagSettings({ effortLevel: next.effort ?? null })
    session.settings.effort = next.effort
  }
  if (changed.includes('permissionMode')) {
    await session.query.setPermissionMode(next.permissionMode)
    session.permissionMode = next.permissionMode
    session.settings.permissionMode = next.permissionMode
  }
  session.settings = next
  session.permissionMode = next.permissionMode
  return { ...next }
}

export function userMessageContent(text, images = []) {
  const content = [{ type: 'text', text }]
  for (const image of images ?? []) {
    if (image.kind === 'data' || image.kind == null) {
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
    } else if (image.kind === 'url') {
      content.push({ type: 'image', source: { type: 'url', url: image.url } })
    } else {
      throw new Error('This image attachment cannot be read by Claude. Attach the file again.')
    }
  }
  return content
}

export function resultErrorMessage(result) {
  if (result.subtype === 'success') return undefined
  const messages = Array.isArray(result.errors) ? result.errors.filter((message) => typeof message === 'string' && message.trim()) : []
  if (messages.length) return messages.join('\n')
  switch (result.subtype) {
    case 'error_max_turns': return 'Claude reached its turn limit. Send a message to continue.'
    case 'error_max_budget_usd': return 'Claude reached the configured spending limit.'
    case 'error_max_structured_output_retries': return 'Claude could not produce the requested response format.'
    default: return 'Claude could not complete this turn. Try sending your message again.'
  }
}
