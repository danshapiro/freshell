// Runs claude-cli-scenarios.mjs in a child process and gives tests labelled
// access to its trace: every uuid is replaced by its scenario label (u1, X,
// keepAt, ...), and uuids the CLI minted itself become "cli".
//
// The contract suite (claude-cli-contract.test.ts) reads the labelled trace of
// the real CLI and asserts the T1-T19 facts.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../../..')
export const SCENARIO_RUNNER = path.join(here, 'claude-cli-scenarios.mjs')

export type Target = 'real'

export interface TraceEvent {
  t: number
  s?: string
  k: string
  m?: any
  [key: string]: any
}

export interface ScenarioResult {
  target: Target
  scenario: string
  versions: Record<string, string | null>
  failure?: string
  labels: Record<string, string>
  observations: Record<string, any>
  events: TraceEvent[]
  providerRequests: Array<Record<string, unknown>>
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Deep-replace every uuid inside `value` with its label ("cli" when unknown). */
export function relabel<T>(result: Pick<ScenarioResult, 'labels'>, value: T): T {
  const swap = (text: string) => text.replace(UUID_RE, (uuid) => result.labels[uuid] ?? result.labels[uuid.toLowerCase()] ?? 'cli')
  const walk = (v: any): any => {
    if (typeof v === 'string') return swap(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

export interface RunOptions {
  timeoutMs?: number
  env?: Record<string, string>
}

/** Run one scenario in its own process. Rejects (never resolves to a skip) when the runner fails. */
export function runScenario(target: Target, scenario: string, { timeoutMs = 90_000, env = {} }: RunOptions = {}): Promise<ScenarioResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCENARIO_RUNNER, target, scenario], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${target}/${scenario} timed out after ${timeoutMs} ms; stderr=${stderr.slice(-2000)}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${target}/${scenario} runner exited ${code ?? signal}; stderr=${stderr.slice(-4000)}`))
        return
      }
      try {
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as ScenarioResult
        if (result.failure) {
          reject(new Error(`${target}/${scenario} failed: ${result.failure}\nstderr=${stderr.slice(-2000)}`))
          return
        }
        resolve({ ...result, observations: relabel(result, result.observations) })
      } catch (error) {
        reject(new Error(`${target}/${scenario} printed no result (${String(error)}); stderr=${stderr.slice(-2000)}`))
      }
    })
  })
}

/** Memoize scenario runs for one test file (scenarios are expensive on the real CLI). */
export function scenarioCache(target: Target, overrides: Record<string, RunOptions> = {}) {
  const cache = new Map<string, Promise<ScenarioResult>>()
  return (scenario: string) => {
    let hit = cache.get(scenario)
    if (!hit) {
      hit = runScenario(target, scenario, overrides[scenario])
      // Keep an early failure from becoming an unhandled rejection before a test awaits it.
      hit.catch(() => {})
      cache.set(scenario, hit)
    }
    return hit
  }
}

// ── accessors for fact assertions ────────────────────────────────────────────

/** Labelled SDK messages of one session, in arrival order. */
export function messagesOf(result: ScenarioResult, session: string): any[] {
  return result.events.filter((e) => e.k === 'msg' && e.s === session).map((e) => relabel(result, e.m))
}

/** Labelled trace events of one session (messages and harness events). */
export function eventsOf(result: ScenarioResult, session: string): TraceEvent[] {
  return result.events.filter((e) => e.s === session).map((e) => relabel(result, e))
}

/** Index of the first event in `events` matching `predicate`, or -1. */
export function indexOf(events: TraceEvent[], predicate: (e: TraceEvent) => boolean): number {
  return events.findIndex(predicate)
}

export const isMsg = (predicate: (m: any) => boolean) => (e: TraceEvent) => e.k === 'msg' && predicate(e.m)
