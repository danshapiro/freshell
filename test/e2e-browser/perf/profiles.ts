export type AuditProfileId = 'desktop_local' | 'mobile_restricted'

export type AuditProfileDefinition = {
  id: AuditProfileId
  viewport?: { width: number; height: number }
  deviceName?: string
  network?: {
    downloadBps: number
    uploadBps: number
    latencyMs: number
  }
}

export const AUDIT_PROFILES: readonly AuditProfileDefinition[] = [
  {
    id: 'desktop_local',
    viewport: { width: 1440, height: 900 },
  },
  {
    id: 'mobile_restricted',
    deviceName: 'iPhone 14',
    network: {
      downloadBps: 1_600_000,
      uploadBps: 750_000,
      latencyMs: 150,
    },
  },
] as const
