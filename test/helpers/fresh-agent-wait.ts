export async function waitFor<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    // Pace one-read observation callbacks; other API calls share the budget.
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

export async function waitForFreshAgentFrame(frames: any[], predicate: (frame: any) => boolean, deadline = Date.now() + 90_000): Promise<any> {
  while (Date.now() < deadline) {
    const frame = frames.find(predicate)
    if (frame !== undefined && Date.now() < deadline) return frame
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))))
  }
  throw new Error(`Error: timed out waiting for fresh-agent frame; recent frames: ${JSON.stringify(frames.slice(-12))}`)
}
