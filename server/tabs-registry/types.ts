import { z } from 'zod'

export const RegistryTabStatusSchema = z.enum(['open', 'closed'])
export type RegistryTabStatus = z.infer<typeof RegistryTabStatusSchema>

export const RegistryPaneKindSchema = z.enum([
  'terminal',
  'browser',
  'editor',
  'picker',
  'claude-chat',
])
export type RegistryPaneKind = z.infer<typeof RegistryPaneKindSchema>

export const RegistryPaneSnapshotSchema = z.object({
  paneId: z.string().min(1),
  kind: RegistryPaneKindSchema,
  title: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
})
export type RegistryPaneSnapshot = z.infer<typeof RegistryPaneSnapshotSchema>

export const TabRegistryRecordBaseSchema = z.object({
  tabKey: z.string().min(1),
  tabId: z.string().min(1),
  serverInstanceId: z.string().min(1),
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
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
