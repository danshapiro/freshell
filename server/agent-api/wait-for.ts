export async function waitForMatch(
  getText: () => string,
  pattern: RegExp,
  { timeoutMs = 30000, intervalMs = 200 }: { timeoutMs?: number; intervalMs?: number },
) {
  const start = Date.now()
  return new Promise<{ matched: boolean }>((resolve) => {
    const tick = () => {
      const text = getText()
      if (pattern.test(text)) return resolve({ matched: true })
      if (Date.now() - start >= timeoutMs) return resolve({ matched: false })
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}
