const providerStartCauses = new Set([
  'preparation_superseded', 'exact_resume_superseded', 'replacement_superseded',
  'exact_resume_validation', 'exact_resume_app_server_start', 'exact_resume_rpc',
  'exact_resume_create_rejected', 'exact_resume_identity', 'exact_resume_settings_reapply',
  'replacement_validation', 'replacement_app_server_start', 'replacement_thread_start',
  'replacement_create_finalize', 'replacement_create_rejected', 'replacement_identity',
  'unsupported',
])

export function safeNativeReadinessProviderStartCause(value: unknown): string | undefined {
  return typeof value === 'string' && providerStartCauses.has(value) ? value : undefined
}

export function isNativeReadinessDiagnosticEvent(value: unknown): boolean {
  return value === 'host.fresh_agent.open_failed'
    || value === 'host.native_identity.readiness_failed'
    || value === 'host.native_identity.readiness_receipt_committed'
    || value === 'host.grant_timing'
}
