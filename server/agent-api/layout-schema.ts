import { z } from 'zod'

const PaneNodeSchema: z.ZodType<any> = z.lazy(() => z.union([
  z.object({ type: z.literal('leaf'), id: z.string(), content: z.record(z.any()) }),
  z.object({
    type: z.literal('split'),
    id: z.string(),
    direction: z.enum(['horizontal', 'vertical']),
    sizes: z.tuple([z.number(), z.number()]),
    children: z.tuple([PaneNodeSchema, PaneNodeSchema]),
  }),
]))

export const UiLayoutSyncSchema = z.object({
  type: z.literal('ui.layout.sync'),
  tabs: z.array(z.object({ id: z.string(), title: z.string().optional() })),
  activeTabId: z.string().nullable().optional(),
  layouts: z.record(PaneNodeSchema),
  activePane: z.record(z.string()),
  paneTitles: z.record(z.record(z.string())).optional(),
  timestamp: z.number(),
})
