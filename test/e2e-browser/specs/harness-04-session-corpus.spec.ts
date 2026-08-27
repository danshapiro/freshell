/**
 * HARNESS-04 — Multi-provider session corpus builder (contract spec).
 *
 * The corpus builder (`test/e2e-browser/helpers/session-corpus/`) generates
 * isolated Claude, Codex, OpenCode, and Amplifier histories — archived and
 * deleted sessions, summaries, provider titles, nested git repositories,
 * worktrees, fractional timestamps, and more than one page of results — into
 * a throwaway HOME plus a hashed manifest. This spec is the checklist's
 * Playwright validation for the harness item itself:
 *
 *   Leg A (fixture-only contract): build into an isolated tmp home, re-parse
 *     the manifest FROM DISK, recompute every sha256, prove 100% hash
 *     coverage and inventory semantics, delete the temp home, and prove the
 *     REAL provider homes were untouched (marker tripwires + absent-dir
 *     strictness, the attributable layers from harness-01's live-host idiom).
 *
 *   Leg B (legacy-open semantics): boot the LEGACY server against a corpus
 *     home and drive the real `/api/session-directory` read model through
 *     `page.request` — >1 page via nextCursor, exact identity/title/summary/
 *     projectPath/checkoutPath/archived/fractional-order matching vs the
 *     manifest, absence of the deleted/provider-archived cohort, and the
 *     documented toggle-only visibility of the default-hidden cohort.
 *
 *   Leg C (UI spot-check): the real sidebar surfaces the seeded alpha/gamma/
 *     delta/epsilon titles — the corpus is genuinely browsable.
 *
 * Per the checklist validation text this does NOT exercise Rust
 * multi-provider indexing — the server leg uses the Rust baseline under
 * matrix projects; Rust-side indexing of this corpus belongs to the later
 * SESSION-* items.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import {
  buildSessionCorpus,
  loadSessionCorpusManifest,
  walkCoveragePaths,
  sha256File,
  type SessionCorpus,
  type CorpusManifest,
  type CorpusSessionExpectation,
} from '../helpers/session-corpus/index.js'

/* ------------------------------------------------------------------ */
/* real-home tripwires                                                  */
/* ------------------------------------------------------------------ */

function realHomeRoots() {
  const home = os.homedir()
  return {
    claudeProjects: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex'),
    amplifier: path.join(home, '.amplifier'),
    opencodeData: path.join(home, '.local', 'share', 'opencode'),
    freshellConfig: path.join(home, '.freshell', 'config.json'),
  }
}

type RealHomeState = {
  /** dir-present flags BEFORE the test */
  dirs: Record<string, boolean>
}

async function captureRealHomeState(): Promise<RealHomeState> {
  const roots = realHomeRoots()
  const dirs: Record<string, boolean> = {}
  for (const [key, p] of Object.entries(roots)) {
    if (key === 'freshellConfig') continue
    dirs[key] = fs.existsSync(p)
  }
  return { dirs }
}

/**
 * Attributable, live-host-safe leak detector. Uses ONLY
 * `h04corpus-<runToken>`-marked material, so any hit is provably caused by
 * this corpus. Directories are scanned name-only (depth-capped) — no content
 * hashing of the user's real data. Absent-before dirs must stay absent.
 */
async function assertRealHomeUntouched(marker: string, before: RealHomeState): Promise<void> {
  const roots = realHomeRoots()
  const markerHits: string[] = []

  async function scanNames(root: string, maxDepth: number, depth = 0): Promise<void> {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name)
      if (entry.name.includes(marker)) markerHits.push(full)
      if (entry.isDirectory()) await scanNames(full, maxDepth, depth + 1)
    }
  }

  for (const [key, p] of Object.entries(roots)) {
    if (key === 'freshellConfig') continue
    const exists = fs.existsSync(p)
    if (!exists) {
      // absent-before ⇒ still-absent (a creation leak would be attributable)
      // If it was present before, we know it exists — marker scan below.
      continue
    }
    // codex rollouts sit at sessions/YYYY/MM/DD/… → depth 5 names suffice
    await scanNames(p, key === 'codex' ? 5 : 3)
  }
  // harness-01 idiom: a dir that did NOT exist before must not exist now.
  for (const [key, wasPresent] of Object.entries(before.dirs)) {
    const p = (realHomeRoots() as Record<string, string>)[key]
    if (!wasPresent) {
      expect(fs.existsSync(p), `real ${p} must not have been created`).toBe(false)
    }
  }
  expect(markerHits, `leaked corpus paths in real home: ${markerHits.join(', ')}`).toEqual([])

  // real freshell config must not have absorbed corpus overrides
  const cfgPath = roots.freshellConfig
  if (fs.existsSync(cfgPath)) {
    const raw = await fsp.readFile(cfgPath, 'utf-8')
    expect(raw.includes(marker), `real ~/.freshell/config.json contains ${marker}`).toBe(false)
  }
}

/* ------------------------------------------------------------------ */
/* Leg A — fixture-only contract                                        */
/* ------------------------------------------------------------------ */

const corpusHolder: { value?: SessionCorpus } = {}

// The override + dependent are worker-scoped, and fixtures.ts declares its
// worker-scope fixtures in the test-fixture type param, so re-declare
// testServer here at the correct (worker) scope for typed dependencies.
const test = base.extend<Record<string, never>, {
  corpusWorker: SessionCorpus
  testServer: E2eServerHandle
}>({
  // Worker-scoped corpus built ONCE inside the legacy server's isolated home.
  testServer: [async ({}, use) => {
    corpusHolder.value = undefined
    const server = await createE2eServerHandle(process.env, {
      construct: {
        setupHome: async (homeDir) => {
          corpusHolder.value = await buildSessionCorpus(homeDir)
        },
      },
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],

  corpusWorker: [async ({ testServer }, use) => {
    // Ordering dependency only: the corpus is built inside testServer's
    // setupHome hook; referencing the fixture guarantees it booted first.
    void testServer
    if (!corpusHolder.value) throw new Error('corpus was not built by setupHome')
    await use(corpusHolder.value)
  }, { scope: 'worker' }],
})

function listedSessions(manifest: CorpusManifest): CorpusSessionExpectation[] {
  return manifest.sessions.filter((s) => s.visibility === 'listed')
}

test.describe('HARNESS-04: session corpus builder', () => {
  test.setTimeout(120_000)

  test('leg A: fixture-only contract — manifest/hashes/semantics, temp home deleted, real home untouched', async () => {
    const before = await captureRealHomeState()
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-h04-corpus-'))
    let marker = ''
    try {
      const corpus = await buildSessionCorpus(home)
      marker = corpus.marker

      // positive isolation: the corpus demonstrably wrote under the tmp home
      for (const rootRel of ['.claude/projects', '.codex/sessions', '.codex/archived_sessions',
        '.local/share/opencode', '.amplifier/projects', '.freshell']) {
        expect(fs.existsSync(path.join(home, rootRel)), `corpus root ${rootRel}`).toBe(true)
      }

      // 1. manifest parses FROM DISK and equals the builder's object
      const disk = await loadSessionCorpusManifest(home)
      expect(disk).toEqual(corpus.manifest)

      // 2. every file hash verifies; coverage: every file on disk is hashed
      const walked = await walkCoveragePaths(home)
      const hashed = new Set(disk.files.map((f) => f.path))
      for (const rel of walked) {
        if (rel === '.freshell-corpus/manifest.json') continue
        expect(hashed.has(rel), `unhashed file ${rel}`).toBe(true)
      }
      for (const file of disk.files) {
        expect(await sha256File(path.join(home, file.path)), file.path).toBe(file.sha256)
      }

      // 3. inventory semantics
      const listed = listedSessions(disk)
      expect(listed.length).toBe(disk.pagination.listedCount)
      expect(disk.pagination.listedCount).toBeGreaterThan(disk.pagination.pageLimit)
      expect(disk.pagination.expectedPages).toBeGreaterThanOrEqual(2)
      expect(new Set(listed.map((s) => s.provider))).toEqual(
        new Set(['claude', 'codex', 'opencode', 'amplifier']),
      )

      // archived/deleted/summaries/provider titles/nested/worktree/fractional
      const byRole = (role: string) => disk.sessions.find((s) => s.role === role)!
      expect(byRole('archived-claude').archived).toBe(true)
      expect(byRole('deleted-claude').visibility).toBe('absent')
      expect(byRole('provider-archived-codex').visibility).toBe('absent')
      expect(byRole('provider-archived-opencode').visibility).toBe('absent')
      expect(byRole('alpha').summary).toBe(`${marker} alpha`)
      expect(byRole('delta').title).toBe(`${marker} delta`)
      expect(byRole('epsilon').title).toBe(`${marker} epsilon`)
      expect(byRole('nested-repo').projectPath).toContain('inner-repo')
      expect(byRole('worktree').checkoutPath).toContain('wt-session')
      expect(byRole('worktree').projectPath).toContain('main-repo')
      // fractional: exact integer-ms expectations recover the seeded fractions
      const frac = ['frac-100', 'frac-200', 'frac-300'].map(byRole)
      expect(frac.map((s) => s.lastActivityAt % 1000).sort()).toEqual([100, 200, 300])

      // git fixture structure actually matches git's layout
      const worktreeFx = disk.gitFixtures.find((g) => g.kind === 'worktree')!
      const wtGitFile = path.join(home, worktreeFx.path, '.git')
      expect((await fsp.readFile(wtGitFile, 'utf-8')).startsWith('gitdir: ')).toBe(true)
    } finally {
      await fsp.rm(home, { recursive: true, force: true })
    }

    // It deletes the temporary home…
    expect(fs.existsSync(home)).toBe(false)
    // …and proves the real home was untouched. The '' guard keeps a failed
    // build (marker never assigned) from scanning "contains('')" — true for
    // every filename — against the real home.
    if (marker) await assertRealHomeUntouched(marker, before)
  })

  /* ---------------------------------------------------------------- */
  /* Leg B — legacy-open expected semantics                             */
  /* ---------------------------------------------------------------- */

  test('leg B: legacy server pages the corpus with exact manifest semantics', async ({ page, corpusWorker, serverInfo }) => {
    const manifest = corpusWorker.manifest
    const listed = listedSessions(manifest)
    const pageLimit = manifest.pagination.pageLimit

    const fetchPage = async (cursor?: string, extra?: string) => {
      const url = `${serverInfo.baseUrl}/api/session-directory?priority=visible&limit=${pageLimit}`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
        + (extra ?? '')
      const response = await page.request.get(url, {
        headers: { 'x-auth-token': serverInfo.token },
      })
      expect(response.ok()).toBe(true)
      return response.json() as Promise<{
        items: Array<Record<string, any>>
        nextCursor: string | null
        revision: number
      }>
    }

    // Wait for the indexer to see every listed corpus session.
    await expect(async () => {
      const page1 = await fetchPage()
      expect(page1.items.length).toBe(pageLimit)
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1000, 2000] })

    // ── pagination: page 1 of 50, then the remainder via nextCursor ──
    const page1 = await fetchPage()
    expect(page1.items).toHaveLength(pageLimit)
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await fetchPage(page1.nextCursor!)
    expect(page2.items).toHaveLength(listed.length - pageLimit)
    expect(page2.nextCursor).toBeNull()
    const all = [...page1.items, ...page2.items]

    // union == manifest listed keys, exactly once
    const manifestKeys = listed.map((s) => s.key).sort()
    expect(all.map((i) => `${i.provider}:${i.sessionId}`).sort()).toEqual(manifestKeys)

    const byKey = new Map(all.map((i) => [`${i.provider}:${i.sessionId}`, i]))

    // ── exact identity fields for every headlined special ────────────
    for (const expected of listed) {
      const item = byKey.get(expected.key)! as any
      if (expected.title !== undefined) {
        expect(item.title, `${expected.role} title`).toBe(expected.title)
      }
      if (expected.summary !== undefined) {
        expect(item.summary, `${expected.role} summary`).toBe(expected.summary)
      }
      expect(item.projectPath, `${expected.role} projectPath`).toBe(expected.projectPath)
      expect(item.cwd, `${expected.role} cwd`).toBe(expected.cwd)
      expect(item.lastActivityAt, `${expected.role} lastActivityAt`).toBe(expected.lastActivityAt)
      if (expected.createdAt !== undefined) {
        expect(item.createdAt, `${expected.role} createdAt`).toBe(expected.createdAt)
      }
      if (expected.checkoutPath !== undefined) {
        expect(item.checkoutPath, `${expected.role} checkoutPath`).toBe(expected.checkoutPath)
      }
      if (expected.archived) {
        expect(item.archived, `${expected.role} archived`).toBe(true)
      }
    }

    // ── fractional ordering: strict lastActivityAt desc among the
    // non-archived; frac trio resolves ms within one second ───────────
    const nonArchived = all.filter((i) => !i.archived)
    for (let i = 1; i < nonArchived.length; i += 1) {
      expect(nonArchived[i].lastActivityAt).toBeLessThanOrEqual(nonArchived[i - 1].lastActivityAt)
    }
    const fracOrder = nonArchived
      .filter((i) => (i.title as string).includes('frac-'))
      .map((i) => i.title)
    expect(fracOrder).toEqual([
      `${corpusWorker.marker} frac-300`,
      `${corpusWorker.marker} frac-200`,
      `${corpusWorker.marker} frac-100`,
    ])

    // ── archived-override cohort: flagged, at the tail, time-desc ────
    const archivedItems = all.filter((i) => i.archived)
    expect(archivedItems.map((i) => `${i.provider}:${i.sessionId}`).sort()).toEqual(
      ['archived-amplifier', 'archived-claude', 'archived-codex', 'archived-opencode']
        .map((r) => {
          const s = manifest.sessions.find((x) => x.role === r)!
          return s.key
        }).sort(),
    )
    const tail = all.slice(-4)
    expect(tail.every((i) => i.archived)).toBe(true)
    // tail order fixed by seeded timestamps: claude > codex > opencode > amplifier
    const archivedOrder = ['archived-claude', 'archived-codex', 'archived-opencode', 'archived-amplifier']
      .map((r) => manifest.sessions.find((x) => x.role === r)!)
    expect(tail.map((i) => `${i.provider}:${i.sessionId}`)).toEqual(archivedOrder.map((s) => s.key))
    expect(tail.map((i) => i.title)).toEqual(archivedOrder.map((s) => s.title))

    // ── deleted / provider-archived / child cohorts: never appear ────
    const absent = manifest.sessions.filter((s) => s.visibility === 'absent')
    expect(absent).toHaveLength(7)
    for (const expected of absent) {
      expect(byKey.has(expected.key), `${expected.role} must be absent`).toBe(false)
    }

    // ── default-hidden cohorts: toggle-only visibility ───────────────
    const hidden = manifest.sessions.filter((s) => s.visibility === 'hidden-default')
    expect(hidden).toHaveLength(4)
    for (const expected of hidden) {
      expect(byKey.has(expected.key), `${expected.role} hidden by default`).toBe(false)
    }

    const titleOf = async (key: string, extra: string): Promise<any> => {
      const keys = new Set<string>()
      let cursor: string | undefined
      do {
        const p = await fetchPage(cursor, extra)
        for (const item of p.items) keys.add(`${item.provider}:${item.sessionId}`)
        if (keys.has(key)) return p.items.find(
          (i) => `${i.provider}:${i.sessionId}` === key)
        cursor = p.nextCursor ?? undefined
      } while (cursor)
      return undefined
    }

    const subagent = hidden.find((s) => s.role === 'subagent')!
    expect(await titleOf(subagent.key, '&includeSubagents=1')).toMatchObject({
      title: `${corpusWorker.marker} subagent request 1`,
    })

    const noninteractive = hidden.find((s) => s.role === 'noninteractive')!
    expect(await titleOf(noninteractive.key, '&includeNonInteractive=1')).toMatchObject({
      title: `${corpusWorker.marker} noninteractive request 1`,
    })
    const codexExec = hidden.find((s) => s.role === 'codex-exec')!
    expect(await titleOf(codexExec.key, '&includeNonInteractive=1')).toMatchObject({
      title: `${corpusWorker.marker} codex-exec request 1`,
    })
    // the init-only session surfaces only when BOTH flags allow it
    const empty = hidden.find((s) => s.role === 'untitled-empty')!
    expect(await titleOf(empty.key, '&includeNonInteractive=1')).toBeUndefined()
    expect(await titleOf(empty.key, '&includeNonInteractive=1&includeEmpty=1')).toBeTruthy()
  })

  /* ---------------------------------------------------------------- */
  /* Leg C — the corpus renders in the real UI                          */
  /* ---------------------------------------------------------------- */

  test('leg C: seeded four-provider corpus is browsable in the sidebar', async ({ freshellPage, page, corpusWorker }) => {
    const marker = corpusWorker.marker
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('No sessions yet')).not.toBeVisible()

    // First window: the newest page (the 52-session bulk cohort tops the
    // recency sort) proves live browsing of the corpus at page scale.
    await expect(page.getByText(`${marker} bulk 001`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(`${marker} bulk 050`)).toBeVisible({ timeout: 15_000 })

    // Deep-corpus headline sessions live past the first window; the sidebar
    // search (title tier → server query over the FULL index) must find each.
    const searchBox = page.getByPlaceholder('Search...')
    for (const title of [
      `${marker} alpha`,
      `${marker} gamma request 1`,
      `${marker} delta`,
      `${marker} epsilon`,
    ]) {
      await searchBox.fill(title)
      await expect(page.getByText(title).first()).toBeVisible({ timeout: 15_000 })
    }
    await page.getByLabel('Clear search').click()
    await expect(page.getByText(`${marker} bulk 001`)).toBeVisible({ timeout: 15_000 })
  })
})
