import { execFileSync as realExecFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  ensureClaudeSidecarDependencies,
  resolveNpmExecFileCommand,
} from '../../../scripts/ensure-claude-sidecar.js'

function temporarySidecar(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'freshell-claude-sidecar-'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'freshell-claude-sidecar',
    version: '0.1.0',
    dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.195' },
  }))
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'freshell-claude-sidecar',
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'freshell-claude-sidecar',
        version: '0.1.0',
        dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.195' },
      },
      'node_modules/@anthropic-ai/claude-agent-sdk': {
        version: '0.3.237',
      },
    },
  }))
  return root
}

describe('Claude sidecar dependency preparation', () => {
  it('installs from the sidecar lockfile and validates the SDK on a clean checkout', () => {
    const sidecarDir = temporarySidecar()
    const execFileSync = vi.fn((
      command: string,
      args: readonly string[],
      options: { cwd?: string },
    ) => {
      expect(command).toBe('npm')
      expect(args).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
      expect(options.cwd).toBe(sidecarDir)
      mkdirSync(path.join(sidecarDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })
      writeFileSync(
        path.join(sidecarDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
        JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.237' }),
      )
    })

    try {
      const receipt = ensureClaudeSidecarDependencies({
        sidecarDir,
        env: { PATH: '/bin' },
        platform: 'linux',
        execFileSync: execFileSync as unknown as typeof realExecFileSync,
      })

      expect(execFileSync).toHaveBeenCalledTimes(1)
      expect(receipt).toMatchObject({
        severity: 'info',
        event: 'claude_sidecar_dependencies_ready',
        packageVersion: '0.3.237',
      })
    } finally {
      rmSync(sidecarDir, { recursive: true, force: true })
    }
  })

  it('uses the native Node executable for npm-cli.js on Windows', () => {
    expect(resolveNpmExecFileCommand(
      ['ci', '--ignore-scripts'],
      { npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' },
      'win32',
      'C:\\Program Files\\nodejs\\node.exe',
    )).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'ci',
        '--ignore-scripts',
      ],
    })
  })

  it('fails when npm completes without producing the locked SDK package', () => {
    const sidecarDir = temporarySidecar()
    const execFileSync = vi.fn() as unknown as typeof realExecFileSync

    try {
      expect(() => ensureClaudeSidecarDependencies({
        sidecarDir,
        env: { PATH: '/bin' },
        platform: 'linux',
        execFileSync,
      })).toThrow('Claude sidecar dependency is missing')
    } finally {
      rmSync(sidecarDir, { recursive: true, force: true })
    }
  })
})
