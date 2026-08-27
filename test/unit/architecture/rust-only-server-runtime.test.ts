// @vitest-environment node
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { analyzeRuntimeBoundary } from '../../../scripts/retirement/runtime-boundary.js'

type RuntimeSurface = {
  id: string
  path: string
  role: string
  listener?: 'non-backend' | 'legacy-backend' | 'assertion-only'
}

const ALLOWED_LISTENER_PATHS = [
  'scripts/testing/coordinator-endpoint.ts',
  'test/e2e-browser/helpers/echo-ws-fixture.ts',
  'test/e2e-browser/helpers/harness-06/target-server.ts',
  'test/e2e-browser/helpers/harness-06/update-feed.ts',
  'test/e2e-browser/helpers/harness-06/fake-ai.ts',
  'test/e2e-browser/fixtures/providers/fake-codex-app-server.mjs',
  'test/e2e-browser/fixtures/providers/fake-opencode-server.mjs',
  'test/e2e-browser/fixtures/fake-opencode.cjs',
  'scripts/proofs/browser-background-visibility-probe.ts',
  'scripts/proofs/browser-freeze-lifecycle-probe.ts',
  'scripts/proofs/browser-process-suspend-probe.ts',
  'electron/port-check.ts',
] as const

const tempRoots: string[] = []

async function createSyntheticRoot(
  surfaces: RuntimeSurface[],
  files: Record<string, string> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freshell-runtime-boundary-'))
  tempRoots.push(root)
  await mkdir(path.join(root, 'scripts', 'retirement'), { recursive: true })
  await writeFile(
    path.join(root, 'scripts', 'retirement', 'runtime-surfaces.json'),
    `${JSON.stringify({ version: 1, surfaces }, null, 2)}\n`,
  )
  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    const filePath = path.join(root, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, contents)
    if (relativePath.endsWith('.sh') || relativePath.includes('unlisted') || relativePath.includes('new-owner')) {
      await chmod(filePath, 0o755)
    }
  }))
  return root
}

async function removeSyntheticRoots(): Promise<void> {
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true })
  }
}

afterEach(removeSyntheticRoots)

describe('runtime boundary analyzer', () => {
  it('rejects an invented Node HTTP listener as an unexpected backend', async () => {
    const root = await createSyntheticRoot(
      [{ id: 'known-script', path: 'scripts/known.ts', role: 'test-tool' }],
      {
        'scripts/known.ts': 'export const known = true\n',
        'scripts/invented-listener.ts': [
          "import http from 'node:http'",
          "http.createServer((_req, res) => res.end('nope')).listen(0)",
        ].join('\n'),
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toContain('scripts/invented-listener.ts')
  })

  it('rejects an unlisted Node listener in an e2e helper regardless of its filename', async () => {
    const root = await createSyntheticRoot(
      [],
      {
        'test/e2e-browser/helpers/rogue-listener.ts': [
          "import http from 'node:http'",
          "http.createServer((_req, res) => res.end('nope')).listen(0)",
        ].join('\n'),
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual([
      'test/e2e-browser/helpers/rogue-listener.ts',
    ])
  })

  it('rejects an unlisted Node listener in a test implementation', async () => {
    const root = await createSyntheticRoot(
      [],
      {
        'test/e2e-browser/helpers/rogue-listener.test.ts': [
          "import http from 'node:http'",
          "http.createServer((_req, res) => res.end('nope')).listen(0)",
        ].join('\n'),
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual([
      'test/e2e-browser/helpers/rogue-listener.test.ts',
    ])
  })

  it('rejects an unlisted Node listener in a supported extension example', async () => {
    const root = await createSyntheticRoot(
      [],
      {
        'examples/extensions/rogue/server.js': [
          "import http from 'node:http'",
          "http.createServer((_req, res) => res.end('nope')).listen(0)",
        ].join('\n'),
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual([
      'examples/extensions/rogue/server.js',
    ])
    expect(result.manifestDrift).toContain(
      'unlisted owner: examples/extensions/rogue/server.js',
    )
  })

  it('preserves explicitly recorded legacy test listeners without allowing adjacent helpers', async () => {
    const root = await createSyntheticRoot(
      [{
        id: 'legacy-helper',
        path: 'test/e2e-browser/helpers/legacy-listener.ts',
        role: 'legacy-test-backend',
        listener: 'legacy-backend',
      }],
      {
        'test/e2e-browser/helpers/legacy-listener.ts': "require('node:http').createServer().listen(0)\n",
        'test/e2e-browser/helpers/rogue-listener.ts': "require('node:http').createServer().listen(0)\n",
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual([
      'test/e2e-browser/helpers/rogue-listener.ts',
    ])
  })

  it('requires an exact assertion-only row for a test implementation listener', async () => {
    const root = await createSyntheticRoot(
      [{
        id: 'assertion-listener',
        path: 'test/unit/assertion-listener.test.ts',
        role: 'test-listener-assertion',
        listener: 'assertion-only',
      }],
      {
        'test/unit/assertion-listener.test.ts': "require('node:http').createServer().listen(0)\n",
        'test/unit/rogue-listener.test.ts': "require('node:http').createServer().listen(0)\n",
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual([
      'test/unit/rogue-listener.test.ts',
    ])
  })

  it('does not allow assertion-only listener rows outside test implementations', async () => {
    const root = await createSyntheticRoot(
      [{
        id: 'misclassified',
        path: 'scripts/misclassified.ts',
        role: 'test-listener-assertion',
        listener: 'assertion-only',
      }],
      {
        'scripts/misclassified.ts': "require('node:http').createServer().listen(0)\n",
      },
    )

    await expect(analyzeRuntimeBoundary(root)).rejects.toThrow(
      'Runtime surface manifest assertion-only row misclassified must classify a test implementation.',
    )
  })

  it('allows sanctioned Node roles and the exact non-backend listener rows', async () => {
    const roleFiles: Record<string, string> = {
      'config/vite/vite.config.ts': "export default { server: { host: '127.0.0.1' } }\n",
      'config/vitest/vitest.config.ts': "export default { test: { environment: 'node' } }\n",
      'electron/main.ts': "app.whenReady().then(() => {})\n",
      'tools/client.ts': "await fetch('http://127.0.0.1:3001/api/health')\n",
      'tools/mcp.ts': "new StdioServerTransport()\n",
      'crates/freshell-claude-sidecar/index.mjs': "await query({ prompt: 'safe fixture' })\n",
    }
    const surfaces: RuntimeSurface[] = Object.keys(roleFiles).map((surfacePath) => ({
      id: surfacePath,
      path: surfacePath,
      role: surfacePath.includes('vite')
        ? 'vite'
        : surfacePath.includes('vitest')
          ? 'vitest'
          : surfacePath.startsWith('electron/')
            ? 'electron-main'
            : surfacePath.includes('mcp')
              ? 'mcp-client'
              : surfacePath.includes('claude')
                ? 'claude-sidecar'
                : 'cli-client',
    }))

    for (const surfacePath of ALLOWED_LISTENER_PATHS) {
      roleFiles[surfacePath] = [
        "import http from 'node:http'",
        "http.createServer((_req, res) => res.end('fixture')).listen(0)",
      ].join('\n')
      surfaces.push({
        id: surfacePath,
        path: surfacePath,
        role: 'non-backend-listener',
        listener: 'non-backend',
      })
    }

    const root = await createSyntheticRoot(surfaces, roleFiles)
    const result = await analyzeRuntimeBoundary(root)

    expect(result.manifestDrift).toEqual([])
    expect(result.unexpectedNodeBackend).toEqual([])
  })

  it('reconciles unlisted owners, stale rows, and duplicate ownership', async () => {
    const root = await createSyntheticRoot(
      [
        { id: 'known', path: 'scripts/known.ts', role: 'test-tool' },
        { id: 'stale', path: 'scripts/missing.ts', role: 'test-tool' },
        { id: 'duplicate-a', path: 'scripts/known.ts', role: 'test-tool' },
        { id: 'duplicate-b', path: 'scripts/known.ts', role: 'test-tool' },
      ],
      {
        'scripts/known.ts': 'export const known = true\n',
        'scripts/unlisted.ts': 'export const unlisted = true\n',
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.manifestDrift).toEqual(expect.arrayContaining([
      'duplicate ownership: scripts/known.ts (duplicate-a, duplicate-b, known)',
      'stale manifest row: stale -> scripts/missing.ts',
      'unlisted owner: scripts/unlisted.ts',
    ]))
  })

  it('ignores historical plans but inventories root, scripts, and port owners', async () => {
    const root = await createSyntheticRoot(
      [],
      {
        'docs/plans/historical.ts': "require('node:http').createServer().listen(0)\n",
        'scripts/new-owner.ts': 'export const owner = true\n',
        'scripts/new-listener.ts': "require('node:http').createServer().listen(0)\n",
        'port/new-bootstrap.sh': '#!/usr/bin/env bash\necho owner\n',
        'root-launcher.sh': '#!/usr/bin/env bash\necho owner\n',
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.manifestDrift).toEqual(expect.arrayContaining([
      'unlisted owner: port/new-bootstrap.sh',
      'unlisted owner: root-launcher.sh',
      'unlisted owner: scripts/new-owner.ts',
    ]))
    expect(result.manifestDrift).not.toContain('unlisted owner: docs/plans/historical.ts')
    expect(result.unexpectedNodeBackend).not.toContain('docs/plans/historical.ts')
    expect(result.unexpectedNodeBackend).toContain('scripts/new-listener.ts')
  })

  it('inventories service, container, workflow, and fixture-server resources', async () => {
    const root = await createSyntheticRoot(
      [],
      {
        'installers/systemd/new.service': '[Service]\nExecStart=/opt/example\n',
        'docker/new/Dockerfile': 'FROM scratch\n',
        'docker/new/cloudbuild.yaml': 'steps: []\n',
        '.github/workflows/new.yml': 'name: new\n',
        'test/fixtures/new-server.ts': 'export const fixture = true\n',
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.manifestDrift).toEqual(expect.arrayContaining([
      'unlisted owner: .github/workflows/new.yml',
      'unlisted owner: docker/new/Dockerfile',
      'unlisted owner: docker/new/cloudbuild.yaml',
      'unlisted owner: installers/systemd/new.service',
      'unlisted owner: test/fixtures/new-server.ts',
    ]))
  })

  it('does not let a fake tools or electron listener bypass capability detection', async () => {
    const root = await createSyntheticRoot(
      [],
      {
        'tools/fake-server.ts': "import http from 'node:http'; http.createServer().listen(0)\n",
        'electron/fake-server.ts': "import http from 'node:http'; http.createServer().listen(0)\n",
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual([
      'electron/fake-server.ts',
      'tools/fake-server.ts',
    ])
  })

  it('does not allow a manifest row to expand the non-backend listener allowlist', async () => {
    const root = await createSyntheticRoot(
      [{ id: 'misclassified', path: 'scripts/misclassified.ts', role: 'non-backend-listener', listener: 'non-backend' }],
      {
        'scripts/misclassified.ts': "require('node:http').createServer().listen(0)\n",
      },
    )

    const result = await analyzeRuntimeBoundary(root)

    expect(result.unexpectedNodeBackend).toEqual(['scripts/misclassified.ts'])
  })
})

describe('runtime boundary inventory for the current checkout', () => {
  it('keeps current legacy debt explicit while proving the manifest is reconciled', async () => {
    const result = await analyzeRuntimeBoundary(process.cwd())

    expect(result.manifestDrift).toEqual([])
    expect(result.unexpectedNodeBackend).toEqual([])
    expect(result.legacyDebt).toEqual(expect.arrayContaining([
      'server/index.ts',
      'package.json:scripts.start',
      'config/electron-builder.yml:dist/server',
      'test/e2e-browser/playwright.config.ts:legacy-chromium',
      'run-rust-server.sh:legacy-comment',
      'port/laptop-bootstrap/2-bootstrap-wsl.sh:inherited-build-path',
      'examples/extensions/live-counter/server.js',
      'examples/extensions/status-dashboard/server.js',
    ]))
  })
})
