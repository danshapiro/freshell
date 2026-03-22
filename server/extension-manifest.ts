/**
 * Extension manifest schema — validates freshell.json files found in extension directories.
 *
 * Extensions declare their category (client, server, cli) and must provide
 * the matching category-specific config block. All schemas use strict mode
 * to reject unknown keys (catches typos in manifest files).
 */
import { z } from 'zod'
import type { CodingCliCommandSpec } from './terminal-registry.js'

// ──────────────────────────────────────────────────────────────
// Content schema field — describes a dynamic field for extension props
// ──────────────────────────────────────────────────────────────

const ContentSchemaFieldSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  label: z.string(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).refine(
  (field) => {
    if (field.default === undefined) return true
    return typeof field.default === field.type
  },
  { message: 'default value must match the declared field type' },
)

// ──────────────────────────────────────────────────────────────
// Category-specific config blocks
// ──────────────────────────────────────────────────────────────

const ClientConfigSchema = z.strictObject({
  entry: z.string().min(1),
})

const ServerConfigSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  readyPattern: z.string().optional(),
  readyTimeout: z.number().int().positive().optional().default(10000),
  healthCheck: z.string().optional(),
  singleton: z.boolean().optional().default(true),
})

const CliConfigSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  envVar: z.string().optional(),              // env var to override command (e.g., 'CLAUDE_CMD')
  launchArgs: z.array(z.string()).optional(), // template with {{sessionId}} placeholder for fresh exact launch
  resumeArgs: z.array(z.string()).optional(), // template with {{sessionId}} placeholder
  modelArgs: z.array(z.string()).optional(),  // template with {{model}} placeholder
  sandboxArgs: z.array(z.string()).optional(), // template with {{sandbox}} placeholder
  permissionModeArgs: z.array(z.string()).optional(), // template with {{permissionMode}} placeholder
  permissionModeEnvVar: z.string().optional(),
  permissionModeValues: z.record(z.string(), z.string()).optional(),
  supportsPermissionMode: z.boolean().optional(),
  supportsModel: z.boolean().optional(),      // shows model field in SettingsView
  supportsSandbox: z.boolean().optional(),    // shows sandbox selector in SettingsView
})

// ──────────────────────────────────────────────────────────────
// Picker config
// ──────────────────────────────────────────────────────────────

const PickerConfigSchema = z.strictObject({
  shortcut: z.string().optional(),
  group: z.string().optional(),
})

// ──────────────────────────────────────────────────────────────
// Top-level manifest schema
// ──────────────────────────────────────────────────────────────

export const ExtensionManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['client', 'server', 'cli']),

  icon: z.string().optional(),
  url: z.string().optional(),
  contentSchema: z.record(z.string(), ContentSchemaFieldSchema).optional(),
  picker: PickerConfigSchema.optional(),

  client: ClientConfigSchema.optional(),
  server: ServerConfigSchema.optional(),
  cli: CliConfigSchema.optional(),
}).refine(
  (m) => {
    const blocks = { client: m.client, server: m.server, cli: m.cli }
    const present = Object.entries(blocks).filter(([, v]) => v !== undefined).map(([k]) => k)
    return present.length === 1 && present[0] === m.category
  },
  { message: 'category must have exactly its own config block (no others)' },
)

// ──────────────────────────────────────────────────────────────
// Exported types
// ──────────────────────────────────────────────────────────────

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>
export type ExtensionCategory = ExtensionManifest['category']
export type ContentSchemaField = z.infer<typeof ContentSchemaFieldSchema>
export type CliConfig = z.infer<typeof CliConfigSchema>

function compileArgTemplate(
  template: string[] | undefined,
  placeholder: string,
): ((value: string) => string[]) | undefined {
  if (!template) return undefined
  return (value: string) => template.map((arg) => arg.replaceAll(placeholder, value))
}

export function buildCodingCliCommandSpec(input: {
  label: string
  cli: CliConfig
}): CodingCliCommandSpec {
  return {
    label: input.label,
    envVar: input.cli.envVar || '',
    defaultCommand: input.cli.command,
    args: input.cli.args,
    env: input.cli.env,
    launchArgs: compileArgTemplate(input.cli.launchArgs, '{{sessionId}}'),
    resumeArgs: compileArgTemplate(input.cli.resumeArgs, '{{sessionId}}'),
    modelArgs: compileArgTemplate(input.cli.modelArgs, '{{model}}'),
    sandboxArgs: compileArgTemplate(input.cli.sandboxArgs, '{{sandbox}}'),
    permissionModeArgs: compileArgTemplate(input.cli.permissionModeArgs, '{{permissionMode}}'),
    permissionModeEnvVar: input.cli.permissionModeEnvVar,
    permissionModeEnvValues: input.cli.permissionModeValues,
  }
}
