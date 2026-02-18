import { z } from 'zod'

const CodingCliProviderConfigSchema = z
  .object({
    model: z.string().optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
    maxTurns: z.coerce.number().optional(),
    cwd: z.string().optional(),
  })
  .strict()

export const SettingsPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    uiScale: z.coerce.number().optional(),
    terminal: z
      .object({
        fontSize: z.coerce.number().optional(),
        lineHeight: z.coerce.number().optional(),
        cursorBlink: z.coerce.boolean().optional(),
        scrollback: z.coerce.number().optional(),
        theme: z
          .enum([
            'auto',
            'dracula',
            'one-dark',
            'solarized-dark',
            'github-dark',
            'one-light',
            'solarized-light',
            'github-light',
          ])
          .optional(),
        warnExternalLinks: z.coerce.boolean().optional(),
        osc52Clipboard: z.enum(['ask', 'always', 'never']).optional(),
        renderer: z.enum(['auto', 'webgl', 'canvas']).optional(),
      })
      .strict()
      .optional(),
    defaultCwd: z.string().nullable().optional(),
    allowedFilePaths: z.array(z.string()).optional(),
    logging: z
      .object({
        debug: z.coerce.boolean().optional(),
      })
      .strict()
      .optional(),
    safety: z
      .object({
        autoKillIdleMinutes: z.coerce.number().optional(),
        warnBeforeKillMinutes: z.coerce.number().optional(),
      })
      .strict()
      .optional(),
    panes: z
      .object({
        defaultNewPane: z.enum(['ask', 'shell', 'browser', 'editor']).optional(),
        snapThreshold: z.coerce.number().optional(),
        iconsOnTabs: z.coerce.boolean().optional(),
        tabAttentionStyle: z.enum(['highlight', 'pulse', 'darken', 'none']).optional(),
        attentionDismiss: z.enum(['click', 'type']).optional(),
      })
      .strict()
      .optional(),
    sidebar: z
      .object({
        sortMode: z.enum(['recency', 'recency-pinned', 'activity', 'project']).optional(),
        showProjectBadges: z.coerce.boolean().optional(),
        showSubagents: z.coerce.boolean().optional(),
        showNoninteractiveSessions: z.coerce.boolean().optional(),
        width: z.coerce.number().optional(),
        collapsed: z.coerce.boolean().optional(),
      })
      .strict()
      .optional(),
    notifications: z
      .object({
        soundEnabled: z.coerce.boolean().optional(),
      })
      .strict()
      .optional(),
    codingCli: z
      .object({
        enabledProviders: z
          .array(z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']))
          .optional(),
        providers: z
          .record(
            z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']),
            CodingCliProviderConfigSchema,
          )
          .optional(),
      })
      .strict()
      .optional(),
    freshclaude: z
      .object({
        defaultModel: z.string().optional(),
        defaultPermissionMode: z.string().optional(),
        defaultEffort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({
        host: z.enum(['127.0.0.1', '0.0.0.0']).optional(),
        configured: z.coerce.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
