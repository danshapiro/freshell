import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneAmplifierEnvironment } from '../../helpers/amplifier-cli-isolation.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('cloneAmplifierEnvironment', () => {
  it('gives the real CLI a private package environment that cannot mutate its source', async () => {
    const sourcePrefix = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-source-'))
    cleanups.push(() => fs.rm(sourcePrefix, { recursive: true, force: true }))

    const sourcePython = path.join(sourcePrefix, 'bin', 'python')
    const sourceInterpreter = path.join(sourcePrefix, 'bin', 'python3')
    const sourcePackageRecord = path.join(
      sourcePrefix,
      'lib',
      'python3.12',
      'site-packages',
      'provider.pth',
    )
    await fs.mkdir(path.dirname(sourcePython), { recursive: true })
    await fs.mkdir(path.dirname(sourcePackageRecord), { recursive: true })
    await fs.writeFile(path.join(sourcePrefix, 'pyvenv.cfg'), 'home = /usr/bin')
    await fs.writeFile(sourcePython, 'fake interpreter')
    await fs.symlink('python', sourceInterpreter)
    await fs.writeFile(sourcePackageRecord, '/durable/provider/source')

    const isolated = await cloneAmplifierEnvironment({
      sourcePrefix,
      sourceInterpreter,
    })
    cleanups.push(isolated.dispose)

    expect(isolated.interpreter).not.toBe(sourceInterpreter)
    expect(path.relative(isolated.prefix, isolated.interpreter)).toBe('bin/python3')
    await expect(fs.readlink(isolated.interpreter)).resolves.toBe('python')

    const isolatedPackageRecord = path.join(
      isolated.prefix,
      'lib',
      'python3.12',
      'site-packages',
      'provider.pth',
    )
    await fs.writeFile(isolatedPackageRecord, '/temporary/provider/source')

    await expect(fs.readFile(sourcePackageRecord, 'utf8')).resolves.toBe(
      '/durable/provider/source',
    )
  })

  it('rejects an interpreter outside the package environment instead of copying a broad directory', async () => {
    const sourcePrefix = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-prefix-'))
    const externalInterpreterDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-python-'))
    cleanups.push(() => fs.rm(sourcePrefix, { recursive: true, force: true }))
    cleanups.push(() => fs.rm(externalInterpreterDir, { recursive: true, force: true }))

    const sourceInterpreter = path.join(externalInterpreterDir, 'python3')
    await fs.writeFile(sourceInterpreter, 'fake interpreter')

    await expect(cloneAmplifierEnvironment({
      sourcePrefix,
      sourceInterpreter,
    })).rejects.toThrow('inside the Amplifier environment')
  })

  it('rejects a system Python prefix instead of recursively copying it', async () => {
    const sourcePrefix = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-system-prefix-'))
    cleanups.push(() => fs.rm(sourcePrefix, { recursive: true, force: true }))

    const sourceInterpreter = path.join(sourcePrefix, 'bin', 'python3')
    await fs.mkdir(path.dirname(sourceInterpreter), { recursive: true })
    await fs.writeFile(sourceInterpreter, 'fake interpreter')

    await expect(cloneAmplifierEnvironment({
      sourcePrefix,
      sourceInterpreter,
    })).rejects.toThrow('non-virtual Python environment')
  })
})
