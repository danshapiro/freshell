import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

import { writeProviderParityEnvironment } from '../../helpers/provider-parity-environment.js'

const root = path.resolve(import.meta.dirname, '../../..')

it.each([
  { form: 'file', format: 'json' }, { form: 'package', format: 'json' },
  { form: 'file', format: 'jsonc' }, { form: 'package', format: 'jsonc' },
])('the copied OpenCode fixture loads a selected $form TUI from $format and its native store', ({ form, format }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-controlled-opencode-'))
  try {
    const workspace = path.join(directory, 'workspace')
    const home = path.join(directory, 'home')
    const packageRoot = path.join(home, '.freshell/opencode')
    const entry = path.join(packageRoot, 'freshell-rebind-plugin.ts')
    const signalDir = path.join(home, '.freshell/native-identity/owned-launch')
    const launch = { incarnationId: 'owned-incarnation', launchNonce: 'owned-launch',
      evidenceRevision: 1, executionGeneration: 1, requestedNativeSessionId: null }
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(packageRoot, { recursive: true })
    fs.copyFileSync(path.join(root, 'test/fixtures/providers/parity-provider.mjs'), path.join(workspace, 'parity-provider.mjs'))
    fs.copyFileSync(path.join(root, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql'),
      path.join(workspace, 'opencode_schema_v1_18_21.sql'))
    fs.copyFileSync(path.join(root, 'extensions/opencode/freshell-rebind-plugin.ts'),
      path.join(packageRoot, 'native-rebind-plugin.ts'))
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module',
      exports: { './tui': './freshell-rebind-plugin.ts' } }))
    // Let this owned consumer exit itself after the real producer publishes
    // loaded evidence from the controlled SQLite APIs. No host process kill.
    fs.writeFileSync(entry, `import plugin from './native-rebind-plugin.ts';
export { emitHello, createEmitter } from './native-rebind-plugin.ts';
import fs from 'node:fs'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
export default { tui(api) {
  plugin.tui(api);
  const timeout = setTimeout(() => { console.error('native loader did not publish'); process.exit(1) }, 4000);
  const watch = setInterval(() => {
    const file = path.join(process.env.FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR, 'opencode-loaded.json');
    if (!fs.existsSync(file)) return;
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    const db = new DatabaseSync(path.join(process.env.HOME, '.local/share/opencode/opencode.db'), { readOnly: true });
    const session = db.prepare('SELECT id, parent_id FROM session WHERE id=?').get(evidence.native.session_id);
    db.close(); clearInterval(watch); clearTimeout(timeout);
    process.stdout.write('CONSUMED_NATIVE:' + JSON.stringify({ evidence, session }) + '\\n'); process.exit(0);
  }, 10);
} };
`)
    writeProviderParityEnvironment(path.join(home, '.config/opencode'), 'plugins/parity-environment')
    const tui = path.join(directory, `tui.${format}`)
    const spec = pathToFileURL(form === 'file' ? entry : packageRoot).href
    fs.writeFileSync(tui, format === 'jsonc'
      ? `{ // changed while web is down\n "plugin": [${JSON.stringify(spec)},],\n}`
      : JSON.stringify({ plugin: [spec] }))
    const wrapper = path.join(workspace, 'parity-opencode')
    fs.writeFileSync(wrapper, "import './parity-provider.mjs'\n")
    const result = spawnSync(process.execPath, ['--experimental-transform-types', wrapper,
      '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: workspace, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
        OPENCODE_TUI_CONFIG: tui, OPENCODE_CONFIG_CONTENT: '', FRESHELL_TERMINAL_ID: 'owned-terminal',
        FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR: signalDir, FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(launch) },
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const prefix = 'CONSUMED_NATIVE:'
    const consumed = JSON.parse(result.stdout.split('\n').find(line => line.startsWith(prefix))!.slice(prefix.length))
    expect(consumed.evidence.launch).toEqual(launch)
    expect(consumed.evidence.native).toMatchObject({ source: 'opencode-tui-native-loader', hydrated: true,
      parent_id: null, active_message_count: 0, messages_read: 'empty_confirmed', tail_message_id: null })
    expect(consumed.session).toEqual({ id: consumed.evidence.native.session_id, parent_id: null })
    expect(consumed.session.id).toMatch(/^ses_/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
