import { describe, it, expect } from 'vitest'
import {
  ExtensionManifestSchema,
  type ExtensionManifest,
  type ExtensionCategory,
  type ContentSchemaField,
} from '../../../server/extension-manifest.js'

describe('ExtensionManifestSchema', () => {
  const validServerManifest = {
    name: 'test-server-ext',
    version: '0.1.0',
    label: 'Test Server Extension',
    description: 'A test server extension',
    category: 'server' as const,
    server: {
      command: 'node',
      args: ['dist/index.js'],
      readyPattern: 'Listening on',
      readyTimeout: 10000,
      singleton: true,
    },
  }

  const validClientManifest = {
    name: 'test-client-ext',
    version: '1.0.0',
    label: 'Test Client Extension',
    description: 'A test client extension',
    category: 'client' as const,
    client: {
      entry: './dist/index.html',
    },
  }

  const validCliManifest = {
    name: 'test-cli-ext',
    version: '0.2.0',
    label: 'Test CLI Extension',
    description: 'A test CLI extension',
    category: 'cli' as const,
    cli: {
      command: 'lazygit',
    },
  }

  // ── Required fields ──

  it('accepts a valid server manifest', () => {
    const result = ExtensionManifestSchema.safeParse(validServerManifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('test-server-ext')
      expect(result.data.category).toBe('server')
      expect(result.data.server?.command).toBe('node')
    }
  })

  it('accepts a valid client manifest', () => {
    const result = ExtensionManifestSchema.safeParse(validClientManifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBe('client')
      expect(result.data.client?.entry).toBe('./dist/index.html')
    }
  })

  it('accepts a valid CLI manifest', () => {
    const result = ExtensionManifestSchema.safeParse(validCliManifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBe('cli')
      expect(result.data.cli?.command).toBe('lazygit')
    }
  })

  it('rejects missing required fields', () => {
    const result = ExtensionManifestSchema.safeParse({ name: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects empty name', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      name: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty version', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      version: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty label', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      label: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty description', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      description: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid category', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      category: 'invalid',
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown top-level keys (catches typos)', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      descripton: 'typo', // typo in 'description'
    })
    expect(result.success).toBe(false)
  })

  // ── Category-config coupling ──

  it('rejects server category without server config block', () => {
    const { server: _, ...noServer } = validServerManifest
    const result = ExtensionManifestSchema.safeParse(noServer)
    expect(result.success).toBe(false)
  })

  it('rejects client category without client config block', () => {
    const { client: _, ...noClient } = validClientManifest
    const result = ExtensionManifestSchema.safeParse(noClient)
    expect(result.success).toBe(false)
  })

  it('rejects cli category without cli config block', () => {
    const { cli: _, ...noCli } = validCliManifest
    const result = ExtensionManifestSchema.safeParse(noCli)
    expect(result.success).toBe(false)
  })

  it('rejects non-matching config blocks alongside category', () => {
    // server category with extra client block
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      client: { entry: './index.html' },
    })
    expect(result.success).toBe(false)
  })

  // ── Optional fields ──

  it('accepts optional fields: icon, url, contentSchema, picker', () => {
    const manifest = {
      ...validServerManifest,
      icon: './icon.svg',
      url: '/run/{{runId}}',
      contentSchema: {
        runId: { type: 'string', label: 'Run ID', required: true },
      },
      picker: { shortcut: 'K', group: 'tools' },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.icon).toBe('./icon.svg')
      expect(result.data.url).toBe('/run/{{runId}}')
      expect(result.data.contentSchema?.runId?.label).toBe('Run ID')
      expect(result.data.contentSchema?.runId?.type).toBe('string')
      expect(result.data.contentSchema?.runId?.required).toBe(true)
      expect(result.data.picker?.shortcut).toBe('K')
      expect(result.data.picker?.group).toBe('tools')
    }
  })

  it('accepts picker with only shortcut', () => {
    const manifest = {
      ...validClientManifest,
      picker: { shortcut: 'C' },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.picker?.shortcut).toBe('C')
      expect(result.data.picker?.group).toBeUndefined()
    }
  })

  it('accepts picker with only group', () => {
    const manifest = {
      ...validClientManifest,
      picker: { group: 'viewers' },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.picker?.group).toBe('viewers')
    }
  })

  it('rejects picker with unknown keys', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      picker: { shortcut: 'C', gropu: 'tools' }, // typo in 'group'
    })
    expect(result.success).toBe(false)
  })

  // ── Server config ──

  it('accepts server config with env and template variables', () => {
    const manifest = {
      ...validServerManifest,
      server: {
        ...validServerManifest.server,
        env: { PORT: '{{port}}', RUNS_DIR: '{{runsDir}}' },
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.server?.env?.PORT).toBe('{{port}}')
      expect(result.data.server?.env?.RUNS_DIR).toBe('{{runsDir}}')
    }
  })

  it('accepts server config with healthCheck', () => {
    const manifest = {
      ...validServerManifest,
      server: {
        ...validServerManifest.server,
        healthCheck: '/api/health',
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.server?.healthCheck).toBe('/api/health')
    }
  })

  it('defaults server.singleton to true', () => {
    const manifest = {
      ...validServerManifest,
      server: {
        command: 'node',
        args: ['dist/index.js'],
        readyPattern: 'Listening',
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.server?.singleton).toBe(true)
    }
  })

  it('defaults server.readyTimeout to 10000', () => {
    const manifest = {
      ...validServerManifest,
      server: {
        command: 'node',
        args: ['dist/index.js'],
        readyPattern: 'Listening',
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.server?.readyTimeout).toBe(10000)
    }
  })

  it('allows server.singleton to be explicitly false', () => {
    const manifest = {
      ...validServerManifest,
      server: {
        ...validServerManifest.server,
        singleton: false,
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.server?.singleton).toBe(false)
    }
  })

  it('defaults server.args to empty array when omitted', () => {
    const manifest = {
      ...validServerManifest,
      server: {
        command: 'node',
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.server?.args).toEqual([])
    }
  })

  it('rejects server readyTimeout with negative value', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      server: { ...validServerManifest.server, readyTimeout: -1 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects server readyTimeout with zero', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      server: { ...validServerManifest.server, readyTimeout: 0 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects server config with empty command', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      server: { ...validServerManifest.server, command: '' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects server config with unknown keys (catches typos)', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validServerManifest,
      server: {
        ...validServerManifest.server,
        commmand: 'node', // typo: triple 'm'
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects client config with empty entry', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      client: { entry: '' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects client config with unknown keys', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      client: { entry: './index.html', entrypoint: './other.html' },
    })
    expect(result.success).toBe(false)
  })

  // ── CLI config ──

  it('rejects CLI config with empty command', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validCliManifest,
      cli: { command: '' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects CLI config with unknown keys', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validCliManifest,
      cli: { command: 'htop', flags: ['--color'] },
    })
    expect(result.success).toBe(false)
  })

  it('accepts CLI config with args and env', () => {
    const manifest = {
      ...validCliManifest,
      cli: {
        command: 'htop',
        args: ['-d', '10'],
        env: { TERM: 'xterm-256color' },
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cli?.command).toBe('htop')
      expect(result.data.cli?.args).toEqual(['-d', '10'])
      expect(result.data.cli?.env?.TERM).toBe('xterm-256color')
    }
  })

  it('defaults CLI args to empty array when omitted', () => {
    const result = ExtensionManifestSchema.safeParse(validCliManifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cli?.args).toEqual([])
    }
  })

  // ── Content schema field types ──

  it('accepts contentSchema with string, number, and boolean field types', () => {
    const manifest = {
      ...validClientManifest,
      contentSchema: {
        name: { type: 'string', label: 'Name', required: true },
        count: { type: 'number', label: 'Count', default: 5 },
        verbose: { type: 'boolean', label: 'Verbose', default: false },
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.contentSchema?.name?.type).toBe('string')
      expect(result.data.contentSchema?.count?.type).toBe('number')
      expect(result.data.contentSchema?.count?.default).toBe(5)
      expect(result.data.contentSchema?.verbose?.type).toBe('boolean')
      expect(result.data.contentSchema?.verbose?.default).toBe(false)
    }
  })

  it('rejects contentSchema field with default that mismatches declared type', () => {
    // type: 'number' with string default
    const result1 = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      contentSchema: {
        count: { type: 'number', label: 'Count', default: 'not-a-number' },
      },
    })
    expect(result1.success).toBe(false)

    // type: 'boolean' with number default
    const result2 = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      contentSchema: {
        flag: { type: 'boolean', label: 'Flag', default: 42 },
      },
    })
    expect(result2.success).toBe(false)

    // type: 'string' with boolean default
    const result3 = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      contentSchema: {
        name: { type: 'string', label: 'Name', default: true },
      },
    })
    expect(result3.success).toBe(false)
  })

  it('rejects contentSchema field with unknown keys', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...validClientManifest,
      contentSchema: {
        name: { type: 'string', label: 'Name', placeholder: 'Enter name' },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects contentSchema with invalid field type', () => {
    const manifest = {
      ...validClientManifest,
      contentSchema: {
        bad: { type: 'object', label: 'Bad' },
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(false)
  })

  it('accepts contentSchema field with string default', () => {
    const manifest = {
      ...validClientManifest,
      contentSchema: {
        dir: { type: 'string', label: 'Directory', default: '/tmp' },
      },
    }
    const result = ExtensionManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.contentSchema?.dir?.default).toBe('/tmp')
    }
  })

  // ── Type inference smoke checks ──

  it('inferred ExtensionManifest type has expected shape', () => {
    const parsed = ExtensionManifestSchema.parse(validServerManifest)
    // These are compile-time type checks that also run at runtime
    const _manifest: ExtensionManifest = parsed
    const _category: ExtensionCategory = parsed.category
    expect(_manifest.name).toBe('test-server-ext')
    expect(['client', 'server', 'cli']).toContain(_category)
  })

  it('inferred ContentSchemaField type has expected shape', () => {
    const manifest = {
      ...validClientManifest,
      contentSchema: {
        field: { type: 'string' as const, label: 'Field' },
      },
    }
    const parsed = ExtensionManifestSchema.parse(manifest)
    const field: ContentSchemaField = parsed.contentSchema!.field
    expect(field.type).toBe('string')
    expect(field.label).toBe('Field')
  })
})
