import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  buildSupervisorObserverWrapper,
  buildSupervisorTargetWrapper,
  classifySupervisorGdbFailure,
  summarizeSupervisorGdbAttachFacts,
  summarizeSupervisorGdbFailureOutput,
  summarizeSupervisorGdbOutput,
} from '../../helpers/supervisor-crash-diagnostics.js'

async function waitForFile(filePath: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    if (child.exitCode !== null) {
      throw new Error('wrapper exited before its marker (code=' + child.exitCode + ')')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('wrapper marker did not appear')
}

async function waitForExit(
  promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('wrapper did not exit')), 1_500)
      timer.unref()
    }),
  ])
}

describe('supervisor crash diagnostic parsing', () => {
  it.skipIf(process.platform === 'win32')('executes the exact detached observer and target wrappers and waits for their children', async () => {
    const temporaryRoot = path.join(process.cwd(), '.test-tmp')
    fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'supervisor-gdb-wrapper-'))
    const stubPath = path.join(directory, 'stub-child.sh')
    fs.writeFileSync(stubPath, [
      '#!/bin/sh',
      'printf "%s\\n" "$1" > child-mode',
      'printf "%s\\n" "$$" > child-self-pid',
      'printf started > child-started',
      'while [ ! -f release ]; do sleep 0.01; done',
      'printf done > child-done',
      'exit 7',
      '',
    ].join('\n'), { mode: 0o700 })
    fs.chmodSync(stubPath, 0o700)

    try {
      const cases = [
        {
          kind: 'observer',
          wrapperStartedPath: path.join(directory, 'wrapper-started'),
          launchOutputPath: path.join(directory, 'launch-output'),
          pidPath: path.join(directory, 'child.pid'),
          exitPath: path.join(directory, 'child.exit'),
          build: (paths: { wrapperStartedPath: string; launchOutputPath: string; pidPath: string; exitPath: string }) =>
            buildSupervisorObserverWrapper('./stub-child.sh observer', paths),
        },
        {
          kind: 'target',
          wrapperStartedPath: undefined,
          launchOutputPath: undefined,
          pidPath: path.join(directory, 'target.pid'),
          exitPath: path.join(directory, 'target.exit'),
          build: (paths: { pidPath: string; exitPath: string }) =>
            buildSupervisorTargetWrapper('./stub-child.sh segv', paths.pidPath, paths.exitPath),
        },
      ] as const

      for (const wrapperCase of cases) {
        for (const file of [
          path.join(directory, 'child-mode'),
          path.join(directory, 'child-self-pid'),
          path.join(directory, 'child-started'),
          path.join(directory, 'child-done'),
          path.join(directory, 'release'),
          wrapperCase.wrapperStartedPath,
          wrapperCase.launchOutputPath,
          wrapperCase.pidPath,
          wrapperCase.exitPath,
        ]) {
          if (file && fs.existsSync(file)) fs.rmSync(file, { force: true })
        }
        const wrapper = wrapperCase.kind === 'observer'
          ? wrapperCase.build({
            wrapperStartedPath: wrapperCase.wrapperStartedPath!,
            launchOutputPath: wrapperCase.launchOutputPath!,
            pidPath: wrapperCase.pidPath,
            exitPath: wrapperCase.exitPath,
          })
          : wrapperCase.build({ pidPath: wrapperCase.pidPath, exitPath: wrapperCase.exitPath })
        const child = spawn('/bin/sh', ['-c', wrapper], {
          cwd: directory,
          detached: true,
          stdio: 'ignore',
        })
        const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code, signal) => resolve({ code, signal }))
        })

        try {
          if (wrapperCase.wrapperStartedPath) await waitForFile(wrapperCase.wrapperStartedPath, child)
          await waitForFile(path.join(directory, 'child-started'), child)
          expect(child.exitCode).toBeNull()
          expect(fs.existsSync(wrapperCase.exitPath)).toBe(false)
          expect(fs.readFileSync(path.join(directory, 'child-mode'), 'utf8').trim())
            .toBe(wrapperCase.kind === 'observer' ? 'observer' : 'segv')

          fs.writeFileSync(path.join(directory, 'release'), 'release')
          expect(await waitForExit(completed)).toEqual({ code: 7, signal: null })
          expect(fs.readFileSync(wrapperCase.exitPath, 'utf8').trim()).toBe('7')
          expect(fs.readFileSync(path.join(directory, 'child-done'), 'utf8')).toBe('done')
          const wrapperPid = Number(fs.readFileSync(wrapperCase.pidPath, 'utf8').trim())
          const childPid = Number(fs.readFileSync(path.join(directory, 'child-self-pid'), 'utf8').trim())
          expect(wrapperPid).toBeGreaterThan(1)
          expect(wrapperPid).toBe(childPid)
          expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/)
        } finally {
          fs.writeFileSync(path.join(directory, 'release'), 'release')
          const settleDeadline = Date.now() + 500
          while (Date.now() < settleDeadline
            && (child.exitCode === null
              || (fs.existsSync(path.join(directory, 'child-started'))
                && !fs.existsSync(path.join(directory, 'child-done'))))) {
            await new Promise(resolve => setTimeout(resolve, 10))
          }
          const childStillRunning = fs.existsSync(path.join(directory, 'child-started'))
            && !fs.existsSync(path.join(directory, 'child-done'))
          if (child.pid !== undefined && (child.exitCode === null || childStillRunning)) {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
          }
          if (child.exitCode === null) await waitForExit(completed)
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps signal, thread, and symbol evidence while removing addresses and paths', () => {
    const summary = summarizeSupervisorGdbOutput([
      'FRESHELL_GDB_ATTACHED',
      'Program received signal SIGSEGV, Segmentation fault.',
      'Thread 3 (Thread 0x00007fff12345678 (LWP 97)):',
      '#0  0x00007fff00112233 in worker () at /private/build/worker.rs:17',
      '#1  0x00007fff00445566 in std::thread::start_thread () from /lib/private/libstd.so',
      'Thread 1 (Thread 0x00007fff87654321 (LWP 91)):',
      '#0  0x00007fff00778899 in supervisor_main () at /private/build/main.rs:8',
      '#2  /private/build/worker.rs:17',
    ].join('\n'))

    expect(summary).toMatchObject({
      available: true,
      attached: true,
      signal: 'SIGSEGV',
      threadCount: 2,
      threadDebugUnavailable: false,
    })
    expect(summary.frames).toEqual([
      { thread: 3, frame: 0, symbol: 'worker' },
      { thread: 3, frame: 1, symbol: 'std::thread::start_thread' },
      { thread: 1, frame: 0, symbol: 'supervisor_main' },
      { thread: 1, frame: 2, symbol: 'unknown' },
    ])
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-f]+|private\/build|private\/lib/)
  })

  it('summarizes startup failures without retaining addresses or filesystem paths', () => {
    const failure = summarizeSupervisorGdbFailureOutput(
      'warning: Could not attach to process 1 at 0x00007fff00112233\n'
        + 'ptrace: Operation not permitted. See /private/build/supervisor.rs:18',
      'gdb: /private/toolchain/bin/gdb: attach failed for /home/user/session',
    )

    expect(failure).toMatchObject({
      category: 'ptrace-denied',
      log: { available: true, attached: false },
    })
    expect(failure.diagnosticLines).toContain('ptrace: Operation not permitted. See <path>')
    expect(JSON.stringify(failure)).not.toMatch(/0x[0-9a-f]+|private\/build|private\/toolchain|home\/user/)
  })

  it('classifies common GDB setup failures without retaining their raw output', () => {
    expect(classifySupervisorGdbFailure('ptrace: Operation not permitted')).toBe('ptrace-denied')
    expect(classifySupervisorGdbFailure('Unable to find libthread_db')).toBe('thread-db-unavailable')
    expect(classifySupervisorGdbFailure('error while loading shared libraries')).toBe('missing-shared-library')
    expect(classifySupervisorGdbFailure('Could not attach to process')).toBe('attach-rejected')
    expect(classifySupervisorGdbFailure('')).toBe('empty-output')
  })

  it('reports the observer stage and bounded process facts without raw kernel values', () => {
    const facts = summarizeSupervisorGdbAttachFacts({
      stage: 'gdb_attach',
      markers: { wrapperStarted: true, scriptStarted: true, attached: false, exited: false, exitCode: undefined },
      container: { verified: true, running: true },
      gdb: {
        present: true,
        identityMatches: true,
        state: 'D (disk sleep)',
        waitChannel: 'do_wait_for_common',
        threads: 2,
        capEff: '0000000000080000',
        tracerPid: 0,
      },
      target: {
        present: true,
        identityMatches: true,
        state: 't (tracing stop)',
        waitChannel: 'ptrace_stop',
        threads: 96,
        capEff: '0000000000080000',
        tracerPid: 12345,
      },
    })

    expect(facts).toEqual({
      stage: 'gdb_attach',
      markers: { wrapperStarted: true, scriptStarted: true, attached: false, exited: false, exitStatus: 'unknown' },
      container: { verified: true, running: true },
      gdb: {
        present: true, identityMatches: true, state: 'disk_sleep', waitClass: 'wait',
        threadCount: '2_to_8', hasSysPtrace: true, tracerPresent: false,
      },
      target: {
        present: true, identityMatches: true, state: 'tracing_stop', waitClass: 'ptrace',
        threadCount: '33_to_128', hasSysPtrace: true, tracerPresent: true,
      },
    })
    expect(JSON.stringify(facts)).not.toMatch(/do_wait_for_common|ptrace_stop|0000000000080000|12345|96/)
  })

  it('withholds process details when a recorded pid no longer matches the owned process', () => {
    const facts = summarizeSupervisorGdbAttachFacts({
      stage: 'gdb_script_start',
      markers: { wrapperStarted: true, scriptStarted: false, attached: false, exited: false },
      container: { verified: true, running: true },
      gdb: {
        present: true,
        identityMatches: false,
        state: 'R (running)',
        waitChannel: '/private/kernel/secret',
        threads: 12,
        capEff: '0000000000080000',
        tracerPid: 789,
      },
      target: {
        present: true,
        identityMatches: true,
        state: 'S (sleeping)',
        waitChannel: 'ep_poll',
        threads: 4,
        capEff: '0000000000000000',
        tracerPid: 0,
      },
    })

    expect(facts.gdb).toEqual({
      present: true, identityMatches: false, state: 'unavailable', waitClass: 'unavailable',
      threadCount: 'unavailable', hasSysPtrace: null, tracerPresent: null,
    })
    expect(JSON.stringify(facts)).not.toMatch(/private\/kernel|0000000000080000|0000000000000000|789|12/)
  })
})
