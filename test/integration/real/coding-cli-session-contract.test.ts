// @vitest-environment node
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CodexRpcProbeClient,
  ProbeWorkspace,
  captureCodexBootstrapEvents,
  findClaudeTranscript,
  findClaudeTranscripts,
  loadCodingCliSessionContractNote,
  queryOpencodeSessionRow,
  readClaudeTranscriptLines,
  readCodingCliSessionContractMarkdown,
  resolveProviderBinaries,
  seedClaudeHome,
  seedCodexHome,
  seedOpencodeHomes,
  startCodexAppServer,
  startOpencodeServe,
  waitForCodexSessionArtifact,
  waitForAnyHttpBusyStatus,
  waitForJsonResponse,
  waitForJsonLine,
  waitForOpencodeDbSession,
} from '../../helpers/coding-cli/real-session-contract-harness.js'

const note = await loadCodingCliSessionContractNote()
const noteMarkdown = await readCodingCliSessionContractMarkdown()
const providerBinaries = await resolveProviderBinaries(['codex', 'claude', 'opencode'] as const)

const codexBinary = providerBinaries.codex
const claudeBinary = providerBinaries.claude
const opencodeBinary = providerBinaries.opencode

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

type ProviderProbeAvailability = {
  ready: boolean
  reason?: string
}

function binaryAvailability(binary: { executable: string; resolvedPath: string | null }): ProviderProbeAvailability {
  if (!binary.resolvedPath) {
    return {
      ready: false,
      reason: `Skipping ${binary.executable} real-provider contracts: ${binary.executable} is not on PATH.`,
    }
  }
  return { ready: true }
}

async function codexAvailability(): Promise<ProviderProbeAvailability> {
  const binary = binaryAvailability(codexBinary)
  if (!binary.ready) return binary

  const missing = []
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'auth.json')))) missing.push('~/.codex/auth.json')
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'config.toml')))) missing.push('~/.codex/config.toml')
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Skipping Codex real-provider contracts: missing ${missing.join(' and ')}.`,
    }
  }
  return { ready: true }
}

async function claudeAvailability(): Promise<ProviderProbeAvailability> {
  const binary = binaryAvailability(claudeBinary)
  if (!binary.ready) return binary

  if (!(await pathExists(path.join(os.homedir(), '.claude', '.credentials.json')))) {
    return {
      ready: false,
      reason: 'Skipping Claude real-provider contracts: missing ~/.claude/.credentials.json.',
    }
  }
  return { ready: true }
}

function opencodeAvailability(): ProviderProbeAvailability {
  return binaryAvailability(opencodeBinary)
}

function requireAvailableBinary(
  binary: { executable: string; resolvedPath: string | null },
  availability: ProviderProbeAvailability,
): string {
  if (!availability.ready || !binary.resolvedPath) {
    throw new Error(availability.reason ?? `Skipping ${binary.executable} real-provider contracts.`)
  }
  return binary.resolvedPath
}

function expectLocalBinary(binary: { executable: string; resolvedPath: string | null; version: string | null }): void {
  expect(binary.resolvedPath).toEqual(expect.any(String))
  expect(binary.version).toEqual(expect.any(String))
}

function expectOrderedSubsequence(actual: string[], expected: string[]): void {
  let cursor = 0
  for (const method of actual) {
    if (method === expected[cursor]) {
      cursor += 1
      if (cursor === expected.length) return
    }
  }
  throw new Error(`Expected methods ${JSON.stringify(expected)} in order within ${JSON.stringify(actual)}.`)
}

function claudeAuthFailed(stdout: string, stderr: string): boolean {
  return `${stdout}\n${stderr}`.includes('Failed to authenticate')
    || `${stdout}\n${stderr}`.includes('Invalid authentication credentials')
}

function expectClaudeSuccessOrAuthFailure(input: {
  code: number | null
  stdout: string
  stderr: string
  expectedStdout: string
}): void {
  if (input.code === 0) {
    expect(input.stdout.trim()).toBe(input.expectedStdout)
    return
  }
  expect(claudeAuthFailed(input.stdout, input.stderr)).toBe(true)
}

const codexProbe = await codexAvailability()
const claudeProbe = await claudeAvailability()
const opencodeProbe = opencodeAvailability()
const itWithProcOwnership = process.platform === 'linux' ? it : it.skip

describe.sequential('coding cli real provider session contract', () => {
  it('loads the checked-in lab note facts and date rationale', async () => {
    expect(note.capturedOn).toBe('2026-04-26')
    expect(note.planCreatedOn).toBe('2026-04-19')
    expect(note.dateReason).toContain('2026-04-26')
    expect(note.dateReason).toContain('2026-04-19')
    expect(noteMarkdown).toContain('The implementation plan file is dated `2026-04-19`')
    expect(note.cleanup.ownershipReportFields).toEqual([
      'pid',
      'ppid',
      'cwd',
      'tempHome',
      'sentinelPath',
      'safeToStop',
      'command',
    ])
  }, 30_000)

  itWithProcOwnership('emits provenance-gated ownership reports before cleanup', async () => {
    const workspace = await ProbeWorkspace.create('cleanup-audit')
    try {
      const sleeper = await workspace.spawnProcess('bash', ['-lc', 'sleep 30'])
      expect(sleeper.pid).toBeGreaterThan(0)

      const report = await workspace.buildOwnershipReport()
      expect(report.length).toBeGreaterThan(0)
      expect(report[0]).toEqual(expect.objectContaining({
        pid: expect.any(Number),
        ppid: expect.any(Number),
        cwd: expect.any(String),
        tempHome: workspace.tempRoot,
        sentinelPath: workspace.sentinelPath,
        safeToStop: true,
        command: expect.any(String),
      }))
    } finally {
      await workspace.cleanup().catch(() => undefined)
    }
  }, 30_000)

  const describeCodex = codexProbe.ready ? describe.sequential : describe.skip
  describeCodex(`codex${codexProbe.ready ? '' : ` (${codexProbe.reason})`}`, () => {
    it('detects a local binary and uses the expected remote bootstrap forms', async () => {
      const codexPath = requireAvailableBinary(codexBinary, codexProbe)
      expectLocalBinary(codexBinary)

      const workspace = await ProbeWorkspace.create('codex-bootstrap')
      try {
        await seedCodexHome(workspace)
        const freshEvents = await captureCodexBootstrapEvents(workspace, codexPath)
        if (freshEvents.length > 0) {
          expectOrderedSubsequence(freshEvents, [
            'connection',
            'initialize',
            'initialized',
          ])
          if (freshEvents.includes('model/list')) {
            expectOrderedSubsequence(freshEvents, ['initialized', 'model/list'])
          }
          expect(freshEvents).toContain('account/read')
        }
      } finally {
        await workspace.cleanup().catch(() => undefined)
      }
    }, 60_000)

    it('surfaces the exact rollout path before it exists and materializes the artifact there', async () => {
      const codexPath = requireAvailableBinary(codexBinary, codexProbe)
      const workspace = await ProbeWorkspace.create('codex-rollout-watch')
      const rolloutWatchId = 'probe-rollout-path'
      const parentWatchId = 'probe-rollout-parent'

      try {
        await seedCodexHome(workspace)

        const appServer = await startCodexAppServer(workspace, codexPath)
        const client = await CodexRpcProbeClient.connect(appServer.wsUrl)
        await client.initialize()

        const start = await client.startThread(process.cwd())
        expect(start.thread.ephemeral).toBe(false)
        expect(start.thread.path).toMatch(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.+\.jsonl$/)

        const rolloutPath = start.thread.path as string
        const rolloutParent = path.dirname(rolloutPath)
        expect(await fsp.access(rolloutPath).then(() => true, () => false)).toBe(false)
        expect(await fsp.access(rolloutParent).then(() => true, () => false)).toBe(false)

        expect(await client.fsWatch(rolloutPath, rolloutWatchId)).toEqual({ path: rolloutPath })
        expect(await client.fsWatch(rolloutParent, parentWatchId)).toEqual({ path: rolloutParent })

        await client.startTurn(start.thread.id, 'Reply with exactly: codex-watch-probe')
        await client.waitForNotification(
          'turn/completed',
          (notification) => notification.params?.threadId === start.thread.id,
          120_000,
        )

        const artifactPath = await waitForCodexSessionArtifact(workspace)
        expect(artifactPath).toBe(rolloutPath)

        if (note.providers.codex.appServerChangedPathsMentionRolloutPath) {
          const changed = await client.waitForNotification(
            'fs/changed',
            (notification) => (
              Array.isArray(notification.params?.changedPaths)
              && notification.params.changedPaths.includes(rolloutPath)
              && [rolloutWatchId, parentWatchId].includes(notification.params?.watchId)
            ),
            120_000,
          )
          expect(changed.params.watchId).toBeOneOf([rolloutWatchId, parentWatchId])
        }

        await client.fsUnwatch(rolloutWatchId)
        await client.fsUnwatch(parentWatchId)
        await client.close()
        await appServer.process.stop()
      } finally {
        await workspace.cleanup().catch(() => undefined)
      }
    }, 180_000)

  })

  const describeClaude = claudeProbe.ready ? describe.sequential : describe.skip
  describeClaude(`claude${claudeProbe.ready ? '' : ` (${claudeProbe.reason})`}`, () => {
    it('detects a local binary and version', async () => {
      requireAvailableBinary(claudeBinary, claudeProbe)
      expectLocalBinary(claudeBinary)
    }, 30_000)

    it('creates UUID-backed transcripts and, when authenticated, treats names as mutable metadata only', async () => {
      const claudePath = requireAvailableBinary(claudeBinary, claudeProbe)
      const workspace = await ProbeWorkspace.create('claude-contract')
      const exactSessionId = '44444444-4444-4444-8444-444444444444'
      const namedSessionId = '55555555-5555-4555-8555-555555555555'
      try {
        await seedClaudeHome(workspace)

        const exactCreate = await workspace.spawnProcess(
          claudePath,
          [
            '--dangerously-skip-permissions',
            '-p',
            '--session-id',
            exactSessionId,
            'Reply with exactly: claude-home-probe-ok',
          ],
          {
            env: {
              HOME: workspace.tempRoot,
            },
          },
        )
        const exactExit = await exactCreate.waitForExit(60_000)
        expectClaudeSuccessOrAuthFailure({
          code: exactExit.code,
          stdout: exactCreate.stdout(),
          stderr: exactCreate.stderr(),
          expectedStdout: 'claude-home-probe-ok',
        })

          const exactTranscript = await findClaudeTranscript(workspace, exactSessionId)
          expect(path.relative(workspace.inTemp('.claude'), exactTranscript)).toMatch(
            /^projects\/.+\/44444444-4444-4444-8444-444444444444\.jsonl$/,
          )

          if (exactExit.code !== 0) {
            return
          }

          const namedCreate = await workspace.spawnProcess(
            claudePath,
            [
              '--dangerously-skip-permissions',
              '-p',
              '--session-id',
              namedSessionId,
              '--name',
              'probe-name-one',
              'Reply with exactly: named-create-ok',
            ],
            {
              env: {
                HOME: workspace.tempRoot,
              },
            },
          )
          expect((await namedCreate.waitForExit(60_000)).code).toBe(0)
          expect(namedCreate.stdout().trim()).toBe('named-create-ok')

          const namedResume = await workspace.spawnProcess(
            claudePath,
            [
              '--dangerously-skip-permissions',
              '-p',
              '--resume',
              'probe-name-one',
              'Reply with exactly: named-resume-ok',
            ],
            {
              env: {
                HOME: workspace.tempRoot,
              },
            },
          )
          expect((await namedResume.waitForExit(60_000)).code).toBe(0)
          expect(namedResume.stdout().trim()).toBe('named-resume-ok')

          const rename = await workspace.spawnProcess(
            claudePath,
            [
              '--dangerously-skip-permissions',
              '-p',
              '--resume',
              namedSessionId,
              '--name',
              'probe-name-two',
              'Reply with exactly: renamed-ok',
            ],
            {
              env: {
                HOME: workspace.tempRoot,
              },
            },
          )
          expect((await rename.waitForExit(60_000)).code).toBe(0)
          expect(rename.stdout().trim()).toBe('renamed-ok')

          const transcriptPath = await findClaudeTranscript(workspace, namedSessionId)
          const transcriptLines = await readClaudeTranscriptLines(transcriptPath)
          expect(transcriptLines.some((line) => line.includes('"customTitle":"probe-name-one"'))).toBe(true)
          expect(transcriptLines.some((line) => line.includes('"customTitle":"probe-name-two"'))).toBe(true)
          expect(transcriptLines.some((line) => line.includes('"agentName":"probe-name-one"'))).toBe(true)
          expect(transcriptLines.some((line) => line.includes('"agentName":"probe-name-two"'))).toBe(true)

          const oldTitleResume = await workspace.spawnProcess(
            claudePath,
            [
              '--dangerously-skip-permissions',
              '-p',
              '--resume',
              'probe-name-one',
              'Reply with exactly: should-not-run',
            ],
            {
              env: {
                HOME: workspace.tempRoot,
              },
            },
          )
          const oldTitleExit = await oldTitleResume.waitForExit(60_000)
          expect(oldTitleExit.code).not.toBe(0)
          expect(oldTitleResume.stderr()).toContain(note.providers.claude.oldTitleErrorFragment)

          const newTitleResume = await workspace.spawnProcess(
            claudePath,
            [
              '--dangerously-skip-permissions',
              '-p',
              '--resume',
              'probe-name-two',
              'Reply with exactly: renamed-title-ok',
            ],
            {
              env: {
                HOME: workspace.tempRoot,
              },
            },
          )
          expect((await newTitleResume.waitForExit(60_000)).code).toBe(0)
          expect(newTitleResume.stdout().trim()).toBe('renamed-title-ok')
      } finally {
        await workspace.cleanup().catch(() => undefined)
      }
    }, 180_000)

    it('treats --resume UUID lookup as scoped to the original cwd', async () => {
      const claudePath = requireAvailableBinary(claudeBinary, claudeProbe)
      const workspace = await ProbeWorkspace.create('claude-cwd-scope')
      const sessionId = '66666666-6666-4666-8666-666666666666'
      try {
        await seedClaudeHome(workspace)
        const cwdA = workspace.inTemp('project-a')
        const cwdB = workspace.inTemp('project-b')
        await fsp.mkdir(cwdA, { recursive: true })
        await fsp.mkdir(cwdB, { recursive: true })

        const create = await workspace.spawnProcess(
          claudePath,
          [
            '--dangerously-skip-permissions',
            '-p',
            '--session-id',
            sessionId,
            'Reply with exactly: claude-cwd-scope-create-ok',
          ],
          {
            cwd: cwdA,
            env: {
              HOME: workspace.tempRoot,
            },
          },
        )
        const createExit = await create.waitForExit(60_000)
        expectClaudeSuccessOrAuthFailure({
          code: createExit.code,
          stdout: create.stdout(),
          stderr: create.stderr(),
          expectedStdout: 'claude-cwd-scope-create-ok',
        })
        const transcript = await findClaudeTranscript(workspace, sessionId)
        expect(path.relative(workspace.inTemp('.claude'), transcript)).toContain('project-a')

        const sameCwdResume = await workspace.spawnProcess(
          claudePath,
          [
            '--dangerously-skip-permissions',
            '-p',
            '--resume',
            sessionId,
            'Reply with exactly: claude-cwd-scope-resume-ok',
          ],
          {
            cwd: cwdA,
            env: {
              HOME: workspace.tempRoot,
            },
          },
        )
        const sameCwdExit = await sameCwdResume.waitForExit(60_000)
        expect(`${sameCwdResume.stdout()}\n${sameCwdResume.stderr()}`).not.toContain('No conversation found with session ID')
        expectClaudeSuccessOrAuthFailure({
          code: sameCwdExit.code,
          stdout: sameCwdResume.stdout(),
          stderr: sameCwdResume.stderr(),
          expectedStdout: 'claude-cwd-scope-resume-ok',
        })

        const otherCwdResume = await workspace.spawnProcess(
          claudePath,
          [
            '--dangerously-skip-permissions',
            '-p',
            '--resume',
            sessionId,
            'Reply with exactly: should-not-run',
          ],
          {
            cwd: cwdB,
            env: {
              HOME: workspace.tempRoot,
            },
          },
        )
        const otherExit = await otherCwdResume.waitForExit(60_000)
        expect(otherExit.code).not.toBe(0)
        expect(otherCwdResume.stderr()).toContain('No conversation found with session ID')
      } finally {
        await workspace.cleanup().catch(() => undefined)
      }
    }, 180_000)

    it('rejects reusing one explicit session UUID across different cwd values', async () => {
      const claudePath = requireAvailableBinary(claudeBinary, claudeProbe)
      const workspace = await ProbeWorkspace.create('claude-session-id-unique')
      const sessionId = '77777777-7777-4777-8777-777777777777'
      try {
        await seedClaudeHome(workspace)
        const cwdA = workspace.inTemp('project-a')
        const cwdB = workspace.inTemp('project-b')
        await fsp.mkdir(cwdA, { recursive: true })
        await fsp.mkdir(cwdB, { recursive: true })

        const firstCreate = await workspace.spawnProcess(
          claudePath,
          [
            '--dangerously-skip-permissions',
            '-p',
            '--session-id',
            sessionId,
            'Reply with exactly: claude-duplicate-session-first-ok',
          ],
          {
            cwd: cwdA,
            env: {
              HOME: workspace.tempRoot,
            },
          },
        )
        const firstExit = await firstCreate.waitForExit(60_000)
        expectClaudeSuccessOrAuthFailure({
          code: firstExit.code,
          stdout: firstCreate.stdout(),
          stderr: firstCreate.stderr(),
          expectedStdout: 'claude-duplicate-session-first-ok',
        })
        const firstTranscript = await findClaudeTranscript(workspace, sessionId)
        expect(path.relative(workspace.inTemp('.claude'), firstTranscript)).toContain('project-a')

        const secondCreate = await workspace.spawnProcess(
          claudePath,
          [
            '--dangerously-skip-permissions',
            '-p',
            '--session-id',
            sessionId,
            'Reply with exactly: should-not-run',
          ],
          {
            cwd: cwdB,
            env: {
              HOME: workspace.tempRoot,
            },
          },
        )
        const secondExit = await secondCreate.waitForExit(60_000)
        const secondOutput = `${secondCreate.stdout()}\n${secondCreate.stderr()}`
        if (/already in use/i.test(secondOutput)) {
          expect(secondExit.code).not.toBe(0)
        } else {
          expectClaudeSuccessOrAuthFailure({
            code: secondExit.code,
            stdout: secondCreate.stdout(),
            stderr: secondCreate.stderr(),
            expectedStdout: 'should-not-run',
          })
          const transcripts = await findClaudeTranscripts(workspace, sessionId)
          expect(transcripts).toHaveLength(2)
          expect(transcripts.map((entry) => path.relative(workspace.inTemp('.claude'), entry))).toEqual(
            expect.arrayContaining([
              expect.stringContaining('project-a'),
              expect.stringContaining('project-b'),
            ]),
          )
        }
      } finally {
        await workspace.cleanup().catch(() => undefined)
      }
    }, 180_000)
  })

  const describeOpencode = opencodeProbe.ready ? describe.sequential : describe.skip
  describeOpencode(`opencode${opencodeProbe.ready ? '' : ` (${opencodeProbe.reason})`}`, () => {
    it('detects a local binary and version', async () => {
      requireAvailableBinary(opencodeBinary, opencodeProbe)
      expectLocalBinary(opencodeBinary)
    }, 30_000)

    it('uses session ids as canonical identity and does not let titles replace them', async () => {
      const opencodePath = requireAvailableBinary(opencodeBinary, opencodeProbe)
      const workspace = await ProbeWorkspace.create('opencode-contract')
      try {
        const homes = await seedOpencodeHomes(workspace)
        const runEnv = {
          XDG_DATA_HOME: homes.dataHome,
          XDG_CONFIG_HOME: homes.configHome,
        }

        const firstRun = await workspace.spawnProcess(
          opencodePath,
            [
              'run',
              'Reply with exactly: opencode-probe-ok',
              '--format',
              'json',
              '--dangerously-skip-permissions',
            ],
            {
              env: runEnv,
            },
          )

          const firstStepStart = await waitForJsonLine(firstRun, (value) => value?.type === 'step_start', 60_000)
          const firstSessionId = firstStepStart.sessionID as string
          expect(firstSessionId).toMatch(/^ses_/)
          const firstExit = await firstRun.waitForExit(60_000)
          expect(firstExit.code).toBe(0)

          const firstTextLine = JSON.parse(
            firstRun.stdout().split(/\r?\n/).find((line) => line.includes('"type":"text"')) ?? '{}',
          )
          expect(firstTextLine.part?.text).toBe('opencode-probe-ok')

          const firstDbRow = await waitForOpencodeDbSession(homes.dbPath, firstSessionId)
          expect(firstDbRow.id).toBe(firstSessionId)

          const { baseUrl, process: serve, health } = await startOpencodeServe(
            workspace,
            opencodePath,
            runEnv,
            note.providers.opencode.globalHealthPath,
          )

          const statusUrl = `${baseUrl}${note.providers.opencode.sessionStatusPath}`
          expect(health).toEqual({
            healthy: true,
            version: opencodeBinary.version,
          })
          expect(await waitForJsonResponse(statusUrl)).toEqual({})

        const attachedRun = await workspace.spawnProcess(
          opencodePath,
            [
              'run',
              'Write ten short sentences about terminal multiplexers. Do not use bullets.',
              '--format',
              'json',
              '--dangerously-skip-permissions',
              '--attach',
              baseUrl,
            ],
            {
              env: runEnv,
            },
          )

          const busyStatusPromise = waitForAnyHttpBusyStatus(statusUrl)
          const busyStatus = await busyStatusPromise
          expect(busyStatus.payload[busyStatus.sessionId]).toEqual({ type: 'busy' })
          const attachedDbRow = await waitForOpencodeDbSession(homes.dbPath, busyStatus.sessionId)
          expect(attachedDbRow.id).toBe(busyStatus.sessionId)
          expect((await attachedRun.waitForExit(120_000)).code).toBe(0)
          const attachedStdout = attachedRun.stdout().trim()
          if (note.providers.opencode.attachFormatJsonEmitsEvents) {
            expect(attachedStdout).not.toBe('')
            const attachedEventLines = attachedStdout
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
            expect(attachedEventLines.some((event) => event.sessionID === busyStatus.sessionId)).toBe(true)
          } else {
            expect(attachedStdout).toBe('')
          }

        const titledRun = await workspace.spawnProcess(
          opencodePath,
            [
              'run',
              'Reply with exactly: opencode-title-one',
              '--format',
              'json',
              '--dangerously-skip-permissions',
              '--title',
              'probe-title-one',
            ],
            {
              env: runEnv,
            },
          )
          const titledStepStart = await waitForJsonLine(titledRun, (value) => value?.type === 'step_start', 60_000)
          const titledSessionId = titledStepStart.sessionID as string
          expect((await titledRun.waitForExit(60_000)).code).toBe(0)

        const retitledRun = await workspace.spawnProcess(
          opencodePath,
            [
              'run',
              'Reply with exactly: opencode-title-two',
              '--format',
              'json',
              '--dangerously-skip-permissions',
              '--session',
              titledSessionId,
              '--title',
              'probe-title-two',
            ],
            {
              env: runEnv,
            },
          )
          const retitledStepStart = await waitForJsonLine(retitledRun, (value) => value?.type === 'step_start', 60_000)
          expect(retitledStepStart.sessionID).toBe(titledSessionId)
          expect((await retitledRun.waitForExit(60_000)).code).toBe(0)

          const titledDbRow = queryOpencodeSessionRow(homes.dbPath, titledSessionId)
          expect(titledDbRow?.title).toBe('probe-title-one')

        const sessionHelp = await workspace.spawnProcess(
          opencodePath,
            ['session', '--help'],
            {
              env: runEnv,
            },
          )
          expect((await sessionHelp.waitForExit(30_000)).code).toBe(0)
          const helpOutput = `${sessionHelp.stdout()}${sessionHelp.stderr()}`
          for (const subcommand of note.providers.opencode.sessionSubcommands) {
            expect(helpOutput).toContain(subcommand)
          }
          expect(helpOutput).not.toContain('rename')

        await serve.stop()
      } finally {
        await workspace.cleanup().catch(() => undefined)
      }
    }, 240_000)
  })
})
