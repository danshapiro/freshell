import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { runProviderParityFixture } from '../../test/integration/server/provider-parity-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const target = process.env.FRESHELL_RUNTIME_PROVIDER_PARITY_LOCAL_RECEIPT
if (!target) throw new Error('FRESHELL_RUNTIME_PROVIDER_PARITY_LOCAL_RECEIPT is required')
const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const receipt = await runProviderParityFixture(repoRoot, target.replace(/\.json$/, '-events.jsonl'))
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
fs.writeFileSync(target, JSON.stringify({ ...receipt, candidateSha }), { flag: 'wx', mode: 0o600 })
