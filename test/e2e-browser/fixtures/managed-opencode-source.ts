import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// This is the pinned v1.18.21 migration registry, not a copy of a user store.
// A changed provider schema must update the fixture and its importer together.
const MIGRATIONS = [
  '20260127222353_familiar_lady_ursula',
  '20260211171708_add_project_commands',
  '20260213144116_wakeful_the_professor',
  '20260225215848_workspace',
  '20260227213759_add_session_workspace_id',
  '20260228203230_blue_harpoon',
  '20260303231226_add_workspace_fields',
  '20260309230000_move_org_to_state',
  '20260312043431_session_message_cursor',
  '20260323234822_events',
  '20260410174513_workspace-name',
  '20260413175956_chief_energizer',
  '20260423070820_add_icon_url_override',
  '20260427172553_slow_nightmare',
  '20260428004200_add_session_path',
  '20260501142318_next_venus',
  '20260504145000_add_sync_owner',
  '20260507164347_add_workspace_time',
  '20260510033149_session_usage',
  '20260511000411_data_migration_state',
  '20260511173437_session-metadata',
  '20260601010001_normalize_storage_paths',
  '20260601202201_amazing_prowler',
  '20260602002951_lowly_union_jack',
  '20260602182828_add_project_directories',
  '20260603001617_session_message_projection_indexes',
  '20260603040000_session_message_projection_order',
  '20260603141458_session_input_inbox',
  '20260603160727_jittery_ezekiel_stane',
  '20260604172448_event_sourced_session_input',
  '20260605003541_add_session_context_snapshot',
  '20260605042240_add_context_epoch_agent',
  '20260611035744_credential',
  '20260611192811_lush_chimera',
  '20260612174303_project_dir_strategy',
  '20260622142730_simplify_session_context_epoch',
  '20260622170816_reset_v2_session_state',
  '20260622202450_simplify_session_input',
] as const

export const EXCLUDED_SOURCE_SENTINELS = [
  'UNRELATED_SESSION_SENTINEL',
  'UNRELATED_MESSAGE_SENTINEL',
  'ACCOUNT_TOKEN_SENTINEL',
  'ACCOUNT_REFRESH_SENTINEL',
  'CONTROL_ACCOUNT_SENTINEL',
  'CREDENTIAL_VALUE_SENTINEL',
  'PROVIDER_CONFIG_SENTINEL',
] as const

export type SyntheticSource = {
  databasePath: string
  rootId: string
  childId: string
  grandchildId: string
  unrelatedId: string
  baselineMessages: ReadonlyMap<string, string>
  baselineParts: ReadonlyMap<string, string>
  lastMessageId: string
  selectedSentinel: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

export function seedManagedOpenCodeSource(input: {
  repoRoot: string
  databasePath: string
  workspace: string
  nonce: string
  messageCount?: number
}): SyntheticSource {
  const { repoRoot, databasePath, workspace, nonce } = input
  const messageCount = input.messageCount ?? 106
  if (!Number.isInteger(messageCount) || messageCount < 2 || messageCount % 2 !== 0) {
    throw new Error('synthetic OpenCode message count must be an even integer of at least two')
  }
  const nativeIdNonce = sha256(nonce).slice(0, 16)
  const nativeId = (prefix: string, index: number): string =>
    `${prefix}_${nativeIdNonce}${String(index).padStart(10, '0')}`
  const rootId = nativeId('ses', 0)
  const childId = nativeId('ses', 1)
  const grandchildId = nativeId('ses', 2)
  const unrelatedId = nativeId('ses', 3)
  // Project IDs are not prefixed IDs: v1.18.21 derives them from a remote URL
  // with Hash.fast(`git-remote:${normalizedRemote}`).
  const projectId = sha1('git-remote:fixture.invalid/freshell/managed-opencode')
  const selectedSentinel = `SELECTED_HISTORY_${nonce}`
  const baselineMessages = new Map<string, string>()
  const baselineParts = new Map<string, string>()
  const now = Date.now() - 600_000

  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    db.exec(fs.readFileSync(path.join(repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql'), 'utf8'))
    db.exec('CREATE TABLE message_seq (session_id TEXT PRIMARY KEY, next INTEGER NOT NULL); CREATE TABLE provider_config (id TEXT PRIMARY KEY, value TEXT);')
    const insertMigration = db.prepare('INSERT INTO migration (id, time_completed) VALUES (?, ?)')
    MIGRATIONS.forEach((migration, index) => insertMigration.run(migration, index + 100))
    db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, workspace, now, now, '[]')
    db.prepare('INSERT INTO project_directory (project_id, directory, time_created) VALUES (?, ?, ?)')
      .run(projectId, workspace, now)
    db.prepare('INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nativeId('per', 0), projectId, 'read', '*', now, now)

    const insertSession = db.prepare(`INSERT INTO session
      (id, project_id, workspace_id, parent_id, slug, directory, title, version,
       time_created, time_updated, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, '1.18.21', ?, ?, ?)`)
    for (const [id, parent, title, offset] of [
      [rootId, null, `Synthetic managed OpenCode ${nonce}`, 0],
      [childId, rootId, `Synthetic child ${nonce}`, 1],
      [grandchildId, childId, `Synthetic grandchild ${nonce}`, 2],
      [unrelatedId, null, 'UNRELATED_SESSION_SENTINEL', 3],
    ] as const) {
      // These are ordinary local sessions. OpenCode 1.18.21 rejects prompts
      // attached to a workspace adapter that is not enabled in the TUI.
      insertSession.run(id, projectId, null, parent, id, workspace, title, now + offset, now + offset, JSON.stringify({ opaque: 'OPAQUE_ROW_SENTINEL' }))
    }

    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    const tokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    let lastMessageId = ''
    for (let index = 0; index < messageCount; index++) {
      const id = nativeId('msg', index)
      const time = now + 100 + index
      const assistant = index % 2 === 1
      const data = JSON.stringify(assistant
        ? {
          role: 'assistant',
          parentID: nativeId('msg', index - 1),
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          mode: 'build',
          agent: 'build',
          path: { cwd: workspace, root: workspace },
          cost: 0,
          tokens,
          finish: 'stop',
          time: { created: time, completed: time },
        }
        : {
          role: 'user',
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
          time: { created: time },
        })
      const part = JSON.stringify({ type: 'text', text: `${selectedSentinel}_${index}` })
      insertMessage.run(id, rootId, time, time, data)
      if (assistant) {
        const startId = nativeId('prt', index * 3)
        insertPart.run(startId, id, rootId, time, time, JSON.stringify({ type: 'step-start' }))
        baselineParts.set(startId, sha256(JSON.stringify({ type: 'step-start' })))
      }
      const textId = nativeId('prt', index * 3 + 1)
      insertPart.run(textId, id, rootId, time, time, part)
      baselineMessages.set(id, sha256(data))
      baselineParts.set(textId, sha256(part))
      if (assistant) {
        const finish = JSON.stringify({ type: 'step-finish', reason: 'stop', cost: 0, tokens })
        const finishId = nativeId('prt', index * 3 + 2)
        insertPart.run(finishId, id, rootId, time, time, finish)
        baselineParts.set(finishId, sha256(finish))
      }
      lastMessageId = id
    }
    for (const [messageIndex, id, label] of [
      [messageCount, childId, 'CHILD_HISTORY_SENTINEL'],
      [messageCount + 1, grandchildId, 'GRANDCHILD_HISTORY_SENTINEL'],
      [messageCount + 2, unrelatedId, 'UNRELATED_MESSAGE_SENTINEL'],
    ] as const) {
      const messageId = nativeId('msg', messageIndex)
      const partId = nativeId('prt', messageIndex * 3 + 1)
      const data = JSON.stringify({
        role: 'user',
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
        time: { created: now + 500 },
      })
      const part = JSON.stringify({ type: 'text', text: label })
      insertMessage.run(messageId, id, now + 500, now + 500, data)
      insertPart.run(partId, messageId, id, now + 500, now + 500, part)
      if (id !== unrelatedId) {
        baselineMessages.set(messageId, sha256(data))
        baselineParts.set(partId, sha256(part))
      }
    }
    db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, 1, ?)').run(rootId, `owner_${nonce}`)
    const rootInfo = {
      id: rootId,
      slug: rootId,
      projectID: projectId,
      directory: workspace,
      title: `Synthetic managed OpenCode ${nonce}`,
      version: '1.18.21',
      time: { created: now, updated: now },
    }
    db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, 1, ?, ?)')
      .run(nativeId('evt', 0), rootId, 'session.created.1', JSON.stringify({ sessionID: rootId, info: rootInfo }))
    db.prepare('INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES (?, ?, ?, 1)')
      .run(rootId, 'baseline', JSON.stringify({ opaque: 'CONTEXT_SENTINEL' }))
    db.prepare('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(rootId, 'synthetic todo', 'pending', 'high', now + 503, now + 503)
    db.prepare('INSERT INTO message_seq (session_id, next) VALUES (?, ?)').run(rootId, messageCount + 1)
    db.prepare('INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`account_${nonce}`, 'synthetic@example.invalid', 'https://example.invalid', 'ACCOUNT_TOKEN_SENTINEL', 'ACCOUNT_REFRESH_SENTINEL', now, now)
    db.prepare('INSERT INTO control_account (email, url, access_token, refresh_token, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run('synthetic@example.invalid', 'https://example.invalid', 'CONTROL_ACCOUNT_SENTINEL', 'CONTROL_REFRESH_SENTINEL', now, now)
    db.prepare('INSERT INTO credential (id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
      .run(nativeId('cred', 0), 'synthetic', 'CREDENTIAL_VALUE_SENTINEL', now, now)
    db.prepare('INSERT INTO provider_config (id, value) VALUES (?, ?)').run(`provider_${nonce}`, 'PROVIDER_CONFIG_SENTINEL')
    return { databasePath, rootId, childId, grandchildId, unrelatedId, baselineMessages, baselineParts, lastMessageId, selectedSentinel }
  } finally {
    db.close()
  }
}
