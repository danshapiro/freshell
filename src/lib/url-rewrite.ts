const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Returns true if the hostname refers to the local machine.
 * Handles both bare (::1) and bracketed ([::1]) IPv6 forms.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/**
 * When accessing Freshell remotely, rewrite localhost/127.0.0.1/[::1] URLs
 * so the browser resolves them to the host machine instead of the remote
 * client's own machine.
 *
 * If the user is already accessing from localhost, URLs are returned unchanged.
 *
 * @param url - The URL entered by the user (e.g. "http://localhost:3000")
 * @param currentHostname - The hostname the user is accessing Freshell from
 *                          (i.e. window.location.hostname)
 */
export function rewriteLocalhostUrl(url: string, currentHostname: string): string {
  if (isLoopbackHostname(currentHostname)) return url

  try {
    const parsed = new URL(url)

    // Only rewrite http/https URLs pointing at loopback
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHostname(parsed.hostname)
    ) {
      parsed.hostname = currentHostname
      return parsed.toString()
    }
  } catch {
    // Not a valid URL, return as-is
  }

  return url
}
