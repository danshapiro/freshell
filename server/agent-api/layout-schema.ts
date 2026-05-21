import { z } from 'zod'
import { SessionLocatorSchema } from '../../shared/ws-protocol.js'

const FreshAgentContentSchema = z.object({
  kind: z.literal('fresh-agent'),
  sessionType: z.string().min(1),
  provider: z.string().min(1),
  createRequestId: z.string().min(1),
  status: z.string().min(1),
  sessionId: z.string().optional(),
  resumeSessionId: z.string().optional(),
  sessionRef: z.object({ provider: z.string().min(1), sessionId: z.string().min(1) }).optional(),
  restoreError: z.object({ code: z.string().min(1), reason: z.string().min(1) }).optional(),
  initialCwd: z.string().optional(),
  model: z.string().optional(),
  modelSelection: z.object({ kind: z.string().min(1), modelId: z.string().min(1) }).optional().or(z.null()),
  permissionMode: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  effort: z.string().optional(),
  plugins: z.array(z.string()).optional(),
  settingsDismissed: z.boolean().optional(),
}).passthrough().refine(
  (v) => !(v.sessionRef && v.restoreError),
  { message: 'sessionRef and restoreError are mutually exclusive' },
)

const PaneNodeSchema: z.ZodType<any> = z.lazy(() => z.union([
  z.object({
    type: z.literal('leaf'),
    id: z.string(),
    content: z.union([
      z.object({
        kind: z.literal('terminal'),
        createRequestId: z.string(),
        status: z.string(),
        mode: z.string(),
        terminalId: z.string().optional(),
        shell: z.string().optional(),
        resumeSessionId: z.string().optional(),
        sessionRef: SessionLocatorSchema.optional(),
        restoreError: z.object({ code: z.string(), reason: z.string() }).optional(),
        initialCwd: z.string().optional(),
      }).passthrough(),
      z.object({
        kind: z.literal('browser'),
        browserInstanceId: z.string(),
        url: z.string(),
        devToolsOpen: z.boolean(),
      }).passthrough(),
      z.object({
        kind: z.literal('editor'),
        filePath: z.string().nullable(),
        language: z.string().nullable(),
        readOnly: z.boolean(),
        content: z.string(),
        viewMode: z.enum(['source', 'preview']),
      }).passthrough(),
      z.object({
        kind: z.literal('picker'),
      }).passthrough(),
      FreshAgentContentSchema,
      z.object({
        kind: z.literal('agent-chat'),
        provider: z.string(),
        createRequestId: z.string(),
        status: z.string(),
        sessionId: z.string().optional(),
        resumeSessionId: z.string().optional(),
        sessionRef: SessionLocatorSchema.optional(),
        restoreError: z.object({ code: z.string(), reason: z.string() }).optional(),
        initialCwd: z.string().optional(),
        modelSelection: z.object({ kind: z.string(), modelId: z.string() }).optional().or(z.null()),
        permissionMode: z.string().optional(),
        effort: z.string().optional(),
        plugins: z.array(z.string()).optional(),
        settingsDismissed: z.boolean().optional(),
      }).passthrough(),
      z.object({
        kind: z.literal('extension'),
        extensionName: z.string(),
        props: z.record(z.string(), z.any()),
      }).passthrough(),
      z.object({ kind: z.string() }).passthrough(),
    ]),
  }),
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
  tabs: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    fallbackSessionRef: SessionLocatorSchema.optional(),
  })),
  activeTabId: z.string().nullable().optional(),
  layouts: z.record(z.string(), PaneNodeSchema),
  activePane: z.record(z.string(), z.string()),
  paneTitles: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  paneTitleSetByUser: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
  timestamp: z.number(),
})
