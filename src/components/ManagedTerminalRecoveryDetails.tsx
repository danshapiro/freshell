import type { ManagedRuntimeProjectionFields } from '../../shared/managed-runtime.js'
import { managedTerminalRecoveryLabel } from '../lib/managed-terminal.js'

export default function ManagedTerminalRecoveryDetails({ terminal }: { terminal: ManagedRuntimeProjectionFields }) {
  const label = managedTerminalRecoveryLabel(terminal)
  const summary = terminal.recoverySummary
  if (!label || !summary) return null
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-2">
        <span>{label}</span>
        {summary.reason && <span>{summary.reason}</span>}
      </div>
      {summary.attemptId && <div>Attempt {summary.attemptId}</div>}
      {summary.incidentId && <div>Incident {summary.incidentId}</div>}
    </div>
  )
}
