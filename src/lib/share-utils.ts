export type ShareAction =
  | { type: 'wizard'; initialStep: 1 | 2 }
  | { type: 'panel' }
  | { type: 'loading' }

export function ensureShareUrlToken(url: string, token: string | null | undefined): string {
  if (!token) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('token', token)
    return parsed.toString()
  } catch {
    return url
  }
}

export function getShareAction(status: { configured: boolean; host: string } | null): ShareAction {
  // When network status hasn't loaded yet, return loading to prevent
  // incorrectly routing already-configured users to the setup wizard
  // (network status is fetched asynchronously on app load).
  if (status === null) return { type: 'loading' }

  // IMPORTANT: The `host` field reflects the EFFECTIVE host (accounting for
  // HOST env override when configured=false). So host=0.0.0.0 means remote
  // access IS active regardless of the configured flag. This handles legacy
  // HOST=0.0.0.0 deployments that have configured=false but are fully
  // network-accessible.
  if (status.host === '0.0.0.0') {
    // Remote access is active — show the share panel (QR code, URL, etc.)
    // regardless of whether the user ran the wizard.
    return { type: 'panel' }
  }
  if (!status.configured) {
    // localhost-only AND unconfigured — user hasn't run the wizard yet
    return { type: 'wizard', initialStep: 1 }
  }
  // configured=true, host=127.0.0.1 — user explicitly chose localhost-only.
  // Show wizard at step 2 so they can re-enable remote access.
  return { type: 'wizard', initialStep: 2 }
}
