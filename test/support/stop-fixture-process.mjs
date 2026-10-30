const DEFAULT_GRACEFUL_TIMEOUT_MS = 3_000
const DEFAULT_FORCE_TIMEOUT_MS = 3_000

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Wait for one exact captured child, disposing both the listener and deadline
 * on every outcome. It never leaves a timer or an exit listener running after
 * the caller has resumed teardown.
 */
function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    let timer

    const finish = (exited) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)

    child.once('exit', onExit)
    timer = setTimeout(() => finish(false), timeoutMs)
    // The child can exit between the initial state check and listener setup.
    if (hasExited(child)) finish(true)
  })
}

function sendExactSignal(child, signal) {
  let delivered
  try {
    delivered = child.kill(signal)
  } catch (error) {
    throw new Error(`sending ${signal} to the captured fixture process failed`, { cause: error })
  }
  if (!delivered && !hasExited(child)) {
    throw new Error(`the captured fixture process rejected ${signal}`)
  }
}

/**
 * Require a protocol-requested exit before fallback cleanup sends a signal.
 * A cleanup SIGTERM can exit with code zero; it cannot prove that the earlier
 * shutdown request worked, so a missed deadline must remain a test failure.
 * @param {import('./stop-fixture-process.js').FixtureProcess} child
 * @param {number} timeoutMs
 */
export async function waitForFixtureProcessExit(child, timeoutMs) {
  if (!await waitForExit(child, timeoutMs)) {
    throw new Error(`captured fixture process did not exit within ${timeoutMs}ms after protocol shutdown`)
  }
}

/**
 * Contain a fixture process before its scratch directory is removed. SIGTERM
 * gets one bounded grace period; a surviving exact child receives SIGKILL and
 * must then prove exit before this resolves. A survivor is a teardown error,
 * not a reason to race its writes with directory removal.
 * @param {import('./stop-fixture-process.js').FixtureProcess | undefined} child
 * @param {import('./stop-fixture-process.js').StopFixtureProcessOptions} [options]
 */
export async function stopFixtureProcess(child, options = {}) {
  if (!child || hasExited(child)) return

  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS
  const forceTimeoutMs = options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS

  sendExactSignal(child, 'SIGTERM')
  if (await waitForExit(child, gracefulTimeoutMs)) return

  sendExactSignal(child, 'SIGKILL')
  if (!await waitForExit(child, forceTimeoutMs)) {
    throw new Error(`captured fixture process did not exit within ${forceTimeoutMs}ms after SIGKILL`)
  }
}
