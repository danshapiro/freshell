// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { requireOpenCodeAuthFile } from '../../../e2e-browser/helpers/opencode-auth-file.js'

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
