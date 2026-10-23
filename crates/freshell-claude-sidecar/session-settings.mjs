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

/** The send-rejection code for an image the sidecar will not hand to the CLI. */
export const INVALID_IMAGE = 'INVALID_IMAGE'

/** The image types the Claude Messages API reads. */
const READABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const UNREADABLE_IMAGE = 'This image attachment cannot be read by Claude. Attach the file again.'

function invalidImage(message) {
  const error = new Error(message)
  error.code = INVALID_IMAGE
  return error
}

/** One image as a content block; throws an INVALID_IMAGE error for one Claude cannot read. */
function imageBlock(image) {
  if (image?.kind === 'data' || (image != null && image.kind == null)) {
    if (typeof image.mediaType !== 'string' || !READABLE_IMAGE_TYPES.has(image.mediaType)) {
      const what = typeof image.mediaType === 'string' && image.mediaType ? image.mediaType : 'this attachment'
      throw invalidImage(`Claude cannot read ${what} as an image. Attach a PNG, JPEG, GIF or WebP image.`)
    }
    if (typeof image.data !== 'string' || !BASE64.test(image.data)) throw invalidImage(UNREADABLE_IMAGE)
    return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }
  }
  if (image?.kind === 'url' && typeof image.url === 'string' && /^https?:\/\//i.test(image.url)) {
    return { type: 'image', source: { type: 'url', url: image.url } }
  }
  throw invalidImage(UNREADABLE_IMAGE)
}

/**
 * The content of a user message: the text, then each image. An image Claude
 * cannot read (an unsupported type, missing or non-base64 data, an unknown
 * kind, a URL that is not http or https) throws an error whose `code` is
 * INVALID_IMAGE, before anything reaches the CLI.
 */
export function userMessageContent(text, images = []) {
  return [{ type: 'text', text }, ...(images ?? []).map(imageBlock)]
}
