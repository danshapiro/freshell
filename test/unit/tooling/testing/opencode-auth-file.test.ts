// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  requireOpenCodeAuthFile,
  requireOpenCodeOnecliBootstrap,
} from '../../../e2e-browser/helpers/opencode-auth-file.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-reference-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('OpenCode qualification auth reference', () => {
  it('fails fast when no explicit OneCLI auth grant is configured', () => {
    expect(() => requireOpenCodeAuthFile({})).toThrow(/FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE/)
  })

  it('returns the resolved path of a private regular OneCLI auth grant', () => {
    const authFile = path.join(root, 'auth.json')
    fs.writeFileSync(authFile, '{}')
    fs.chmodSync(authFile, 0o600)

    expect(requireOpenCodeAuthFile({ FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile }))
      .toBe(path.resolve(authFile))
  })

  it('rejects missing paths, directories, linked grants, and unusable file permissions', () => {
    expect(() => requireOpenCodeAuthFile({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: path.join(root, 'missing.json'),
    })).toThrow(/existing file/)
    expect(() => requireOpenCodeAuthFile({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: root,
    })).toThrow(/regular file/)

    const privateFile = path.join(root, 'private.json')
    fs.writeFileSync(privateFile, '{}', { mode: 0o600 })
    const linkedFile = path.join(root, 'linked.json')
    fs.symlinkSync(privateFile, linkedFile)
    expect(() => requireOpenCodeAuthFile({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: linkedFile,
    })).toThrow(/regular file/)

    const publicFile = path.join(root, 'public.json')
    fs.writeFileSync(publicFile, '{}', { mode: 0o644 })
    fs.chmodSync(publicFile, 0o644)
    expect(() => requireOpenCodeAuthFile({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: publicFile,
    })).toThrow(/private/)

    const unreadableFile = path.join(root, 'unreadable.json')
    fs.writeFileSync(unreadableFile, '{}', { mode: 0o000 })
    fs.chmodSync(unreadableFile, 0o000)
    expect(() => requireOpenCodeAuthFile({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: unreadableFile,
    })).toThrow(/owner-readable/)
  })
})

describe('OpenCode OneCLI qualification bootstrap', () => {
  function writeGrant(name: string, value: string): string {
    const file = path.join(root, name)
    fs.writeFileSync(file, value, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    return file
  }

  function makeBootstrap() {
    const authFile = writeGrant('onecli-auth.json', JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'onecli-managed',
        refresh: 'onecli-managed',
        expires: Date.now() + 24 * 60 * 60 * 1000,
      },
    }))
    const environmentFile = writeGrant('onecli.env', [
      'OPENAI_BASE_URL=https://api.openai.com/v1',
      'HTTPS_PROXY=http://agent:secret@192.168.3.150:10255',
      'https_proxy=http://agent:secret@192.168.3.150:10255',
      'HTTP_PROXY=http://agent:secret@192.168.3.150:10255',
      'http_proxy=http://agent:secret@192.168.3.150:10255',
      'NODE_EXTRA_CA_CERTS=/home/freshell/provider/.config/onecli/gateway-ca.pem',
      'NODE_USE_ENV_PROXY=1',
      '',
    ].join('\n'))
    const caFile = writeGrant('gateway-ca.pem', 'OneCLI gateway CA fixture')
    const env = {
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: caFile,
    }
    return { authFile, environmentFile, caFile, env }
  }

  it('fails fast unless all three private OneCLI grants are configured', () => {
    const { authFile, environmentFile } = makeBootstrap()
    expect(() => requireOpenCodeOnecliBootstrap({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
    })).toThrow(/FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE/)
    expect(() => requireOpenCodeOnecliBootstrap({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile,
    })).toThrow(/FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE/)
  })

  it('accepts the private native OpenCode stub, proxy environment, and CA grants', () => {
    const { authFile, environmentFile, caFile, env } = makeBootstrap()
    expect(requireOpenCodeOnecliBootstrap(env)).toEqual({
      authFile: fs.realpathSync(authFile),
      environmentFile: fs.realpathSync(environmentFile),
      caFile: fs.realpathSync(caFile),
    })
  })

  it('rejects expired, real-token, and Codex-shaped OpenCode auth files', () => {
    const { env, authFile } = makeBootstrap()
    const original = JSON.parse(fs.readFileSync(authFile, 'utf8'))
    for (const openai of [
      { ...original.openai, expires: Date.now() - 1 },
      { ...original.openai, access: 'real-access-token' },
      { ...original.openai, last_refresh: Date.now() },
    ]) {
      fs.writeFileSync(authFile, JSON.stringify({ openai }), { mode: 0o600 })
      expect(() => requireOpenCodeOnecliBootstrap(env)).toThrow(/OneCLI placeholder OAuth credential/)
    }
  })
})
