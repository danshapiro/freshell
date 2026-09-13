// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  npmCommand,
  resolveElectronDevPrerequisitePaths,
  runElectronDevPrerequisites,
} from '../../../scripts/electron-dev-prerequisites.js'

interface SpawnOptions {
  cwd: string
  shell: boolean
  stdio: 'inherit'
  windowsHide: boolean
}

describe('Electron development prerequisite process spawning', () => {
  it('uses npm.cmd through a Windows shell and verifies all dev outputs', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'freshell-electron-prerequisites-'))
    const resources = resolveElectronDevPrerequisitePaths(projectRoot, 'win32')
    const spawn = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      expect(command).toBe('npm.cmd')
      expect(options).toMatchObject({ cwd: projectRoot, shell: true, stdio: 'inherit', windowsHide: true })

      switch (args.join(' ')) {
        case 'run build:client':
          mkdirSync(path.dirname(resources.clientIndex), { recursive: true })
          writeFileSync(resources.clientIndex, '<!doctype html>')
          break
        case 'run build:tools':
          mkdirSync(path.dirname(resources.mcpEntry), { recursive: true })
          writeFileSync(resources.mcpEntry, 'export {}')
          break
        case 'run build:rust:debug':
          mkdirSync(path.dirname(resources.serverBinary), { recursive: true })
          writeFileSync(resources.serverBinary, 'rust debug binary')
          break
      }

      return { status: 0, signal: null }
    })

    try {
      expect(npmCommand('win32')).toBe('npm.cmd')
      const resolved = runElectronDevPrerequisites({
        projectRoot,
        platform: 'win32',
        spawn,
      })

      expect(resolved).toEqual(resources)
      expect(spawn).toHaveBeenCalledTimes(4)
      expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
        ['run', 'prebuild'],
        ['run', 'build:client'],
        ['run', 'build:tools'],
        ['run', 'build:rust:debug'],
      ])
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('reports an injected npm spawn failure without continuing to later phases', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'freshell-electron-prerequisites-error-'))
    const spawn = vi.fn(() => ({
      error: new Error('npm is unavailable'),
      status: null,
      signal: null,
    }))

    try {
      expect(() => runElectronDevPrerequisites({
        projectRoot,
        platform: 'win32',
        spawn,
      })).toThrow(
        'npm.cmd run prebuild failed to start: npm is unavailable',
      )
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('uses npm without a shell on POSIX platforms', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'freshell-electron-prerequisites-posix-'))
    const resources = resolveElectronDevPrerequisitePaths(projectRoot, 'linux')
    const spawn = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      expect(command).toBe('npm')
      expect(options).toMatchObject({ cwd: projectRoot, shell: false, stdio: 'inherit', windowsHide: true })

      switch (args.join(' ')) {
        case 'run build:client':
          mkdirSync(path.dirname(resources.clientIndex), { recursive: true })
          writeFileSync(resources.clientIndex, '<!doctype html>')
          break
        case 'run build:tools':
          mkdirSync(path.dirname(resources.mcpEntry), { recursive: true })
          writeFileSync(resources.mcpEntry, 'export {}')
          break
        case 'run build:rust:debug':
          mkdirSync(path.dirname(resources.serverBinary), { recursive: true })
          writeFileSync(resources.serverBinary, 'rust debug binary')
          break
      }

      return { status: 0, signal: null }
    })

    try {
      expect(npmCommand('linux')).toBe('npm')
      runElectronDevPrerequisites({
        projectRoot,
        platform: 'linux',
        spawn,
      })

      expect(spawn).toHaveBeenCalledTimes(4)
      expect(spawn.mock.calls.every(([, , options]) => options.shell === false)).toBe(true)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
