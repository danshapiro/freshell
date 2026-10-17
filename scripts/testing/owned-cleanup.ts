/** Always attempt owned cleanup, retaining both failures for the test reporter. */
export async function withOwnedCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let operationFailed = false
  let primaryError: unknown
  try {
    return await operation()
  } catch (error) {
    operationFailed = true
    primaryError = error
    throw error
  } finally {
    try {
      await cleanup()
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError
      // Playwright traverses Error.cause, but does not render AggregateError.errors.
      // Keep the primary Error intact as the cause and include the cleanup stack
      // in the message so both failures remain visible in its normal report.
      const detail = cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError)
      throw new AggregateError([primaryError, cleanupError],
        `Operation and owned cleanup both failed.\nCleanup failure:\n${detail}`, { cause: primaryError })
    }
  }
}
