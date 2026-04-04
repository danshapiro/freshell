import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('TypeScript incremental compilation config', () => {
  const configNames = [
    'tsconfig.json',
    'tsconfig.server.json',
    'tsconfig.electron.json',
    'tsconfig.electron-preload.json',
  ]

  const configs = configNames.map(name => {
    const filePath = path.resolve(__dirname, '../../../', name)
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return { name, content }
  })

  for (const { name, content } of configs) {
    it(`${name} has incremental enabled`, () => {
      expect(content.compilerOptions.incremental).toBe(true)
    })

    it(`${name} has tsBuildInfoFile under node_modules/.cache/`, () => {
      expect(content.compilerOptions.tsBuildInfoFile).toMatch(/node_modules\/\.cache\//)
    })
  }

  it('all tsBuildInfoFile paths are distinct', () => {
    const paths = configs.map(c => c.content.compilerOptions.tsBuildInfoFile)
    const uniquePaths = new Set(paths)
    expect(uniquePaths.size).toBe(paths.length)
  })
})
