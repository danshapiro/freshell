/**
 * Resolves the port visitors should use to access Freshell.
 * In dev mode, Vite serves the frontend on its own port (default 5173).
 * In production, the Express server serves everything on the server port.
 */
export function resolveVisitPort(serverPort: number, env: NodeJS.ProcessEnv): number {
  const isDev = env.NODE_ENV === 'development'
  return isDev ? Number(env.VITE_PORT || 5173) : serverPort
}

/**
 * Resolve the bind host address from CLI flags and environment.
 * Priority: --lan flag > --host flag > HOST env var > default (127.0.0.1).
 *
 * Defaults to 127.0.0.1 (localhost only) to prevent AUTH_TOKEN from
 * being exposed in cleartext on the LAN (no TLS).
 */
export function resolveBindHost(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  // Check for --lan flag (shorthand for --host 0.0.0.0)
  if (argv.includes('--lan')) {
    return '0.0.0.0'
  }

  // Check for --host <value> flag
  const hostIndex = argv.indexOf('--host')
  if (hostIndex !== -1 && hostIndex + 1 < argv.length) {
    return argv[hostIndex + 1]
  }

  // Fall back to HOST env var
  if (env.HOST) {
    return env.HOST
  }

  // Default: localhost only (secure by default)
  return '127.0.0.1'
}
