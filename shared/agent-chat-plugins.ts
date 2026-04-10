function normalizePluginPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim()
}

export function isLegacyFreshellOrchestrationPluginPath(value: string): boolean {
  const normalized = normalizePluginPath(value)
  return normalized === '.claude/plugins/freshell-orchestration'
    || normalized.endsWith('/.claude/plugins/freshell-orchestration')
}

export function sanitizeAgentChatPluginPaths(paths: readonly string[] | undefined): string[] {
  if (!paths) return []
  return paths
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.length > 0)
    .filter(value => !isLegacyFreshellOrchestrationPluginPath(value))
}
