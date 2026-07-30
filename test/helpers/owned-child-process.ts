import type { ChildProcess } from 'node:child_process'

function hasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForExit(child: ChildProcess, timeout: number) {
  const deadline = Date.now() + timeout
  while (!hasExited(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return hasExited(child)
}

/**
 * Stops a ChildProcess handle created by the current test before a Linux
 * process-birth identity was available. This seam is only for that narrow
 * initialization-failure window; established processes use exact birth tuples.
 */
export async function stopOwnedChildBeforeIdentity(
  child: ChildProcess,
  label: string,
) {
  if (hasExited(child)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, 5_000)) return
  child.kill('SIGKILL')
  if (await waitForExit(child, 5_000)) return
  throw new Error(`${label} did not exit after SIGTERM and SIGKILL`)
}
