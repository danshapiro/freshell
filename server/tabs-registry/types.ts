import { z } from 'zod'
import { migrateLegacyFreshAgentContent } from '../../shared/fresh-agent.js'

export const RegistryTabStatusSchema = z.enum(['open', 'closed'])
export type RegistryTabStatus = z.infer<typeof RegistryTabStatusSchema>

export const RegistryPaneKindSchema = z.enum([
  'terminal',
  'browser',
  'editor',
  'picker',
  'claude-chat',
  'fresh-agent',
  'extension',
])
export type RegistryPaneKind = z.infer<typeof RegistryPaneKindSchema>

const LEGACY_AGENT_CHAT_PANE_KIND = 'agent-chat'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stripUndefinedValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined))
}

function normalizeRegistryPaneSnapshotInput(value: unknown): unknown {
  if (
    !isRecord(value)
    || (value.kind !== LEGACY_AGENT_CHAT_PANE_KIND && value.kind !== 'fresh-agent')
  ) {
    return value
  }
  const payload = isRecord(value.payload) ? value.payload : {}
  const migrated = migrateLegacyFreshAgentContent({
    kind: value.kind,
    ...payload,
  }) as Record<string, unknown>
  if (migrated.kind !== 'fresh-agent') return value
  const { kind: _kind, ...migratedPayload } = migrated
  return {
    ...value,
    kind: 'fresh-agent',
    payload: stripUndefinedValues(migratedPayload),
  }
}

export const RegistryPaneSnapshotSchema = z.preprocess(normalizeRegistryPaneSnapshotInput, z.object({
  paneId: z.string().min(1),
  kind: RegistryPaneKindSchema,
  title: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
}))
export type RegistryPaneSnapshot = z.infer<typeof RegistryPaneSnapshotSchema>

export const TabRegistryRecordBaseSchema = z.object({
  tabKey: z.string().min(1),
  tabId: z.string().min(1),
  serverInstanceId: z.string().min(1),
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  clientInstanceId: z.string().min(1).optional(),
  tabName: z.string().min(1),
  status: RegistryTabStatusSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().optional(),
  paneCount: z.number().int().nonnegative(),
  titleSetByUser: z.boolean(),
  panes: z.array(RegistryPaneSnapshotSchema),
})

export const TabRegistryRecordSchema = TabRegistryRecordBaseSchema.superRefine((value, ctx) => {
  if (value.status === 'closed' && value.closedAt == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'closedAt is required when status is closed',
      path: ['closedAt'],
    })
  }
})

export type RegistryTabRecord = z.infer<typeof TabRegistryRecordSchema>

export function normalizeRegistryTabRecord(value: unknown): RegistryTabRecord | undefined {
  const parsed = TabRegistryRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
