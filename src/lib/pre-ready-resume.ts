const trustedPreReadyResumeRequestIds = new Set<string>()

export function addPreReadyResumeAuthority(requestId?: string): void {
  if (!requestId) return
  trustedPreReadyResumeRequestIds.add(requestId)
}

export function hasPreReadyResumeAuthority(requestId?: string): boolean {
  if (!requestId) return false
  return trustedPreReadyResumeRequestIds.has(requestId)
}

export function clearPreReadyResumeAuthority(requestId?: string): void {
  if (!requestId) return
  trustedPreReadyResumeRequestIds.delete(requestId)
}
