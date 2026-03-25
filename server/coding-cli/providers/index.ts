import type { CodingCliProvider } from '../provider.js'
import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import { kimiProvider } from './kimi.js'
import { opencodeProvider } from './opencode.js'

export const codingCliProviders: CodingCliProvider[] = [
  claudeProvider,
  codexProvider,
  opencodeProvider,
  kimiProvider,
]

export const codingCliProvidersByName = new Map(
  codingCliProviders.map((provider) => [provider.name, provider] as const),
)
