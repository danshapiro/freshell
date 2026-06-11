import { z } from 'zod'

export const KnownServerSchema = z.object({
  url: z.string().url(),
  label: z.string().optional(),
  lastConnectedAt: z.string().datetime().optional(),
})

export const DesktopConfigSchema = z.object({
  serverMode: z.enum(['daemon', 'app-bound', 'remote']),
  port: z.number().default(3001),
  remoteUrl: z.string().url().optional(),
  remoteToken: z.string().optional(),
  knownServers: z.array(KnownServerSchema).default([]),
  alwaysAskOnLaunch: z.boolean().default(false),
  globalHotkey: z.string().default('CommandOrControl+`'),
  startOnLogin: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  setupCompleted: z.boolean().default(false),
  windowState: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    maximized: z.boolean(),
  }).optional(),
})

export type KnownServer = z.infer<typeof KnownServerSchema>
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>

export type ServerOwnership = 'owned' | 'detected-local' | 'remote'

export interface LaunchServerCandidate {
  id: string
  url: string
  origin: 'configured' | 'known' | 'port-scan' | 'manual'
  ownership: ServerOwnership
  label?: string
  version?: string
  instanceId?: string
  startedAt?: string
  ready?: boolean
  requiresAuth?: boolean
  token?: string
}

// Schema (not just a TS type) because LaunchChoice crosses the IPC boundary and
// must be runtime-validated before it can drive a launch.
export const LaunchChoiceSchema = z.object({
  kind: z.enum(['connect', 'remote', 'start-local']),
  url: z.string().optional(),
  token: z.string().optional(),
  port: z.number().optional(),
  requiresAuth: z.boolean().optional(),
  alwaysAskOnLaunch: z.boolean(),
  remember: z.boolean(),
})

export type LaunchChoice = z.infer<typeof LaunchChoiceSchema>

/**
 * An explicit launch selection that must be honored for the current launch,
 * independent of saved config, `alwaysAskOnLaunch`, or re-discovered servers.
 */
export type ForcedLaunch =
  | { kind: 'connect'; url: string; token?: string }
  | { kind: 'start-local'; port: number }

export type LaunchChoiceResult =
  | { ok: true }
  | { ok: false; error: string }
