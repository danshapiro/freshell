#!/usr/bin/env npx tsx
/**
 * Measure session payload bandwidth: uncompressed vs compressed, full vs paginated.
 *
 * Usage:
 *   FRESHELL_URL=http://localhost:3001 FRESHELL_TOKEN=... npx tsx scripts/measure-bandwidth.ts
 */
import { deflateRawSync } from 'node:zlib'

const url = process.env.FRESHELL_URL || 'http://localhost:3001'
const token = process.env.FRESHELL_TOKEN || ''

async function fetchSessions(): Promise<unknown[]> {
  const res = await fetch(`${url}/api/sessions`, {
    headers: { 'x-auth-token': token },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  return res.json() as Promise<unknown[]>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function compressSize(json: string, level: 1 | 6 = 1): number {
  return deflateRawSync(Buffer.from(json), { level }).length
}

interface ProjectLike {
  projectPath: string
  sessions: Array<{ lastActivityAt: number; sessionId: string; [k: string]: unknown }>
  [k: string]: unknown
}

function paginateLocal(projects: ProjectLike[], limit: number): ProjectLike[] {
  // Flatten, sort by recency, take top N, regroup
  const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, _projectPath: p.projectPath, _color: (p as any).color })))
  all.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const page = all.slice(0, limit)
  const groups = new Map<string, { sessions: any[]; color?: string }>()
  for (const s of page) {
    const path = s._projectPath
    if (!groups.has(path)) groups.set(path, { sessions: [], color: s._color })
    const { _projectPath, _color, ...session } = s
    groups.get(path)!.sessions.push(session)
  }
  return Array.from(groups.entries()).map(([path, g]) => ({
    projectPath: path,
    sessions: g.sessions,
    ...(g.color ? { color: g.color } : {}),
  }))
}

async function main() {
  console.log(`\nMeasuring session bandwidth against ${url}\n`)
  console.log('='.repeat(60))

  const projects = await fetchSessions() as ProjectLike[]
  const totalSessions = projects.reduce((sum, p) => sum + p.sessions.length, 0)
  const totalProjects = projects.length

  // Full payload (current behavior on main)
  const fullJson = JSON.stringify({ type: 'sessions.updated', projects })
  const fullBytes = Buffer.byteLength(fullJson)
  const fullCompressedBytes = compressSize(fullJson, 1)

  console.log(`\nDataset: ${totalSessions} sessions across ${totalProjects} projects`)
  console.log('-'.repeat(60))

  console.log('\n## Full Snapshot (current main behavior)')
  console.log(`  Uncompressed:     ${formatBytes(fullBytes)}`)
  console.log(`  Compressed (L1):  ${formatBytes(fullCompressedBytes)}`)
  console.log(`  Compression ratio: ${((1 - fullCompressedBytes / fullBytes) * 100).toFixed(1)}%`)

  // Paginated payload (limit 100)
  const paginated = paginateLocal(projects, 100)
  const paginatedSessions = paginated.reduce((sum, p) => sum + p.sessions.length, 0)
  const paginatedJson = JSON.stringify({ type: 'sessions.updated', projects: paginated })
  const paginatedBytes = Buffer.byteLength(paginatedJson)
  const paginatedCompressedBytes = compressSize(paginatedJson, 1)

  console.log('\n## Paginated Snapshot (limit=100)')
  console.log(`  Sessions sent:    ${paginatedSessions} of ${totalSessions}`)
  console.log(`  Uncompressed:     ${formatBytes(paginatedBytes)}`)
  console.log(`  Compressed (L1):  ${formatBytes(paginatedCompressedBytes)}`)
  console.log(`  Compression ratio: ${((1 - paginatedCompressedBytes / paginatedBytes) * 100).toFixed(1)}%`)

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('## Savings Summary (per reconnect)')
  console.log('-'.repeat(60))

  const compressOnlySaving = fullBytes - fullCompressedBytes
  console.log(`  Compression only:        ${formatBytes(fullBytes)} → ${formatBytes(fullCompressedBytes)} (saves ${formatBytes(compressOnlySaving)}, ${((compressOnlySaving / fullBytes) * 100).toFixed(1)}%)`)

  const paginateOnlySaving = fullBytes - paginatedBytes
  console.log(`  Pagination only:         ${formatBytes(fullBytes)} → ${formatBytes(paginatedBytes)} (saves ${formatBytes(paginateOnlySaving)}, ${((paginateOnlySaving / fullBytes) * 100).toFixed(1)}%)`)

  const bothSaving = fullBytes - paginatedCompressedBytes
  console.log(`  Both (compression+page): ${formatBytes(fullBytes)} → ${formatBytes(paginatedCompressedBytes)} (saves ${formatBytes(bothSaving)}, ${((bothSaving / fullBytes) * 100).toFixed(1)}%)`)

  // Per-reconnect in mobile scenario (20 min, ~1 reconnect/min when sleeping)
  const reconnectsIn20Min = 20
  console.log(`\n## Estimated 20-minute mobile session (${reconnectsIn20Min} reconnects)`)
  console.log(`  Before (uncompressed, full): ${formatBytes(fullBytes * reconnectsIn20Min)}`)
  console.log(`  After (compressed, paginated): ${formatBytes(paginatedCompressedBytes * reconnectsIn20Min)}`)
  console.log(`  Total saved: ${formatBytes((fullBytes - paginatedCompressedBytes) * reconnectsIn20Min)}`)

  console.log()
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
