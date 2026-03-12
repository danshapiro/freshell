import fs from 'fs/promises'
import path from 'path'

const PROJECT_COUNT = 12
const SESSIONS_PER_PROJECT = 15
const ALPHA_SESSION_COUNT = 36
const LONG_HISTORY_TURN_COUNT = 240
const LONG_HISTORY_PROJECT_INDEX = 11
const BASE_TIMESTAMP_MS = Date.parse('2026-03-10T08:00:00.000Z')

export const VISIBLE_FIRST_LONG_HISTORY_SESSION_ID = '00000000-0000-4000-8000-000000000241'
export const VISIBLE_FIRST_LONG_HISTORY_PROJECT_PATH = '/tmp/freshell-visible-first/project-12'

export type VisibleFirstAuditHomeSeedResult = {
  projectCount: number
  sessionCount: number
  alphaSessionCount: number
  longHistorySessionId: string
  longHistoryTurnCount: number
  backlogScriptPath: string
  claudeProjectsDir: string
  projectPaths: string[]
}

function makeSessionId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function makeTimestamp(offsetSeconds: number): string {
  return new Date(BASE_TIMESTAMP_MS + offsetSeconds * 1000).toISOString()
}

function buildSessionJsonl(input: {
  sessionId: string
  cwd: string
  title: string
  summary: string
  turnCount?: number
  longBody?: boolean
  startOffsetSeconds: number
}): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: input.sessionId,
      uuid: `${input.sessionId}-system`,
      timestamp: makeTimestamp(input.startOffsetSeconds),
      cwd: input.cwd,
      git: {
        branch: 'main',
        dirty: false,
      },
    }),
  ]

  const turns = input.turnCount ?? 2
  let previousUuid = `${input.sessionId}-system`

  for (let turnIndex = 0; turnIndex < turns; turnIndex += 1) {
    const userUuid = `${input.sessionId}-user-${turnIndex + 1}`
    const assistantUuid = `${input.sessionId}-assistant-${turnIndex + 1}`
    const userBody = input.longBody
      ? `${input.title} older context block ${turnIndex + 1}. ${'Deterministic history. '.repeat(6)}`.trim()
      : `${input.title} request ${turnIndex + 1}`
    const assistantBody = input.longBody
      ? `${input.summary} reply ${turnIndex + 1}. ${'Stable assistant output. '.repeat(5)}`.trim()
      : `${input.summary} reply ${turnIndex + 1}`

    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: {
        role: 'user',
        content: userBody,
      },
      uuid: userUuid,
      timestamp: makeTimestamp(input.startOffsetSeconds + turnIndex * 2 + 1),
      summary: turnIndex === 0 ? input.summary : undefined,
    }))

    lines.push(JSON.stringify({
      parentUuid: userUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [
          {
            type: 'text',
            text: assistantBody,
          },
        ],
        usage: {
          input_tokens: 100 + turnIndex,
          output_tokens: 40 + turnIndex,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: assistantUuid,
      timestamp: makeTimestamp(input.startOffsetSeconds + turnIndex * 2 + 2),
    }))

    previousUuid = assistantUuid
  }

  lines.push(JSON.stringify({
    type: 'summary',
    summary: input.summary,
    leafUuid: previousUuid,
  }))

  return `${lines.join('\n')}\n`
}

function buildBacklogScript(): string {
  return `const totalLines = 1200;
for (let index = 1; index <= totalLines; index += 1) {
  process.stdout.write(\`backlog line \${String(index).padStart(4, '0')}\\n\`);
}
setTimeout(() => {
  process.stdout.write('tail line 0001\\n');
  process.stdout.write('tail line 0002\\n');
}, 150);
setTimeout(() => process.exit(0), 225);
`
}

async function writeSessionFile(filePath: string, content: string, mtimeMs: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  const date = new Date(mtimeMs)
  await fs.utimes(filePath, date, date)
}

export async function seedVisibleFirstAuditServerHome(homeDir: string): Promise<VisibleFirstAuditHomeSeedResult> {
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects')
  await fs.mkdir(claudeProjectsDir, { recursive: true })

  const projectPaths: string[] = []
  let sessionSequence = 1
  let alphaSessionsRemaining = ALPHA_SESSION_COUNT

  for (let projectIndex = 0; projectIndex < PROJECT_COUNT; projectIndex += 1) {
    const projectSlug = `project-${String(projectIndex + 1).padStart(2, '0')}`
    const projectDir = path.join(claudeProjectsDir, projectSlug)
    const projectPath = `/tmp/freshell-visible-first/${projectSlug}`
    projectPaths.push(projectPath)
    await fs.mkdir(projectDir, { recursive: true })

    for (let sessionIndex = 0; sessionIndex < SESSIONS_PER_PROJECT; sessionIndex += 1) {
      const sessionId = makeSessionId(sessionSequence)
      const includeAlpha = alphaSessionsRemaining > 0 && sessionIndex < 3
      if (includeAlpha) {
        alphaSessionsRemaining -= 1
      }
      const title = includeAlpha
        ? `alpha search session ${projectIndex + 1}-${sessionIndex + 1}`
        : `deterministic session ${projectIndex + 1}-${sessionIndex + 1}`
      const summary = includeAlpha
        ? `alpha summary ${projectIndex + 1}-${sessionIndex + 1}`
        : `summary ${projectIndex + 1}-${sessionIndex + 1}`
      const sessionPath = path.join(projectDir, `${sessionId}.jsonl`)

      await writeSessionFile(
        sessionPath,
        buildSessionJsonl({
          sessionId,
          cwd: projectPath,
          title,
          summary,
          startOffsetSeconds: sessionSequence * 10,
        }),
        BASE_TIMESTAMP_MS + sessionSequence * 60_000,
      )

      sessionSequence += 1
    }
  }

  const longHistoryProjectDir = path.join(
    claudeProjectsDir,
    `project-${String(LONG_HISTORY_PROJECT_INDEX + 1).padStart(2, '0')}`,
  )
  await writeSessionFile(
    path.join(longHistoryProjectDir, `${VISIBLE_FIRST_LONG_HISTORY_SESSION_ID}.jsonl`),
    buildSessionJsonl({
      sessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
      cwd: VISIBLE_FIRST_LONG_HISTORY_PROJECT_PATH,
      title: 'visible first long history session',
      summary: 'long history summary',
      turnCount: LONG_HISTORY_TURN_COUNT,
      longBody: true,
      startOffsetSeconds: 9_999,
    }),
    BASE_TIMESTAMP_MS + 9_999 * 60_000,
  )

  const backlogScriptPath = path.join(homeDir, 'audit-terminal-backlog.js')
  await fs.writeFile(backlogScriptPath, buildBacklogScript(), 'utf8')

  return {
    projectCount: PROJECT_COUNT,
    sessionCount: PROJECT_COUNT * SESSIONS_PER_PROJECT,
    alphaSessionCount: ALPHA_SESSION_COUNT,
    longHistorySessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
    longHistoryTurnCount: LONG_HISTORY_TURN_COUNT,
    backlogScriptPath,
    claudeProjectsDir,
    projectPaths,
  }
}
