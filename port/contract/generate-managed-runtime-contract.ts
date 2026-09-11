/** Generate the language-neutral Phase 4 managed-runtime REST/projection contract. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import * as managedRuntime from '../../shared/managed-runtime.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const MANAGED_RUNTIME_SCHEMA_PATH = path.join(__dirname, 'managed-runtime.schema.json')

type JsonSchema = Record<string, unknown>

function isZodSchema(value: unknown): value is z.ZodType {
  return Boolean(value && typeof value === 'object' && typeof (value as { safeParse?: unknown }).safeParse === 'function')
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeysDeep(child)]),
    )
  }
  return value
}

export function serializeManagedRuntimeContract(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`
}

export function buildManagedRuntimeContract(): Record<string, unknown> {
  const schemas = Object.fromEntries(
    Object.entries(managedRuntime)
      .filter((entry): entry is [string, z.ZodType] => isZodSchema(entry[1]))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  )
  return {
    title: 'Freshell managed runtime Phase 4 contract',
    description: 'Generated from shared/managed-runtime.ts. Do not edit by hand.',
    source: 'shared/managed-runtime.ts',
    generator: 'port/contract/generate-managed-runtime-contract.ts',
    schemaCount: Object.keys(schemas).length,
    schemas,
  }
}

export function writeManagedRuntimeContract(): void {
  writeFileSync(MANAGED_RUNTIME_SCHEMA_PATH, serializeManagedRuntimeContract(buildManagedRuntimeContract()))
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked === __filename || import.meta.url === pathToFileURL(invoked).href) {
  writeManagedRuntimeContract()
  console.log(`Wrote ${MANAGED_RUNTIME_SCHEMA_PATH}`)
}
