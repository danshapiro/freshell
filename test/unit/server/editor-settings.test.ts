import { describe, it, expect } from 'vitest'
import { SettingsPatchSchema } from '../../../server/settings-router'

describe('editor settings schema', () => {
  it('accepts valid editor preset', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: { externalEditor: 'cursor' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts custom editor with command', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: {
        externalEditor: 'custom',
        customEditorCommand: 'nvim +{line} {file}',
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown editor preset', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: { externalEditor: 'emacs' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown keys inside editor (strict)', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: { externalEditor: 'auto', unknownKey: true },
    })
    expect(result.success).toBe(false)
  })

  it('accepts empty editor object', () => {
    const result = SettingsPatchSchema.safeParse({
      editor: {},
    })
    expect(result.success).toBe(true)
  })

  it('accepts runtime CLI provider names in the exported schema', () => {
    const result = SettingsPatchSchema.safeParse({
      codingCli: {
        enabledProviders: ['custom-cli'],
        knownProviders: ['custom-cli'],
        providers: {
          'custom-cli': {
            model: 'custom-model',
          },
        },
      },
    })

    expect(result.success).toBe(true)
  })
})
