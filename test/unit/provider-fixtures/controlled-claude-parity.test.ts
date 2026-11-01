import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

import { writeProviderParityEnvironment } from '../../helpers/provider-parity-environment.js'

const root = path.resolve(import.meta.dirname, '../../..')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

it.each(['startup', 'resume', 'refused'] as const)(
  'the copied Claude consumer executes selected hooks and native startup commands: %s', source => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-controlled-claude-'))
    try {
      const workspace = path.join(directory, 'workspace')
      const home = path.join(directory, 'home')
      const providerHome = path.join(home, '.claude')
      const signalDir = path.join(home, '.freshell/native-identity/owned-launch')
      const nativeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const launch = { incarnationId: 'owned-incarnation', launchNonce: 'owned-launch',
        evidenceRevision: 2, executionGeneration: 1, requestedNativeSessionId: nativeId }
      fs.mkdirSync(workspace, { recursive: true })
      writeProviderParityEnvironment(providerHome, 'plugins/parity-environment')
      fs.copyFileSync(path.join(root, 'test/fixtures/providers/parity-provider.mjs'),
        path.join(workspace, 'parity-provider.mjs'))
      const nativeCommand = path.join(workspace, 'native-session-channel.mjs')
      fs.copyFileSync(path.join(root, 'crates/freshell-claude-sidecar/native-session-channel.mjs'), nativeCommand)
      const receipt = path.join(directory, 'consumed.jsonl')
      const selectedCommand = path.join(workspace, 'selected-command.cjs')
      fs.writeFileSync(selectedCommand, `const fs=require('node:fs');let raw='';
process.stdin.on('data', chunk => raw+=chunk);
process.stdin.on('end', () => fs.appendFileSync(process.argv[2], JSON.stringify(JSON.parse(raw))+'\\n'));
`)
      const record = `${quote(process.execPath)} ${quote(selectedCommand)} ${quote(receipt)}`
      const native = `${quote(process.execPath)} ${quote(nativeCommand)}`
      const settings = { hooks: { SessionStart: [
        { matcher: '^clear$', hooks: [{ type: 'command', command: 'exit 31' }] },
        { hooks: [
          { type: 'command', command: source === 'refused' ? 'exit 23' : record },
          { type: 'command', command: native },
        ] },
      ] }, statusLine: { type: 'command', command: `${native} --status-line` } }
      const wrapper = path.join(workspace, 'parity-claude')
      fs.writeFileSync(wrapper, "import './parity-provider.mjs'\n")
      const result = spawnSync(process.execPath, [wrapper,
        source === 'resume' ? '--resume' : '--session-id', nativeId,
        '--settings', JSON.stringify(settings), '--model', 'selected-model'], {
        cwd: workspace, encoding: 'utf8', timeout: 8000, input: '',
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: providerHome, FRESHELL_URL: '', FRESHELL_TOKEN: '',
          FRESHELL_TERMINAL_ID: 'owned-terminal', FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR: signalDir,
          FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch),
          FRESHELL_NATIVE_STATUSLINE_SETTINGS: JSON.stringify({ type: 'command', command: record }) },
      })
      expect(result.error).toBeUndefined()
      const prefix = 'FRESHELL_PROVIDER_PARITY_ROW:'
      const rows = result.stdout.split('\n').filter(line => line.startsWith(prefix))
        .map(line => JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString('utf8')))
      if (source === 'refused') {
        expect(result.status).toBe(1)
        expect(rows).toContainEqual(expect.objectContaining({ kind: 'native-startup', result: 'refused' }))
        expect(rows.some(row => row.kind === 'startup')).toBe(false)
        expect(fs.existsSync(signalDir)).toBe(false)
        return
      }
      expect(result.status, result.stderr).toBe(0)
      const consumed = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(consumed).toHaveLength(2)
      expect(consumed[0]).toMatchObject({ hook_event_name: 'SessionStart', session_id: nativeId, source, cwd: workspace })
      expect(consumed[1]).toMatchObject({ session_id: nativeId, model: { id: 'selected-model' },
        workspace: { current_dir: workspace } })
      const start = JSON.parse(fs.readFileSync(path.join(signalDir, 'session-start.json'), 'utf8'))
      const loaded = JSON.parse(fs.readFileSync(path.join(signalDir, 'statusline-loaded.json'), 'utf8'))
      expect(start).toMatchObject({ launch, native: consumed[0] })
      expect(loaded).toMatchObject({ launch, native: consumed[1] })
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'startup', terminalId: 'owned-terminal',
        nativeSessionId: nativeId, source, sessionStartCommands: 2, statusLineExecuted: true }))
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  },
)
