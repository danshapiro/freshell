/** Display native child outcomes without substituting tool-call completion. */
export function childActivitySummary(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return typeof value === 'string' ? value : ''
  const state = value as Record<string, unknown>
  const labels: Record<string, string> = { nativeStatus: 'Activity', status: 'Status', model: 'Model', reasoningEffort: 'Thinking', message: 'Message', result: 'Result', error: 'Error' }
  return ['nativeStatus', 'status', 'model', 'reasoningEffort', 'message', 'result', 'error']
    .filter((key) => state[key] != null && state[key] !== '')
    .map((key) => `${labels[key]}: ${typeof state[key] === 'string' ? state[key] : JSON.stringify(state[key])}`)
    .join(' · ')
}
