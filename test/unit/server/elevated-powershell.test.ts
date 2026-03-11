import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import {
  buildElevatedPowerShellArgs,
  ELEVATED_POWERSHELL_TIMEOUT_MS,
  spawnElevatedPowerShell,
} from '../../../server/elevated-powershell.js'

describe('elevated-powershell', () => {
  it('escapes single quotes for Start-Process -Verb RunAs', () => {
    expect(buildElevatedPowerShellArgs("Write-Host 'hi'")).toEqual([
      '-Command',
      "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'Write-Host ''hi'''",
    ])
  })

  it('spawns execFile with a 120s timeout', () => {
    const cb = vi.fn()

    spawnElevatedPowerShell('powershell.exe', "Write-Host 'hi'", cb)

    expect(execFile).toHaveBeenCalledWith(
      'powershell.exe',
      buildElevatedPowerShellArgs("Write-Host 'hi'"),
      { timeout: ELEVATED_POWERSHELL_TIMEOUT_MS },
      cb,
    )
  })
})
