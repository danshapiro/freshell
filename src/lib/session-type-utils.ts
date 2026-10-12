import type { ManagedRuntimeProjectionFields } from '../../shared/managed-runtime.js'
import { managedTerminalProjection } from './managed-terminal.js'
import type { ComponentType } from 'react'
import { PROVIDER_ICONS, DefaultProviderIcon } from '@/components/icons/provider-icons'
import { isNonShellMode, getProviderLabel } from '@/lib/coding-cli-utils'
import { getFreshAgentProviderConfig } from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import type { FreshAgentProviderName, FreshAgentProviderSettings } from '@/lib/fresh-agent-provider-types'
import type { CodingCliProviderName } from '@/store/types'
import type {
  FreshAgentCheckpointWorkspace,
  FreshAgentPaneInput,
  TerminalPaneInput,
} from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  getPairedPublicSessionType,
  isPublicSessionType,
} from '@shared/session-flavor'

export interface SessionTypeConfig {
  icon: ComponentType<{ className?: string }>
  label: string
}

export function resolveSessionTypeConfig(sessionType: string, extensions?: ClientExtensionEntry[]): SessionTypeConfig {
  const freshAgentType = resolveFreshAgentType(sessionType)
  if (freshAgentType) {
    return {
      icon: freshAgentType.icon,
      label: freshAgentType.label,
    }
  }

  // 1. Check fresh-agent providers first (they have explicit configs)
  const freshAgentProviderConfig = getFreshAgentProviderConfig(sessionType)
  if (freshAgentProviderConfig) {
    return {
      icon: freshAgentProviderConfig.icon,
      label: freshAgentProviderConfig.label,
    }
  }

  // 2. Any non-shell mode is a coding CLI provider
  if (isNonShellMode(sessionType)) {
    return {
      icon: PROVIDER_ICONS[sessionType as keyof typeof PROVIDER_ICONS] ?? DefaultProviderIcon,
      label: getProviderLabel(sessionType, extensions),
    }
  }

  // 3. Fallback for unknown types
  return {
    icon: DefaultProviderIcon,
    label: sessionType,
  }
}

export type PairedSessionTypeTarget = {
  sourceSessionType: string
  targetSessionType: string
  runtimeProvider: CodingCliProviderName
  label: string
  targetKind: 'terminal' | 'fresh-agent'
  /**
   * The session flavor the metadata legs record for this reopen. Equals
   * the target EXCEPT when a hidden flavor (kilroy) rides the target CLI —
   * the runtime-kind change must not orphan it, so it keeps recording
   * itself. Public types record the target exactly as they always have.
   */
  metadataSessionType: string
}

function cliProviderLabel(provider: CodingCliProviderName): string {
  if (provider === 'opencode') return 'OpenCode CLI'
  return `${getProviderLabel(provider)} CLI`
}

/**
 * kata b8ke (round-2 R2-10): FLAVOR-AWARE paired-target derivation. The
 * fresh-agent side of a pair derives from the session's FLAVOR, never the
 * provider alone:
 * - A fresh-agent SOURCE (public types AND the hidden kilroy flavor) pairs
 *   with its runtime CLI — a kilroy pane offers "Reopen as Claude CLI"
 *   (kilroy rides the claude lane; the public CLI_TO_FRESH map has no
 *   kilroy entry, so the pre-b8ke derivation returned null and a kilroy
 *   pane had NO reopen action at all).
 * - A CLI source pairs with the session's RECORDED flavor first (the
 *   `flavor` option — a tab's sessionMetadataByKey sessionType): a
 *   claude-mode pane whose session is recorded kilroy maps BACK to kilroy,
 *   never to the provider-alone `freshclaude` (which would orphan the
 *   identity). Unknown/unmatching flavors fall back to the public map.
 */
export function getPairedSessionTypeTarget(
  sessionType: string | undefined,
  options: { flavor?: string | undefined } = {},
): PairedSessionTypeTarget | null {
  if (!sessionType) return null

  const freshSource = resolveFreshAgentType(sessionType)
  if (freshSource) {
    const runtimeProvider = freshSource.runtimeProvider
    if (!isNonShellMode(runtimeProvider)) return null
    return {
      sourceSessionType: sessionType,
      targetSessionType: runtimeProvider,
      runtimeProvider,
      targetKind: 'terminal',
      // A hidden flavor (kilroy) keeps recording itself across the
      // runtime-kind change; public fresh types record the CLI target.
      metadataSessionType: isPublicSessionType(sessionType) ? runtimeProvider : sessionType,
      label: `Reopen as ${cliProviderLabel(runtimeProvider)}`,
    }
  }

  if (!isNonShellMode(sessionType)) return null
  const flavor = options.flavor !== undefined ? resolveFreshAgentType(options.flavor) : undefined
  const targetSessionType = flavor && flavor.runtimeProvider === sessionType
    ? flavor.sessionType
    : getPairedPublicSessionType(sessionType)
  if (!targetSessionType) return null
  return {
    sourceSessionType: sessionType,
    targetSessionType,
    runtimeProvider: sessionType as CodingCliProviderName,
    targetKind: 'fresh-agent',
    metadataSessionType: targetSessionType,
    label: `Reopen as ${targetSessionType}`,
  }
}

/**
 * The flavor-first fresh-agent session type for a TERMINAL pane's session:
 * the tab's recorded sessionMetadataByKey sessionType when it names a
 * fresh-agent type riding the pane's CLI provider (kilroy when recorded),
 * the provider→public-type map only as fallback (claude→freshclaude — the
 * provider alone would lose the kilroy identity).
 */
export function freshSessionTypeForPaneFlavor(
  tab: { sessionMetadataByKey?: Record<string, { sessionType?: string }> } | undefined,
  content: { kind: string; mode?: string; sessionRef?: { provider: string; sessionId: string } },
): string | undefined {
  if (content.kind !== 'terminal') return undefined
  const sessionRef = content.sessionRef
  if (sessionRef) {
    const recorded = tab?.sessionMetadataByKey?.[`${sessionRef.provider}:${sessionRef.sessionId}`]?.sessionType
    if (recorded !== undefined) {
      const recordedFreshType = resolveFreshAgentType(recorded)
      if (recordedFreshType && recordedFreshType.runtimeProvider === sessionRef.provider) {
        return recordedFreshType.sessionType
      }
    }
  }
  const mode = content.mode !== undefined && isNonShellMode(content.mode) ? content.mode : undefined
  return mode !== undefined ? getPairedPublicSessionType(mode) : undefined
}

/**
 * The terminal pane content for a pane ADOPTING an already-committed
 * terminal owner (the atomic handoff's success path and the
 * opened-as-CLI-elsewhere attach action): the pane keeps its
 * createRequestId and sessionRef, points at the live terminal id, and
 * enters `running` so TerminalView's mount effect attaches instead of
 * creating a second process.
 */
export function buildTerminalAttachContent(opts: {
  createRequestId: string
  mode: string
  provider: string
  sessionId: string
  terminalId: string
  cwd?: string
}): TerminalPaneInput {
  return {
    kind: 'terminal',
    createRequestId: opts.createRequestId,
    mode: opts.mode as TerminalPaneInput['mode'],
    status: 'running',
    terminalId: opts.terminalId,
    sessionRef: {
      provider: opts.provider,
      sessionId: opts.sessionId,
    },
    ...(opts.cwd ? { initialCwd: opts.cwd } : {}),
  }
}

/**
 * Build the correct PaneContentInput for resuming a session based on its sessionType.
 * Fresh-agent sessions → kind: 'fresh-agent'
 * Terminal sessions (claude, codex) → kind: 'terminal'
 */
export function buildResumeContent(opts: {
  sessionType: string
  sessionId: string
  cwd?: string
  checkpointWorkspace?: FreshAgentCheckpointWorkspace
  freshAgentProviderSettings?: FreshAgentProviderSettings
  liveTerminal?: {
    terminalId: string
    serverInstanceId: string
  } & ManagedRuntimeProjectionFields
}): TerminalPaneInput | FreshAgentPaneInput {
  const freshAgentType = resolveFreshAgentType(opts.sessionType)
  if (freshAgentType) {
    const freshAgentProviderConfig = getFreshAgentProviderConfig(opts.sessionType)
    const ps = opts.freshAgentProviderSettings
    const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
      ? undefined
      : ps?.defaultPermissionMode ?? freshAgentProviderConfig?.defaultPermissionMode ?? freshAgentType.defaultPermissionMode
    return {
      kind: 'fresh-agent',
      sessionType: freshAgentType.sessionType,
      provider: freshAgentType.runtimeProvider,
      ...(freshAgentType.runtimeProvider === 'claude' ? { resumeSessionId: opts.sessionId } : {}),
      sessionRef: {
        provider: freshAgentType.runtimeProvider,
        sessionId: opts.sessionId,
      },
      initialCwd: opts.cwd,
      ...(opts.checkpointWorkspace ? { checkpointWorkspace: opts.checkpointWorkspace } : {}),
      modelSelection: ps?.modelSelection,
      model: freshAgentType.defaultModel,
      ...(permissionMode ? { permissionMode } : {}),
      effort: ps?.effort,
    }
  }

  const freshAgentProviderConfig = getFreshAgentProviderConfig(opts.sessionType)
  if (freshAgentProviderConfig) {
    const ps = opts.freshAgentProviderSettings
    return {
      kind: 'fresh-agent',
      sessionType: freshAgentProviderConfig.name as FreshAgentProviderName,
      provider: 'claude',
      resumeSessionId: opts.sessionId,
      sessionRef: {
        provider: 'claude',
        sessionId: opts.sessionId,
      },
      initialCwd: opts.cwd,
      ...(opts.checkpointWorkspace ? { checkpointWorkspace: opts.checkpointWorkspace } : {}),
      modelSelection: ps?.modelSelection,
      permissionMode: ps?.defaultPermissionMode ?? freshAgentProviderConfig.defaultPermissionMode,
      effort: ps?.effort,
    }
  }
  // Terminal pane (claude CLI, codex CLI, or fallback to 'claude')
  const provider: CodingCliProviderName = isNonShellMode(opts.sessionType)
    ? opts.sessionType as CodingCliProviderName
    : 'claude'
  return {
    kind: 'terminal',
    mode: provider,
    ...(opts.liveTerminal
      ? {
          terminalId: opts.liveTerminal.terminalId,
          serverInstanceId: opts.liveTerminal.serverInstanceId,
          status: opts.liveTerminal.runtimeStatus === 'exited' ? 'exited' as const : 'running' as const,
          ...managedTerminalProjection(opts.liveTerminal),
        }
      : {}),
    sessionRef: {
      provider,
      sessionId: opts.sessionId,
    },
    initialCwd: opts.cwd,
  }
}
