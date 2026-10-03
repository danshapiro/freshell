const BLOCKED_REASONS: Record<string, string> = {
  CAPABILITY_PENDING: 'The provider is still preparing its recovery support. Wait, then retry recovery.',
  CREDENTIALS_EXPIRED: 'Refresh the provider sign-in, then retry recovery.',
  RATE_LIMITED: 'The provider is limiting requests. Wait, then retry recovery.',
  PROVIDER_UNAVAILABLE: 'The provider is unavailable. Check its availability, then retry recovery.',
  STORE_UNREADABLE: 'Check that the saved conversation store is readable, then retry recovery.',
  STORE_MISSING: 'Restore the saved conversation store, then retry recovery.',
  WORKSPACE_UNAVAILABLE: 'Restore access to the project folder, then retry recovery.',
  INCOMPATIBLE_BINARY: 'The installed provider version cannot recover this session. Check the provider installation, then retry recovery.',
  UNSUPPORTED_PROTOCOL: 'The installed provider cannot use this recovery connection. Check the provider installation, then retry recovery.',
  AMBIGUOUS_IDENTITY: 'The saved conversation could not be identified with certainty. Check the provider conversation store before retrying recovery.',
  IMPLEMENTATION_UNAVAILABLE: 'Recovery support is unavailable for this provider. Check the provider installation before retrying recovery.',
  INSUFFICIENT_RESOURCES: 'There are not enough system resources. Free resources, then retry recovery.',
  RETRY_BUDGET: 'Automatic recovery attempts have been exhausted. Check the provider and saved conversation store, then retry recovery.',
  STOP_INTENT: 'This session was requested to stop. Check its state before retrying recovery.',
  OLD_RUNTIME_NOT_EMPTY: 'The previous agent process could not be confirmed stopped. Check it before retrying recovery.',
  WRONG_NATIVE_IDENTITY: 'The provider returned a different conversation. Check the saved conversation identity before retrying recovery.',
  COMMAND_AMBIGUOUS: 'The provider command could not be confirmed. Check its state before retrying recovery.',
  INTERRUPTED_BEFORE_OWNERSHIP_COMMIT: 'The previous agent startup was interrupted. Check its process state before retrying recovery.',
}

export function managedRecoveryBlockedMessage(reason?: string): string {
  const known = reason && BLOCKED_REASONS[reason.trim().toUpperCase()]
  return known || (reason?.trim()
    ? `Recovery is blocked: ${reason.trim()}. Address this problem, then retry recovery.`
    : 'Recovery is still blocked. Check the provider, project folder, and saved conversation store, then retry recovery.')
}
