// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  selectPackageManager,
  buildTypecheckInvocation,
  missingManagerRemediation,
  formatTypecheckSelection,
} from '../../../scripts/hooks/prepush-manager.js'

const roots: string[] = []

function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepush-manager-'))
  roots.push(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content)
  }
  return dir
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe('selectPackageManager (plan 7.4: selection from the pushing worktree only)', () => {
  it('treats the packageManager field as authoritative when both locks exist', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@10.34.5' }),
      'pnpm-lock.yaml': '',
      'package-lock.json': '',
    })
    expect(selectPackageManager(root)).toEqual({
      manager: 'pnpm',
      source: 'packageManager-field',
    })
  })

  it('lets a packageManager npm field win over a pnpm lock', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'npm@10.9.3' }),
      'pnpm-lock.yaml': '',
    })
    expect(selectPackageManager(root)).toEqual({
      manager: 'npm',
      source: 'packageManager-field',
    })
  })

  it('falls back to the pnpm lock when no packageManager field exists', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'x' }),
      'pnpm-lock.yaml': '',
    })
    expect(selectPackageManager(root)).toEqual({
      manager: 'pnpm',
      source: 'lock-fallback',
    })
  })

  it('selects npm for a legacy npm lock without pnpm metadata', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'x' }),
      'package-lock.json': '',
    })
    expect(selectPackageManager(root)).toEqual({
      manager: 'npm',
      source: 'lock-fallback',
    })
  })

  it('selects npm when both locks exist transiently without a packageManager field', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'x' }),
      'pnpm-lock.yaml': '',
      'package-lock.json': '',
    })
    expect(selectPackageManager(root)).toEqual({
      manager: 'npm',
      source: 'lock-fallback',
    })
  })

  it('selects npm for a manifest with no field and no locks', () => {
    const root = makeRoot({ 'package.json': JSON.stringify({ name: 'x' }) })
    expect(selectPackageManager(root)).toEqual({
      manager: 'npm',
      source: 'lock-fallback',
    })
  })

  it('defaults to npm when the manifest is missing entirely', () => {
    const root = makeRoot({})
    expect(selectPackageManager(root)).toEqual({
      manager: 'npm',
      source: 'lock-fallback',
    })
  })

  it('falls back to locks when the manifest is unparseable', () => {
    const root = makeRoot({
      'package.json': '{ not json at all',
      'pnpm-lock.yaml': '',
    })
    expect(selectPackageManager(root)).toEqual({
      manager: 'pnpm',
      source: 'lock-fallback',
    })
  })
})

describe('buildTypecheckInvocation', () => {
  it('renders the pnpm invocation without any -- separator', () => {
    const invocation = buildTypecheckInvocation('pnpm')
    expect(invocation).toEqual({ command: 'pnpm', args: ['run', '--silent', 'typecheck'] })
    expect(invocation.args).not.toContain('--')
  })

  it('renders the npm invocation', () => {
    const invocation = buildTypecheckInvocation('npm')
    expect(invocation).toEqual({ command: 'npm', args: ['run', '--silent', 'typecheck'] })
  })
})

describe('missingManagerRemediation', () => {
  it('points pnpm at the pinned install command', () => {
    expect(missingManagerRemediation('pnpm')).toContain('pnpm@10.34.5')
  })

  it('points npm at Node availability', () => {
    expect(missingManagerRemediation('npm')).toMatch(/Node\.js|npm/)
  })
})

describe('formatTypecheckSelection (the stdout protocol the bash hook parses)', () => {
  it('emits key=value lines for a pnpm worktree', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@10.34.5' }),
    })
    const out = formatTypecheckSelection(root)
    expect(out).toContain('manager=pnpm')
    expect(out).toContain('command=pnpm')
    expect(out).toContain('args=run --silent typecheck')
    expect(out).toContain('remediation=npm install --global pnpm@10.34.5')
    for (const line of out.split('\n')) {
      expect(line).toMatch(/^(manager|source|command|args|remediation)=/)
    }
  })

  it('emits key=value lines for an npm worktree', () => {
    const root = makeRoot({ 'package-lock.json': '' })
    const out = formatTypecheckSelection(root)
    expect(out).toContain('manager=npm')
    expect(out).toContain('command=npm')
    expect(out).toContain('args=run --silent typecheck')
  })
})

describe('pre-push hook execution contract (git runs hooks without a shell)', () => {
  const hookPath = path.resolve(__dirname, '../../../scripts/hooks/pre-push')

  it('declares a bash interpreter: git execs the hook directly, so without a shebang the OS runs it under sh/dash, whose parser rejects the hook\'s bashisms (herestring at the manager block)', () => {
    const firstLine = readFileSync(hookPath, 'utf-8').split('\n')[0]
    expect(firstLine).toBe('#!/usr/bin/env bash')
  })

  it('stays parseable by bash', () => {
    const res = spawnSync('bash', ['-n', hookPath], { timeout: 30_000, killSignal: 'SIGKILL', encoding: 'utf-8' })
    expect(res.status, res.stderr).toBe(0)
  })
})
