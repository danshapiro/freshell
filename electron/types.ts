import { z } from 'zod'

export const DesktopConfigSchema = z.object({
  serverMode: z.enum(['daemon', 'app-bound', 'remote']),
  remoteUrl: z.string().url().optional(),
  remoteToken: z.string().optional(),
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

export type DesktopConfig = z.infer<typeof DesktopConfigSchema>
