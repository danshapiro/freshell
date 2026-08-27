import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { describe, it, expect, afterEach } from 'vitest'
import {
  sha256File,
  writeManifest,
  loadSessionCorpusManifest,
  walkCoveragePaths,
  type CorpusManifest,
} from './manifest.js'
import { claudeProjectSlug, writeClaudeSession } from './claude.js'
import { codexDatePath, writeCodexSession } from './codex.js'
import { writeOpencodeCorpus, type OpencodeSessionSpec } from './opencode.js'
import { writeAmplifierSession } from './amplifier.js'
import { createNestedGitRepos, createWorktreePair } from './git-layout.js'
import { buildSessionCorpus } from './index.js'
import {
  clearRepoRootCache,
  resolveGitCheckoutRoot,
  resolveGitRepoRoot,
} from '../../../../scripts/testing/repo-context.js'
import type { CorpusContext } from './types.js'

/**
 * HARNESS-04 unit tests: the corpus manifest/hashing core.
 * Playwright contract proof lives in specs/harness-04-session-corpus.spec.ts.
 * Real files are written under os.tmpdir() mkdtemp homes only.
 */

const tempHomes: string[] = []

async function mkHome(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'h04-unit-'))
  tempHomes.push(home)
  return home
}

afterEach(async () => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!
    await fsp.rm(home, { recursive: true, force: true })
  }
})

function sampleManifest(homeDir: string): CorpusManifest {
  return {
    formatVersion: 1,
    runId: 'h04corpus-testtoken',
    generatedAt: '2026-08-09T00:00:00.000Z',
    homeDir,
    providers: ['claude', 'codex', 'opencode', 'amplifier'],
    roots: {
      claudeProjects: path.join(homeDir, '.claude', 'projects'),
      codexSessions: path.join(homeDir, '.codex', 'sessions'),
      codexArchived: path.join(homeDir, '.codex', 'archived_sessions'),
      opencodeData: path.join(homeDir, '.local', 'share', 'opencode'),
      amplifierProjects: path.join(homeDir, '.amplifier', 'projects'),
      freshellConfig: path.join(homeDir, '.freshell', 'config.json'),
      corpusWorkspace: path.join(homeDir, 'h04corpus-testtoken'),
    },
    files: [],
    sessions: [],
    gitFixtures: [],
    pagination: { listedCount: 67, pageLimit: 50, expectedPages: 2 },
  }
}

describe('session-corpus manifest core', () => {
  it('sha256File hashes known content', async () => {
    const home = await mkHome()
    const file = path.join(home, 'known.txt')
    await fsp.writeFile(file, 'hello corpus\n')
    const hash = await sha256File(file)
    // printf 'hello corpus\n' | sha256sum
    expect(hash).toBe('15f085ae206701271d2791c17f98b98439c7d681772d8f32a481082eb4ce88a4')
  })

  it('writeManifest + loadSessionCorpusManifest round-trips through disk', async () => {
    const home = await mkHome()
    const manifest = sampleManifest(home)
    manifest.files = [{
      path: '.claude/projects/x.jsonl',
      sha256: '00'.repeat(32),
      bytes: 3,
      role: 'claude-session:test',
    }]
    const manifestPath = await writeManifest(home, manifest)
    expect(manifestPath.endsWith(path.join('.freshell-corpus', 'manifest.json'))).toBe(true)

    const parsed = await loadSessionCorpusManifest(home)
    expect(parsed).toEqual(manifest)
  })

  it('loadSessionCorpusManifest rejects a malformed manifest', async () => {
    const home = await mkHome()
    await fsp.mkdir(path.join(home, '.freshell-corpus'), { recursive: true })
    await fsp.writeFile(
      path.join(home, '.freshell-corpus', 'manifest.json'),
      JSON.stringify({ ...sampleManifest(home), formatVersion: 2 }),
    )
    await expect(loadSessionCorpusManifest(home)).rejects.toThrow(/formatVersion/)
  })

  it('loadSessionCorpusManifest rejects a missing manifest', async () => {
    const home = await mkHome()
    await expect(loadSessionCorpusManifest(home)).rejects.toThrow()
  })

  it('walkCoveragePaths lists regular files with stable relative posix paths, sorted', async () => {
    const home = await mkHome()
    await fsp.mkdir(path.join(home, '.claude', 'projects', 'p-x'), { recursive: true })
    await fsp.writeFile(path.join(home, '.claude', 'projects', 'p-x', 'a.jsonl'), 'a\n')
    await fsp.writeFile(path.join(home, 'solo.txt'), 'b\n')
    await fsp.mkdir(path.join(home, 'empty-dir'), { recursive: true })
    await fsp.mkdir(path.join(home, '.codex', 'sessions', '2026', '08'), { recursive: true })
    await fsp.writeFile(path.join(home, '.codex', 'sessions', '2026', '08', 'r.jsonl'), 'c\n')

    const rels = await walkCoveragePaths(home)
    expect(rels).toEqual([
      '.claude/projects/p-x/a.jsonl',
      '.codex/sessions/2026/08/r.jsonl',
      'solo.txt',
    ])
  })
})

function mkCtx(homeDir: string): CorpusContext {
  return {
    homeDir,
    runToken: 'testtoken',
    marker: 'h04corpus-testtoken',
    workspace: path.join(homeDir, 'h04corpus-testtoken'),
    files: [],
    sessions: [],
    gitFixtures: [],
  }
}

describe('session-corpus claude writer', () => {
  it('encodes project dirs with the real Claude slug rule (non-alphanumerics → -)', () => {
    expect(claudeProjectSlug('/tmp/h04corpus-abc12/my-project'))
      .toBe('-tmp-h04corpus-abc12-my-project')
  })

  it('writes init + turns + trailing summary, registers hash + listed expectation', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'alpha-project')
    const createdAt = Date.parse('2026-08-04T09:00:00.000Z')
    const lastActivityAt = createdAt + 4 // init=+0, user1=+1, asst1=+2, user2=+3, asst2=+4
    const exp = await writeClaudeSession(ctx, {
      role: 'alpha',
      sessionId: '00000000-0000-4000-8000-0000000000a1',
      cwd,
      titleText: 'h04corpus-testtoken alpha',
      turns: 2,
      withSummary: true,
      createdAt,
      lastActivityAt,
    })

    const file = path.join(home, '.claude', 'projects', claudeProjectSlug(cwd),
      '00000000-0000-4000-8000-0000000000a1.jsonl')
    const raw = await fsp.readFile(file, 'utf-8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l))

    // init line: cwd + session id + createdAt timestamp
    expect(lines[0].type).toBe('system')
    expect(lines[0].subtype).toBe('init')
    expect(lines[0].cwd).toBe(cwd)
    expect(lines[0].session_id).toBe('00000000-0000-4000-8000-0000000000a1')
    expect(lines[0].timestamp).toBe('2026-08-04T09:00:00.000Z')
    // two user + two assistant turns, parentUuid chain
    const roles = lines.slice(1, 5).map((l) => l.type)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(lines[2].parentUuid).toBe(lines[1].uuid)
    expect(lines[3].parentUuid).toBe(lines[2].uuid)
    // tail = summary line WITHOUT timestamp (drives title, not recency)
    const tail = lines[5]
    expect(tail.type).toBe('summary')
    expect(tail.summary).toBe('h04corpus-testtoken alpha')
    expect(tail.timestamp).toBeUndefined()
    // last timestamped line = lastActivityAt (the server's tail-walk lands here)
    expect(lines[4].timestamp).toBe('2026-08-04T09:00:00.004Z')

    // registered file hash + expectation
    expect(ctx.files).toHaveLength(1)
    expect(ctx.files[0].path.startsWith('.claude/projects/')).toBe(true)
    expect(ctx.files[0].path.endsWith('/00000000-0000-4000-8000-0000000000a1.jsonl')).toBe(true)
    await expect(fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8')).resolves.toBe(raw)
    expect(exp).toMatchObject({
      provider: 'claude',
      role: 'alpha',
      title: 'h04corpus-testtoken alpha',
      summary: 'h04corpus-testtoken alpha',
      projectPath: cwd,
      cwd,
      createdAt,
      lastActivityAt,
      visibility: 'listed',
    })
    expect(ctx.sessions[0].key).toBe('claude:00000000-0000-4000-8000-0000000000a1')
  })

  it('one-message session: no reply, no summary → title from first message, hidden-default(noninteractive)', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'solo')
    const exp = await writeClaudeSession(ctx, {
      role: 'noninteractive',
      sessionId: '00000000-0000-4000-8000-0000000000b1',
      cwd,
      titleText: 'h04corpus-testtoken noninteractive',
      turns: 0,
      userMessages: 1,
      withSummary: false,
      createdAt: Date.parse('2026-07-10T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-10T10:00:00.001Z'),
    })
    const raw = await fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(['system', 'user'])
    expect(lines[1].message.content).toContain('h04corpus-testtoken noninteractive')
    // wire title mirrors the server derivation: FULL first user message text
    expect(exp.title).toBe('h04corpus-testtoken noninteractive request 1')
    expect(exp.summary).toBeUndefined()
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeNonInteractive: true })
  })

  it('init-only session: no title at all → hidden-default(empty + noninteractive)', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const exp = await writeClaudeSession(ctx, {
      role: 'untitled-empty',
      sessionId: '00000000-0000-4000-8000-0000000000c1',
      cwd: path.join(ctx.workspace, 'projects', 'empty'),
      turns: 0,
      withSummary: false,
      createdAt: Date.parse('2026-07-05T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-05T10:00:00.000Z'),
    })
    const raw = await fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect(exp.title).toBeUndefined()
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeNonInteractive: true, includeEmpty: true })
  })

  it('subagent sessions land at the real layout <slug>/<parent>/subagents/agent-<id>.jsonl', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'alpha-project')
    const createdAt = Date.parse('2026-07-08T10:00:00.000Z')
    const exp = await writeClaudeSession(ctx, {
      role: 'subagent',
      sessionId: 'a0076913f8bb3baa',
      cwd,
      titleText: 'h04corpus-testtoken subagent',
      turns: 2,
      withSummary: false,
      subagent: { parentSessionId: '10000000-0000-4000-8000-000000000101' },
      // sidechain schedule: no init line → last = createdAt + 2*turns - 1
      createdAt,
      lastActivityAt: createdAt + 3,
    })
    expect(ctx.files[0].path).toContain(
      '/10000000-0000-4000-8000-000000000101/subagents/agent-a0076913f8bb3baa.jsonl')
    // indexed id is the filename stem even though real sidechain lines embed the parent id
    expect(exp.sessionId).toBe('agent-a0076913f8bb3baa')
    const lines = (await fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('user') // no init line in sidechain transcripts
    expect(lines[0].isSidechain).toBe(true)
    expect(lines[0].sessionId).toBe('10000000-0000-4000-8000-000000000101')
    expect(lines[0].timestamp).toBe('2026-07-08T10:00:00.000Z')
    expect(lines[3].timestamp).toBe('2026-07-08T10:00:00.003Z')
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeSubagents: true })
    // title still derivable from the first user message when no summary line
    expect(exp.title).toBe('h04corpus-testtoken subagent request 1')
  })
})

describe('session-corpus codex writer', () => {
  it('writes a real rollout file under sessions/YYYY/MM/DD with session_meta + turn records', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'gamma-project')
    const createdAt = Date.parse('2026-08-03T10:00:00.000Z')
    const lastActivityAt = Date.parse('2026-08-03T10:00:00.002Z')
    const exp = await writeCodexSession(ctx, {
      role: 'gamma',
      sessionId: 'h04corpus-testtoken-codex-gamma',
      cwd,
      titleText: 'h04corpus-testtoken gamma',
      createdAt,
      lastActivityAt,
    })

    // real codex layout: sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl
    expect(exp.key).toBe('codex:h04corpus-testtoken-codex-gamma')
    const rel = ctx.files[0].path
    expect(rel).toBe(path.posix.join('.codex', 'sessions', codexDatePath(createdAt),
      `rollout-2026-08-03T10-00-00-h04corpus-testtoken-codex-gamma.jsonl`))

    const lines = (await fsp.readFile(path.join(home, rel), 'utf-8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('session_meta')
    expect(lines[0].payload.id).toBe('h04corpus-testtoken-codex-gamma')
    expect(lines[0].payload.cwd).toBe(cwd)
    expect(lines[0].timestamp).toBe('2026-08-03T10:00:00.000Z')
    expect(lines[1].type).toBe('response_item')
    expect(lines[1].payload).toMatchObject({
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'h04corpus-testtoken gamma request 1' }],
    })
    expect(lines[1].timestamp).toBe('2026-08-03T10:00:00.001Z')
    expect(lines[2].payload.role).toBe('assistant')
    expect(lines[2].timestamp).toBe('2026-08-03T10:00:00.002Z')

    expect(exp).toMatchObject({
      provider: 'codex',
      title: 'h04corpus-testtoken gamma request 1',
      // codex parse: first ASSISTANT text becomes the wire summary (240 cap)
      summary: 'h04corpus-testtoken gamma reply 1',
      projectPath: cwd,
      createdAt,
      lastActivityAt,
      visibility: 'listed',
    })
  })

  it('exec-source sessions are marked hidden-default (noninteractive)', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const exp = await writeCodexSession(ctx, {
      role: 'exec',
      sessionId: 'h04corpus-testtoken-codex-exec',
      cwd: path.join(ctx.workspace, 'projects', 'exec-project'),
      titleText: 'h04corpus-testtoken exec',
      createdAt: Date.parse('2026-07-11T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-11T10:00:00.002Z'),
      source: 'exec',
    })
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeNonInteractive: true })
  })

  it('provider-archived rollouts write under archived_sessions/ and expect absence', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const exp = await writeCodexSession(ctx, {
      role: 'provider-archived',
      sessionId: 'h04corpus-testtoken-codex-archived',
      cwd: path.join(ctx.workspace, 'projects', 'gamma-project'),
      titleText: 'h04corpus-testtoken provider archived',
      createdAt: Date.parse('2026-08-02T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-08-02T10:00:00.002Z'),
      archivedByProvider: true,
    })
    expect(ctx.files[0].path.startsWith('.codex/archived_sessions/2026/08/02/')).toBe(true)
    expect(exp.visibility).toBe('absent')
    expect(exp.title).toBeUndefined() // never indexed: no wire semantics
    expect(exp.summary).toBeUndefined()
  })
})

describe('session-corpus opencode writer', () => {
  function ocSpec(home: string, over: Partial<OpencodeSessionSpec> & Pick<OpencodeSessionSpec, 'role'>): OpencodeSessionSpec {
    return {
      sessionId: `h04corpus-oc-${over.role}`,
      title: `h04corpus-testtoken ${over.role}`,
      directory: path.join(home, 'h04corpus-testtoken', 'projects', `${over.role}-project`),
      projectId: `proj-${over.role}`,
      projectWorktree: path.join(home, 'h04corpus-testtoken', 'projects', `${over.role}-project`),
      timeCreated: Date.parse('2026-07-20T08:00:00.000Z'),
      timeUpdated: Date.parse('2026-07-20T08:00:00.001Z'),
      ...over,
    }
  }

  it('creates the DB under XDG data home and records visibility expectations', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const specs = [
      ocSpec(home, { role: 'delta' }),
      ocSpec(home, { role: 'echo', timeUpdated: Date.parse('2026-07-19T08:00:00.001Z') }),
      ocSpec(home, { role: 'archived', timeArchived: Date.parse('2026-07-21T00:00:00.000Z') }),
      ocSpec(home, { role: 'child', parentId: 'h04corpus-oc-delta' }),
    ]
    const exps = await writeOpencodeCorpus(ctx, specs)

    // one hashed db file at the XDG data location
    expect(ctx.files).toHaveLength(1)
    expect(ctx.files[0].path).toBe('.local/share/opencode/opencode.db')

    // The writer contract records the exact DB location and provider rows;
    // Rust owns production ingestion, so this helper test does not import the
    // deleted Node OpenCode reader.

    // expectations
    const byRole = (role: string) => exps.find((e) => e.role === role)!
    expect(byRole('delta')).toMatchObject({
      provider: 'opencode', visibility: 'listed',
      title: 'h04corpus-testtoken delta',
      projectPath: specs[0].projectWorktree,
      lastActivityAt: specs[0].timeUpdated, createdAt: specs[0].timeCreated,
    })
    expect(byRole('archived').visibility).toBe('absent')
    expect(byRole('archived').title).toBeUndefined()
    expect(byRole('child').visibility).toBe('absent')
  })
})

describe('session-corpus amplifier writer', () => {
  it('writes metadata.json + sidecars, pins mtimes, floors fractional numeric timestamps', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'epsilon-project')
    const created = Date.parse('2026-07-22T09:00:00.000Z') + 0.5 // fractional numeric
    const updated = Date.parse('2026-07-22T09:00:02.000Z')
    const exp = await writeAmplifierSession(ctx, {
      role: 'epsilon',
      sessionId: 'h04corpus-testtoken-amp-epsilon',
      cwd,
      name: 'h04corpus-testtoken epsilon',
      description: 'h04corpus-testtoken epsilon summary text',
      created,
      descriptionUpdatedAt: updated,
      firstUserMessage: 'h04corpus-testtoken epsilon request 1',
      withEventsSidecar: true,
    })

    const dir = path.join(home, '.amplifier', 'projects', 'epsilon-project',
      'sessions', 'h04corpus-testtoken-amp-epsilon')
    const metaRaw = await fsp.readFile(path.join(dir, 'metadata.json'), 'utf-8')
    // three hashed files
    expect(ctx.files.map((f) => f.path).sort()).toEqual([
      '.amplifier/projects/epsilon-project/sessions/h04corpus-testtoken-amp-epsilon/events.jsonl',
      '.amplifier/projects/epsilon-project/sessions/h04corpus-testtoken-amp-epsilon/metadata.json',
      '.amplifier/projects/epsilon-project/sessions/h04corpus-testtoken-amp-epsilon/transcript.jsonl',
    ])

    // Rust owns production ingestion; this helper test checks the writer's
    // metadata bytes without importing the deleted Node provider reader.
    const metadata = JSON.parse(metaRaw) as Record<string, unknown>
    expect(metadata).toMatchObject({
      session_id: 'h04corpus-testtoken-amp-epsilon',
      working_dir: cwd,
      created,
      description_updated_at: new Date(updated).toISOString(),
      name: 'h04corpus-testtoken epsilon',
      description: 'h04corpus-testtoken epsilon summary text',
    })

    // mtimes pinned to the seeded activity instant (recency fold must not
    // see build-time "now" dominating the seeded timestamps)
    for (const f of ['metadata.json', 'transcript.jsonl', 'events.jsonl']) {
      const stat = await fsp.stat(path.join(dir, f))
      expect(Math.floor(stat.mtimeMs)).toBe(updated)
    }

    // first user message is transcript-visible
    const transcript = await fsp.readFile(path.join(dir, 'transcript.jsonl'), 'utf-8')
    expect(transcript).toContain('"role":"user"')
    expect(transcript).toContain('h04corpus-testtoken epsilon request 1')

    expect(exp).toMatchObject({
      provider: 'amplifier',
      title: 'h04corpus-testtoken epsilon',
      summary: 'h04corpus-testtoken epsilon summary text',
      projectPath: cwd,
      createdAt: Math.floor(created),
      lastActivityAt: updated,
      visibility: 'listed',
    })
  })
})

describe('session-corpus git layouts', () => {
  it('nested git repos + subdir: production resolver collapses to the innermost valid .git dir', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const { outer, inner, subdir, fixture } = await createNestedGitRepos(ctx)

    // structure: outer and inner both hold a VALID .git dir (HEAD file)
    expect(await fsp.stat(path.join(outer, '.git', 'HEAD'))).toBeTruthy()
    expect(await fsp.stat(path.join(inner, '.git', 'HEAD'))).toBeTruthy()
    expect(fixture.kind).toBe('nested-repo')
    expect(fixture.expectedProjectPath).toBe(inner)
    // every fixture-internal file is hashed and declared
    expect(fixture.internalFiles).toContain(
      path.relative(home, path.join(outer, '.git', 'HEAD')).split(path.sep).join('/'))
    expect(ctx.files.some((f) => f.path.endsWith('.git/HEAD'))).toBe(true)

    clearRepoRootCache()
    // The REAL production resolvers decide whether expectations are right.
    expect(await resolveGitRepoRoot(inner)).toBe(inner)
    expect(await resolveGitRepoRoot(path.join(inner, 'src'))).toBe(inner)
    expect(await resolveGitRepoRoot(subdir)).toBe(outer)
    expect(await resolveGitCheckoutRoot(inner)).toBe(inner)
  })

  it('worktree pair: .git FILE + commondir ⇒ repo root = main repo, checkout root = worktree', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const { mainRepo, wtCheckout, fixture } = await createWorktreePair(ctx)

    // real git layout: wt/.git is a FILE pointing into main/.git/worktrees/<name>
    const gitFile = await fsp.readFile(path.join(wtCheckout, '.git'), 'utf-8')
    expect(gitFile).toBe(`gitdir: ${path.join(mainRepo, '.git', 'worktrees', path.basename(wtCheckout))}\n`)
    const common = await fsp.readFile(
      path.join(mainRepo, '.git', 'worktrees', path.basename(wtCheckout), 'commondir'), 'utf-8')
    expect(common.trim()).toBe('../..')
    expect(fixture).toMatchObject({
      kind: 'worktree',
      expectedProjectPath: mainRepo,
      expectedCheckoutPath: wtCheckout,
    })

    clearRepoRootCache()
    expect(await resolveGitRepoRoot(wtCheckout)).toBe(mainRepo)
    expect(await resolveGitCheckoutRoot(wtCheckout)).toBe(wtCheckout)
  })
})

describe('session-corpus orchestrator', () => {
  it('buildSessionCorpus: full inventory, pagination math, manifest round-trip, 100% hash coverage, markers', async () => {
    const home = await mkHome()
    const corpus = await buildSessionCorpus(home)
    const m = corpus.manifest

    // inventory: 67 listed / 7 absent / 4 hidden-default; >1 directory page at limit 50
    const listed = m.sessions.filter((s) => s.visibility === 'listed')
    const absent = m.sessions.filter((s) => s.visibility === 'absent')
    const hidden = m.sessions.filter((s) => s.visibility === 'hidden-default')
    expect(listed).toHaveLength(67)
    expect(absent).toHaveLength(7)
    expect(hidden).toHaveLength(4)
    expect(m.pagination).toEqual({ listedCount: 67, pageLimit: 50, expectedPages: 2 })

    // all four providers present among the listed sessions
    for (const provider of ['claude', 'codex', 'opencode', 'amplifier']) {
      expect(listed.some((s) => s.provider === provider)).toBe(true)
    }

    // all listed lastActivityAt values are distinct integers (stable cursor math)
    const acts = listed.map((s) => s.lastActivityAt)
    expect(new Set(acts).size).toBe(acts.length)
    for (const a of acts) expect(Number.isInteger(a)).toBe(true)

    // archived-override cohort: the 4 oldest listed sessions, flagged
    const archived = listed.filter((s) => s.archived)
    expect(archived.map((s) => s.role).sort()).toEqual([
      'archived-amplifier', 'archived-claude', 'archived-codex', 'archived-opencode',
    ])
    const nonArchivedMax = Math.max(...listed.filter((s) => !s.archived).map((s) => s.lastActivityAt))
    const archivedMax = Math.max(...archived.map((s) => s.lastActivityAt))
    expect(archivedMax).toBeLessThan(nonArchivedMax)

    // disk round-trip equality (the Playwright contract's core move)
    const disk = await loadSessionCorpusManifest(home)
    expect(disk).toEqual(m)
    expect(corpus.manifestPath).toBe(path.join(home, '.freshell-corpus', 'manifest.json'))

    // 100% hash coverage of files on disk (manifest file itself excluded)
    const walked = await walkCoveragePaths(home)
    const hashed = new Set(m.files.map((f) => f.path))
    for (const rel of walked) {
      if (rel === '.freshell-corpus/manifest.json') continue
      expect(hashed.has(rel), `unhashed file ${rel}`).toBe(true)
    }
    // hashes verify against disk
    for (const f of m.files) {
      expect(await sha256File(path.join(home, f.path))).toBe(f.sha256)
    }

    // marker embedding: every session's cwd is inside the marker workspace;
    // every DEFINED title carries it; non-claude session ids carry it
    // (claude ids stay uuid-shaped for realism — claude tripwires use the
    // cwd-derived project-slug dir name instead)
    expect(corpus.marker).toMatch(/^h04corpus-[0-9a-z]+$/)
    for (const s of m.sessions) {
      expect(s.cwd, `${s.key} cwd`).toContain(corpus.marker)
      if (s.title !== undefined) {
        expect(s.title, `${s.key} title`).toContain(corpus.marker)
      }
      if (s.provider !== 'claude') {
        expect(s.sessionId, `${s.key} sessionId`).toContain(corpus.marker)
      }
    }

    // git fixtures recorded with expected resolutions
    expect(m.gitFixtures.map((g) => g.kind).sort()).toEqual(['nested-repo', 'repo-subdir', 'worktree'])

    // provider title sources: claude summary, opencode row title, amplifier name
    const alpha = listed.find((s) => s.role === 'alpha')!
    expect(alpha.title).toContain(corpus.marker)
    expect(alpha.summary).toBe(alpha.title)
    const delta = listed.find((s) => s.role === 'delta')!
    expect(delta.title).toContain(corpus.marker)
    const epsilon = listed.find((s) => s.role === 'epsilon')!
    expect(epsilon.summary).toContain('summary')

    // user-override layering on opencode echo
    const echo = listed.find((s) => s.role === 'echo')!
    expect(echo.title).toBe(`${corpus.marker} echo renamed`)
    expect(echo.summary).toBe(`${corpus.marker} echo override summary`)

    // freshell config on disk carries the overrides keyed by composite key
    const cfg = JSON.parse(
      await fsp.readFile(path.join(home, '.freshell', 'config.json'), 'utf-8'))
    const deleted = m.sessions.find((s) => s.role === 'deleted-claude')!
    expect(cfg.sessionOverrides[deleted.key]).toEqual({ deleted: true })
    const archivedClaude = m.sessions.find((s) => s.role === 'archived-claude')!
    expect(cfg.sessionOverrides[archivedClaude.key]).toEqual({ archived: true })
    expect(cfg.settings.codingCli.enabledProviders)
      .toEqual(['claude', 'codex', 'opencode', 'amplifier'])
  })

  it('bulkCount override scales the corpus while preserving invariants', async () => {
    const home = await mkHome()
    const corpus = await buildSessionCorpus(home, { bulkCount: 55, runToken: 'scaled01' })
    expect(corpus.manifest.pagination.listedCount).toBe(70)
    expect(corpus.marker).toBe('h04corpus-scaled01')
    const bulk = corpus.manifest.sessions.filter((s) => s.role.startsWith('bulk-'))
    expect(bulk).toHaveLength(55)
  })
})

describe('session-corpus claude writer validation', () => {
  it('rejects a turns>0 spec whose lastActivityAt does not match the turn schedule', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    await expect(writeClaudeSession(ctx, {
      role: 'bad',
      sessionId: '00000000-0000-4000-8000-0000000000e1',
      cwd: path.join(ctx.workspace, 'projects', 'bad'),
      titleText: 'bad',
      turns: 2,
      withSummary: true,
      createdAt: 1000,
      lastActivityAt: 9999, // schedule demands createdAt + 4
    })).rejects.toThrow(/lastActivityAt/)
  })
})
