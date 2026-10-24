import type { ServerSettings } from '@shared/settings'
import { DEFAULT_FRESH_AGENT_STYLE } from '@shared/settings'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { normalizeFreshAgentEffortOverride, normalizeFreshAgentModelSelection } from '@/store/paneTypes'
import { getFreshAgentProviderConfig, isFreshAgentProviderName } from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentPaneCreateEffort, resolveFreshAgentPaneModelDefaults, type FreshAgentRegistryEntry } from '@/lib/fresh-agent-registry'

/** The new-pane settings shared by the picker and the REST parity fixtures. */
export function buildFreshAgentPaneContent({
  entry: freshAgentType,
  freshAgentSettings,
  codingCliSettings,
  createRequestId,
  cwd,
  checkpointWorkspace,
}: {
  entry: FreshAgentRegistryEntry
  freshAgentSettings?: ServerSettings['freshAgent']
  codingCliSettings?: ServerSettings['codingCli']
  createRequestId: string
  cwd?: string
  checkpointWorkspace?: FreshAgentPaneContent['checkpointWorkspace']
}): FreshAgentPaneContent {
  const type = freshAgentType.sessionType
  const providerConfig = freshAgentType.runtimeProvider === 'claude' && isFreshAgentProviderName(type)
    ? getFreshAgentProviderConfig(type)
    : undefined
  const providerSettings = freshAgentSettings?.providers?.[type]
  const { model, persistModel: shouldPersistPaneModel, modelEffortLevels } = resolveFreshAgentPaneModelDefaults({
    entry: freshAgentType,
    providerSettings,
    runtimeProviderModel: codingCliSettings?.providers?.[freshAgentType.runtimeProvider]?.model,
  })
  const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
    ? undefined
    : providerSettings?.defaultPermissionMode
      ?? (freshAgentType.runtimeProvider === 'codex'
        ? codingCliSettings?.providers?.[freshAgentType.runtimeProvider]?.permissionMode
        : undefined)
      ?? providerConfig?.defaultPermissionMode
      ?? freshAgentType.defaultPermissionMode
  const createEffort = resolveFreshAgentPaneCreateEffort({
    sessionType: freshAgentType.sessionType,
    provider: freshAgentType.runtimeProvider,
    model,
    providerEffort: normalizeFreshAgentEffortOverride(providerSettings?.effort),
    fallbackEffort: freshAgentType.defaultEffort,
    modelEffortLevels,
  })
  return {
    kind: 'fresh-agent',
    sessionType: freshAgentType.sessionType,
    provider: freshAgentType.runtimeProvider,
    createRequestId,
    status: 'creating',
    modelSelection: normalizeFreshAgentModelSelection(providerSettings?.modelSelection),
    ...(shouldPersistPaneModel ? { model } : {}),
    ...(modelEffortLevels ? { modelEffortLevels } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    sandbox: freshAgentType.runtimeProvider === 'codex'
      ? codingCliSettings?.providers?.[freshAgentType.runtimeProvider]?.sandbox
      : undefined,
    // Undefined effort is meaningful for opencode live-catalog models:
    // the Default row (no variant) persists as the provider default.
    ...(createEffort ? { effort: createEffort } : {}),
    plugins: freshAgentType.runtimeProvider === 'claude' ? freshAgentSettings?.defaultPlugins : undefined,
    style: providerSettings?.style ?? DEFAULT_FRESH_AGENT_STYLE,
    ...(cwd ? { initialCwd: cwd } : {}),
    ...(checkpointWorkspace ? { checkpointWorkspace } : {}),
  }
}
