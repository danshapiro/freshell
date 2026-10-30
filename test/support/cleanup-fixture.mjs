/**
 * Always attempt every teardown stage and the fixture owner, even if an exact
 * child refuses shutdown. Preserve each failure after containment has run.
 */
export async function cleanupFixture(fixture, ...steps) {
  const errors = []
  for (const step of [...steps, () => fixture.cleanup()]) {
    try { await step() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'fixture teardown failed')
}
