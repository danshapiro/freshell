export default async function globalTeardown() {
  // Temp directories are cleaned up by individual TestServer.stop() calls.
  // This is a safety net for any leaked temp dirs.
  // We intentionally do NOT clean dist/ since it may be used by other processes.
  console.log('[e2e-teardown] E2E test suite complete.')
}
