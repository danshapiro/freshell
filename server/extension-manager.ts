/**
 * ExtensionManager — discovers and validates extensions from the filesystem.
 *
 * Scans configured directories for subdirectories containing `freshell.json`,
 * validates each manifest against the Zod schema, and maintains an in-memory
 * registry. No process management — that's a separate concern (Task 3).
 */
import fs from 'fs'
import path from 'path'
import { ExtensionManifestSchema, type ExtensionManifest, type ContentSchemaField } from './extension-manifest.js'
import { logger } from './logger.js'

// ──────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────

export interface ExtensionRegistryEntry {
  manifest: ExtensionManifest
  path: string            // filesystem path to extension dir
  serverPort?: number     // allocated port (server panes, set later)
}

export interface ClientExtensionEntry {
  name: string
  version: string
  label: string
  description: string
  category: 'client' | 'server' | 'cli'
  iconUrl?: string        // URL to icon served by freshell: /api/extensions/{name}/icon
  url?: string            // URL template
  contentSchema?: Record<string, ContentSchemaField>
  picker?: { shortcut?: string; group?: string }
  serverRunning?: boolean
  serverPort?: number
}

// ──────────────────────────────────────────────────────────────
// ExtensionManager
// ──────────────────────────────────────────────────────────────

const MANIFEST_FILE = 'freshell.json'

export class ExtensionManager {
  private registry = new Map<string, ExtensionRegistryEntry>()

  /**
   * Scan directories for extensions. Clears existing registry first.
   *
   * For each directory in `dirs`:
   * - Skip if it doesn't exist
   * - Read directory entries (only directories and symlinks)
   * - For each subdirectory, check if `freshell.json` exists
   * - Read and validate the manifest; skip invalid ones with a warning
   * - Skip duplicate names with a warning (first one wins)
   */
  scan(dirs: string[]): void {
    this.registry.clear()

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        logger.debug({ dir }, 'Extension scan: directory does not exist, skipping')
        continue
      }

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (err) {
        logger.warn({ dir, err }, 'Extension scan: failed to read directory')
        continue
      }

      for (const entry of entries) {
        // Only consider directories and symlinks (symlinks may point to directories)
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

        const extDir = path.join(dir, entry.name)
        const manifestPath = path.join(extDir, MANIFEST_FILE)

        if (!fs.existsSync(manifestPath)) continue

        let raw: string
        try {
          raw = fs.readFileSync(manifestPath, 'utf-8')
        } catch (err) {
          logger.warn({ manifestPath, err }, 'Extension scan: failed to read manifest file')
          continue
        }

        let json: unknown
        try {
          json = JSON.parse(raw)
        } catch (err) {
          logger.warn({ manifestPath, err }, 'Extension scan: invalid JSON in manifest')
          continue
        }

        const result = ExtensionManifestSchema.safeParse(json)
        if (!result.success) {
          logger.warn(
            { manifestPath, errors: result.error.format() },
            'Extension scan: invalid manifest',
          )
          continue
        }

        const manifest = result.data

        if (this.registry.has(manifest.name)) {
          logger.warn(
            { name: manifest.name, path: extDir, existingPath: this.registry.get(manifest.name)!.path },
            'Extension scan: duplicate name, skipping',
          )
          continue
        }

        this.registry.set(manifest.name, { manifest, path: extDir })
      }
    }

    logger.info(
      { count: this.registry.size, names: [...this.registry.keys()] },
      'Extension scan complete',
    )
  }

  /** Get a single registry entry by name. */
  get(name: string): ExtensionRegistryEntry | undefined {
    return this.registry.get(name)
  }

  /** Get all registry entries. */
  getAll(): ExtensionRegistryEntry[] {
    return [...this.registry.values()]
  }

  /** Serialize registry for the client — no filesystem paths, no process handles. */
  toClientRegistry(): ClientExtensionEntry[] {
    return this.getAll().map((entry): ClientExtensionEntry => {
      const { manifest, serverPort } = entry

      const clientEntry: ClientExtensionEntry = {
        name: manifest.name,
        version: manifest.version,
        label: manifest.label,
        description: manifest.description,
        category: manifest.category,
        serverRunning: false,
        serverPort,
      }

      if (manifest.icon) {
        clientEntry.iconUrl = `/api/extensions/${encodeURIComponent(manifest.name)}/icon`
      }

      if (manifest.url !== undefined) {
        clientEntry.url = manifest.url
      }

      if (manifest.contentSchema !== undefined) {
        clientEntry.contentSchema = manifest.contentSchema
      }

      if (manifest.picker !== undefined) {
        clientEntry.picker = manifest.picker
      }

      return clientEntry
    })
  }
}
