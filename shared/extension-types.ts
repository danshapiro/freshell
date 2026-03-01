/**
 * Shared extension types — imported by both client and server.
 *
 * Kept minimal to avoid pulling server-only dependencies into the client bundle.
 */

// ──────────────────────────────────────────────────────────────
// Content schema field (mirrors the server-side Zod schema shape)
// ──────────────────────────────────────────────────────────────

export interface ContentSchemaField {
  type: 'string' | 'number' | 'boolean'
  label: string
  required?: boolean
  default?: string | number | boolean
}

// ──────────────────────────────────────────────────────────────
// Client extension entry — serialized from ExtensionManager
// ──────────────────────────────────────────────────────────────

export interface ClientExtensionEntry {
  name: string
  version: string
  label: string
  description: string
  category: 'client' | 'server' | 'cli'
  iconUrl?: string
  url?: string
  contentSchema?: Record<string, ContentSchemaField>
  picker?: { shortcut?: string; group?: string }
  serverRunning?: boolean
  serverPort?: number
}
