import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fakeDocker = vi.hoisted(() => ({
  images: new Map<string, { id: string; labels: Record<string, string> }>(),
  buildTags: [] as string[],
  launches: [] as string[],
  removals: [] as string[],
}))

vi.mock('node:child_process', () => {
  const execFileSync = (program: string, args: string[]) => {
    if (program === 'git') {
      const operation = args.join(' ')
      if (['rev-parse HEAD', 'rev-parse --verify HEAD'].includes(operation)) return `${'a'.repeat(40)}\n`
      if (['status --porcelain=v1 -z --untracked-files=all',
        'diff --no-ext-diff --no-textconv --binary HEAD --'].includes(operation)) return Buffer.alloc(0)
      throw new Error(`unexpected Git command: ${operation}`)
    }
    if (program !== 'docker') throw new Error(`unexpected executable: ${program}`)

    if (args[0] === 'build') {
      const tag = args[args.indexOf('-t') + 1]
      const labels = Object.fromEntries(args.flatMap((argument, index) => argument === '--label'
        ? [String(args[index + 1]).split('=')]
        : []))
      const id = `sha256:${createHash('sha256').update(tag).digest('hex')}`
      fakeDocker.images.set(tag, { id, labels })
      fakeDocker.buildTags.push(tag)
      return ''
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const ref = args[2]
      const image = fakeDocker.images.get(ref!) ?? [...fakeDocker.images.values()].find(candidate => candidate.id === ref)
      if (!image) throw new Error(`No such image: ${ref}`)
      if (args.includes('--format')) return `${image.id}\n`
      const tag = [...fakeDocker.images].find(([, candidate]) => candidate === image)?.[0]
      return JSON.stringify([{ Id: image.id, RepoTags: tag ? [tag] : [], Config: { Labels: image.labels } }])
    }
    if (args[0] === 'image' && args[1] === 'ls') return `${[...fakeDocker.images.keys()].join('\n')}\n`
    if (args[0] === 'image' && args[1] === 'rm') {
      const tag = args[2]!
      if (!fakeDocker.images.delete(tag)) throw new Error(`No such image: ${tag}`)
      fakeDocker.removals.push(tag)
      return ''
    }
    if (['ps -aq --no-trunc', 'volume ls --format {{.Name}}',
      'ps -a --format {{.Names}}'].includes(args.join(' '))) return ''
    if (args[0] === 'run') {
      const imageRef = args.find(argument => /^sha256:[a-f0-9]{64}$/.test(argument))
      const image = [...fakeDocker.images.values()].find(candidate => candidate.id === imageRef)
      if (!image) throw new Error(`No such image: ${imageRef}`)
      fakeDocker.launches.push(imageRef!)
      return `${'f'.repeat(64)}\n`
    }
    throw new Error(`unexpected Docker command: ${args.join(' ')}`)
  }
  const spawnSync = (program: string, args: string[]) => {
    if (program === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
      try { return { status: 0, stdout: String(execFileSync(program, args)), stderr: '' } }
      catch (error) { return { status: 1, stdout: '', stderr: String(error) } }
    }
    if (program === 'docker' && ['inspect', 'rm'].includes(args[0]!)) {
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected spawned command: ${program} ${args.join(' ')}`)
  }
  return { execFileSync, spawnSync, default: { execFileSync, spawnSync } }
})

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'

describe('run-owned runtime workload image lifetime', () => {
  it('keeps overlapping harness images resolvable after one owner cleans up', async () => {
    fakeDocker.images.clear()
    fakeDocker.buildTags = []
    fakeDocker.launches = []
    fakeDocker.removals = []
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-runtime-image-owner-'))
    const first = new RuntimeHarness(repoRoot, '11111111-1111-4111-8111-111111111111', 2)
    const second = new RuntimeHarness(repoRoot, '22222222-2222-4222-8222-222222222222', 2)
    const ensureImage = (harness: RuntimeHarness) =>
      (harness as unknown as { ensureRuntimeImage(): void }).ensureRuntimeImage()

    try {
      ensureImage(first)
      ensureImage(second)

      expect(new Set(fakeDocker.buildTags).size).toBe(2)
      expect(fakeDocker.buildTags[0]).not.toBe(fakeDocker.buildTags[1])
      expect(first.imageRef).not.toBe(second.imageRef)

      await expect(first.cleanup()).resolves.toMatchObject({ ok: true, errors: [] })
      expect(fakeDocker.images.has(fakeDocker.buildTags[0]!)).toBe(false)
      expect(fakeDocker.images.has(fakeDocker.buildTags[1]!)).toBe(true)

      second.createForeignSentinel({ scenarioId: 'surviving-image' })
      expect(fakeDocker.launches).toEqual([second.imageRef])
      await expect(second.cleanup()).resolves.toMatchObject({ ok: true, errors: [] })
      expect(fakeDocker.images.size).toBe(0)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('keeps a tag when it no longer resolves to this harness exact image', async () => {
    fakeDocker.images.clear()
    fakeDocker.buildTags = []
    fakeDocker.launches = []
    fakeDocker.removals = []
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-runtime-image-owner-'))
    const harness = new RuntimeHarness(repoRoot, '33333333-3333-4333-8333-333333333333', 2)

    try {
      ;(harness as unknown as { ensureRuntimeImage(): void }).ensureRuntimeImage()
      const tag = fakeDocker.buildTags[0]!
      const image = fakeDocker.images.get(tag)!
      fakeDocker.images.set(tag, { ...image, id: `sha256:${'b'.repeat(64)}` })

      const result = await harness.cleanup()

      expect(result.ok).toBe(false)
      expect(result.errors.join('\n')).toContain('runtime image is not the exact owned artifact')
      expect(fakeDocker.images.has(tag)).toBe(true)
      expect(fakeDocker.removals).toEqual([])
      const cleanup = JSON.parse(await fs.readFile(path.join(harness.evidenceDir, 'cleanup.json'), 'utf8'))
      expect(cleanup.runtimeImage).toMatchObject({ tag, removed: false })
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})
