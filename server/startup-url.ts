/**
 * Resolves the port visitors should use to access Freshell.
 * In dev mode, Vite serves the frontend on its own port (default 5173).
 * In production, the Express server serves everything on the server port.
 */
export function resolveVisitPort(serverPort: number, env: NodeJS.ProcessEnv): number {
  const isProduction = env.NODE_ENV === 'production'
  return isProduction ? serverPort : Number(env.VITE_PORT || 5173)
}
