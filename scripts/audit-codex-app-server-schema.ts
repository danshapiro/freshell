import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_RUNTIME_LEAF_VALUES,
  CODEX_SCHEMA_VERSION,
  CODEX_SERVER_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_VARIANTS,
} from '../test/fixtures/coding-cli/codex-app-server/schema-inventory.js'

type JsonSchema = {
  oneOf?: Array<{ properties?: { method?: { enum?: string[] }; type?: { const?: string; enum?: string[] } } }>
  definitions?: Record<string, JsonSchema & { enum?: string[] }>
  enum?: string[]
}

function readSchema(filePath: string): JsonSchema {
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonSchema
}

function methods(filePath: string): string[] {
  return (readSchema(filePath).oneOf ?? [])
    .map((entry) => entry.properties?.method?.enum?.[0])
    .filter((value): value is string => Boolean(value))
}

function threadItemVariants(filePath: string): string[] {
  const schema = readSchema(filePath).definitions?.ThreadItem
  return (schema?.oneOf ?? [])
    .map((entry) => entry.properties?.type?.const ?? entry.properties?.type?.enum?.[0])
    .filter((value): value is string => Boolean(value))
}

function compare(label: string, expected: readonly string[], actual: readonly string[]): string[] {
  const missing = expected.filter((value) => !actual.includes(value))
  const added = actual.filter((value) => !expected.includes(value))
  const messages: string[] = []
  if (missing.length > 0) messages.push(`${label} missing from generated schema: ${missing.join(', ')}`)
  if (added.length > 0) messages.push(`${label} added by generated schema: ${added.join(', ')}`)
  return messages
}

const workDir = mkdtempSync(path.join(tmpdir(), 'freshell-codex-schema-audit-'))
try {
  const jsonDir = path.join(workDir, 'json')
  execFileSync('codex', ['app-server', 'generate-json-schema', '--out', jsonDir], { stdio: 'inherit' })

  const failures = [
    ...compare('client request methods', CODEX_CLIENT_REQUEST_METHODS, methods(path.join(jsonDir, 'ClientRequest.json'))),
    ...compare('server request methods', CODEX_SERVER_REQUEST_METHODS, methods(path.join(jsonDir, 'ServerRequest.json'))),
    ...compare('server notification methods', CODEX_SERVER_NOTIFICATION_METHODS, methods(path.join(jsonDir, 'ServerNotification.json'))),
    ...compare('thread item variants', CODEX_THREAD_ITEM_VARIANTS, threadItemVariants(path.join(jsonDir, 'codex_app_server_protocol.v2.schemas.json'))),
  ]

  const v2Schema = readSchema(path.join(jsonDir, 'codex_app_server_protocol.v2.schemas.json'))
  const generatedReasoningEffort = v2Schema.definitions?.ReasoningEffort?.enum ?? []
  failures.push(...compare('reasoning effort values', CODEX_RUNTIME_LEAF_VALUES.reasoningEffort, generatedReasoningEffort))

  if (failures.length > 0) {
    console.error(`Codex app-server schema inventory is stale. Checked-in inventory version: ${CODEX_SCHEMA_VERSION}`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exit(1)
  }

  console.log(`Codex app-server schema inventory matches checked-in ${CODEX_SCHEMA_VERSION} fixture.`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
