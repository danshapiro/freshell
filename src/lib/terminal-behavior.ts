import type { ClientExtensionEntry } from '@shared/extension-types'

export type ScrollInputPolicy = 'native' | 'fallbackToCursorKeysWhenAltScreenMouseCapture'

export type ProviderTerminalBehavior = {
  preferredRenderer?: 'canvas'
  scrollInputPolicy: ScrollInputPolicy
}

export type ScrollTranslationRuntime = {
  altBufferActive: boolean
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
}

const EXTENSION_BEHAVIOR_PROVIDERS = new Set(['opencode'])

export function providerUsesExtensionTerminalBehavior(provider: string | undefined): boolean {
  return typeof provider === 'string' && EXTENSION_BEHAVIOR_PROVIDERS.has(provider)
}

export function getProviderTerminalBehavior(
  provider: string | undefined,
  extensions: ClientExtensionEntry[],
): ProviderTerminalBehavior {
  const ext = extensions.find((entry) => entry.category === 'cli' && entry.name === provider)

  return {
    preferredRenderer: ext?.cli?.terminalBehavior?.preferredRenderer,
    scrollInputPolicy: ext?.cli?.terminalBehavior?.scrollInputPolicy ?? 'native',
  }
}

export function prefersCanvasRenderer(
  provider: string | undefined,
  extensions: ClientExtensionEntry[],
): boolean {
  return getProviderTerminalBehavior(provider, extensions).preferredRenderer === 'canvas'
}

export function shouldTranslateScrollToCursorKeys(
  runtime: ScrollTranslationRuntime & { scrollInputPolicy: ScrollInputPolicy },
): boolean {
  return runtime.scrollInputPolicy === 'fallbackToCursorKeysWhenAltScreenMouseCapture'
    && runtime.altBufferActive
    && runtime.mouseTrackingMode !== 'none'
}

export function scrollLinesToCursorKeys(
  lines: number,
  applicationCursorKeysMode: boolean,
): string | null {
  if (lines === 0) return null

  const up = applicationCursorKeysMode ? '\u001bOA' : '\u001b[A'
  const down = applicationCursorKeysMode ? '\u001bOB' : '\u001b[B'
  const sequence = lines < 0 ? up : down

  return Array.from({ length: Math.abs(lines) }, () => sequence).join('')
}
