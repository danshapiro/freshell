// test/e2e-electron/profile-picker.test.ts
/**
 * Profile picker + namespacing E2E — launches the real Electron app with a
 * temporary HOME containing a profiles.json registry.
 *
 * Requires dist/electron, dist/wizard, and dist/profile-picker to be built
 * (same as the wizard/chooser specs in electron-app.test.ts).
 */

import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const ELECTRON_BIN = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron')

function createTempHomeWithRegistry(registry: unknown): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-e2e-profiles-'))
  fs.mkdirSync(path.join(tmpHome, '.freshell'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpHome, '.freshell', 'profiles.json'),
    typeof registry === 'string' ? registry : JSON.stringify(registry),
  )
  return tmpHome
}

function sandboxEnv(tmpHome: string): NodeJS.ProcessEnv {
  // Sandbox ALL of Electron's per-user dirs, not just HOME: on Linux appData
  // (and thus userData + the single-instance lock key) derives from
  // XDG_CONFIG_HOME, and Chromium also writes XDG_CACHE_HOME/XDG_DATA_HOME.
  // Without these, named profiles and locks could escape into the real home
  // and collide with a live install (evidence: load-bearing-validator-lb-03).
  //
  // Also scrub profile-selection env from the ambient shell: an exported
  // FRESHELL_PROFILE would silently make every "flag-less" spec explicit,
  // and ELECTRON_DEV=1 would point the picker/wizard at dev-server URLs
  // instead of the built dist/ assets these specs assert on.
  const env = { ...process.env }
  delete env.FRESHELL_PROFILE
  delete env.ELECTRON_DEV
  return {
    ...env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
    XDG_CACHE_HOME: path.join(tmpHome, '.cache'),
    XDG_DATA_HOME: path.join(tmpHome, '.local', 'share'),
    NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
  }
}

async function launchApp(tmpHome: string, extraArgs: string[] = []): Promise<ElectronApplication> {
  return electron.launch({
    args: [PROJECT_ROOT, ...extraArgs],
    env: sandboxEnv(tmpHome) as Record<string, string>,
    cwd: PROJECT_ROOT,
  })
}

/**
 * Spawn a turned-away duplicate the way a second desktop launch really
 * happens: the electron binary directly, with no Playwright driver attached.
 * The duplicate is expected to exit on its own (it loses the per-userData
 * instance lock), so we assert on the real child-process exit event rather
 * than holding a Playwright handle (electron.launch's process() handle breaks
 * for short-lived apps).
 */
async function spawnDuplicateAndWaitForExit(
  tmpHome: string,
  extraArgs: string[] = [],
  timeoutMs = 30_000,
): Promise<number> {
  const child = spawn(ELECTRON_BIN, [PROJECT_ROOT, ...extraArgs], {
    env: sandboxEnv(tmpHome) as Record<string, string>,
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
  })
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`duplicate did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

test.describe('Profile picker', () => {
  let app: ElectronApplication | undefined
  let tmpHome: string | undefined

  test.afterEach(async () => {
    if (app) {
      // Wizard/picker-phase apps veto app.quit() via the will-quit guard
      // (wizardPhase is still true), so app.close() alone would hang the
      // worker teardown. Hard-exit the main process first — this is a test
      // teardown, not production shutdown.
      await app.evaluate(() => process.exit(0)).catch(() => {})
      await app.close().catch(() => {})
      app = undefined
    }
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true })
      tmpHome = undefined
    }
  })

  test('shows the picker with Default first when the registry names profiles', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await expect(
      picker.getByRole('heading', { name: 'Choose a Freshell profile' }),
    ).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Default' })).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Work' })).toBeVisible()
  })

  // Every picker choice (Default included) relaunches as an explicit profile:
  // the launcher's userData is the launcher dir, so continuing in-process
  // would leak launcher storage into a real profile. Stub relaunch/exit in
  // the main process before clicking and assert the rebuilt argv.
  test('choosing Default from the picker relaunches as --profile=default', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)

    await app.evaluate(({ app: electronApp }) => {
      const g = globalThis as Record<string, unknown>
      g.__relaunchCalls = []
      ;(electronApp as unknown as Record<string, unknown>).relaunch = (opts: unknown) => {
        ;(g.__relaunchCalls as unknown[]).push(opts)
      }
      ;(electronApp as unknown as Record<string, unknown>).exit = (code: number) => {
        g.__exitCode = code
      }
    })

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await picker.getByRole('button', { name: 'Default' }).click()

    await expect.poll(async () => app.evaluate(() => (globalThis as Record<string, unknown>).__exitCode ?? null),
      { timeout: 15_000 }).toBe(0)
    const relaunchCalls = await app.evaluate(() => (globalThis as Record<string, unknown>).__relaunchCalls)
    expect(relaunchCalls).toHaveLength(1)
    expect((relaunchCalls as { args: string[] }[])[0].args).toContain('--profile=default')
  })

  test('--profile boots the named profile without the picker and namespaces state', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'e2ework' }] })
    app = await launchApp(tmpHome, ['--profile=e2ework'])

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // The named profile has an empty config dir → first-run wizard proves we booted.
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(path.basename(userData).toLowerCase()).toBe('freshell-e2ework')

    // The main-process logger is bound to the profile config dir.
    await expect.poll(() => {
      const logsDir = path.join(tmpHome!, '.freshell-e2ework', 'logs')
      return fs.existsSync(logsDir) &&
        fs.readdirSync(logsDir).some((f) => /^electron-main\..*\.jsonl$/.test(f))
    }, { timeout: 15_000 }).toBe(true)

    // The default profile dir received no logs.
    expect(fs.existsSync(path.join(tmpHome, '.freshell', 'logs'))).toBe(false)
  })

  // Two DIFFERENT named profiles must boot side by side (independent userData
  // locks), each reading its OWN config and loading its OWN server. The test
  // process hosts two throwaway HTTP stub servers with distinct marker bodies;
  // each profile's remote-mode desktop.json points at one stub. Window URLs
  // then prove the full chain per profile: config-dir read → remote mode →
  // window loaded the seeded server.
  test('two named profiles run concurrently, each loading its own server', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'e2ework' }, { id: 'e2ehome' }] })

    const http = await import('http')
    const stub = (marker: string) => new Promise<{ url: string; server: import('http').Server }>((resolve) => {
      const server = http.createServer((req, res) => {
        res.setHeader('content-type', (req.url ?? '').includes('/api/') ? 'application/json' : 'text/html')
        if ((req.url ?? '').includes('/api/')) {
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.end(`<html><body>MARKER:${marker}</body></html>`)
        }
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') throw new Error('stub listen failed')
        resolve({ url: `http://127.0.0.1:${addr.port}`, server })
      })
    })
    const [s1, s2] = await Promise.all([stub('WORK'), stub('HOME')])

    const seedRemote = (id: string, url: string) => {
      const dir = path.join(tmpHome!, `.freshell-${id}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'desktop.json'), JSON.stringify({
        serverMode: 'remote', port: 3001,
        remoteUrl: url, remoteToken: 'e2e-token',
        knownServers: [{ url, label: id }],
        alwaysAskOnLaunch: false, globalHotkey: 'CommandOrControl+`',
        startOnLogin: false, minimizeToTray: false, setupCompleted: true,
      }, null, 2))
    }
    seedRemote('e2ework', s1.url)
    seedRemote('e2ehome', s2.url)

    app = await launchApp(tmpHome, ['--profile=e2ework'])
    let app2: ElectronApplication | undefined = await launchApp(tmpHome, ['--profile=e2ehome'])
    try {
      // Both alive (independent per-profile locks).
      expect(app.process().exitCode).toBeNull()

      const w1 = await app.firstWindow()
      const w2 = await app2.firstWindow()
      // Neither shows the first-run wizard (each read its OWN seeded config).
      await expect.poll(async () => {
        const isWizard = async (w: typeof w1) => (await w.locator('h1:has-text("Welcome to Freshell")').count()) > 0
        return !(await isWizard(w1)) && !(await isWizard(w2))
      }, { timeout: 30_000 }).toBe(true)

      // The core requested-behavior proof: each profile's window navigated to
      // ITS OWN stub server. URL equality per profile = wrong-config wiring
      // would land both windows on the same URL.
      await expect.poll(() => w1.url(), { timeout: 30_000 }).toContain(String(new URL(s1.url).port))
      await expect.poll(() => w2.url(), { timeout: 30_000 }).toContain(String(new URL(s2.url).port))
      await expect(w1.locator('text=MARKER:WORK')).toBeVisible({ timeout: 30_000 })
      await expect(w2.locator('text=MARKER:HOME')).toBeVisible({ timeout: 30_000 })

      const ud1 = await app.evaluate(({ app: a1 }) => a1.getPath('userData'))
      const ud2 = await app2.evaluate(({ app: a2 }) => a2.getPath('userData'))
      expect(path.basename(ud1).toLowerCase()).toBe('freshell-e2ework')
      expect(path.basename(ud2).toLowerCase()).toBe('freshell-e2ehome')

      for (const id of ['e2ework', 'e2ehome']) {
        await expect.poll(() => {
          const d = path.join(tmpHome!, `.freshell-${id}`, 'logs')
          return fs.existsSync(d) && fs.readdirSync(d).some((f) => /^electron-main\..*\.jsonl$/.test(f))
        }, { timeout: 15_000 }).toBe(true)
      }
      // The default profile dir received no logs from either named process.
      expect(fs.existsSync(path.join(tmpHome, '.freshell', 'logs'))).toBe(false)
    } finally {
      if (app2) {
        await app2.evaluate(() => process.exit(0)).catch(() => {})
        await app2.close().catch(() => {})
      }
      s1.server.close()
      s2.server.close()
    }
  })

  // The relaunch path itself must be proven: stub app.relaunch/app.exit in the
  // main process before clicking, then assert the IPC choice rebuilt argv with
  // --profile (an unstubbed relaunch would re-exec and lose the assertion).
  test('choosing a named profile from the picker relaunches with --profile=<id>', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)

    await app.evaluate(({ app: electronApp }) => {
      const g = globalThis as Record<string, unknown>
      g.__relaunchCalls = []
      ;(electronApp as unknown as Record<string, unknown>).relaunch = (opts: unknown) => {
        ;(g.__relaunchCalls as unknown[]).push(opts)
      }
      ;(electronApp as unknown as Record<string, unknown>).exit = (code: number) => {
        g.__exitCode = code
      }
    })

    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await picker.getByRole('button', { name: 'Work' }).click()

    await expect.poll(async () => app.evaluate(() => (globalThis as Record<string, unknown>).__exitCode ?? null),
      { timeout: 15_000 }).toBe(0)
    const relaunchCalls = await app.evaluate(() => (globalThis as Record<string, unknown>).__relaunchCalls)
    expect(relaunchCalls).toHaveLength(1)
    expect((relaunchCalls as { args: string[] }[])[0].args).toContain('--profile=work')
    // stripProfileArgs must not double-append: exactly one --profile= entry.
    expect((relaunchCalls as { args: string[] }[])[0].args.filter((a) => a.startsWith('--profile='))).toHaveLength(1)
  })

  test('an invalid registry file is ignored and the default profile boots', async () => {
    tmpHome = createTempHomeWithRegistry('not valid json {{{')
    app = await launchApp(tmpHome)

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })
  })

  // LB-02 / dedicated-launcher design: a flag-less launch must reach the
  // picker even while a Default-profile instance is resident (the launcher
  // parks in its own userData with its own lock, so Default never blocks it).
  // This is the steady state the feature exists for (minimizeToTray
  // defaults true, so Default typically stays resident).
  test('a flag-less launch while Default is resident still shows the picker', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })

    // First process: an EXPLICIT default launch becomes the resident Default
    // instance (a picker choice would relaunch into a new untracked process).
    app = await launchApp(tmpHome, ['--profile=default'])
    const window1 = await app.firstWindow()
    await window1.waitForLoadState('domcontentloaded')
    await expect(window1.locator('h1:has-text("Welcome to Freshell")'))
      .toBeVisible({ timeout: 30_000 })

    // Second flag-less launch shows the picker: the launcher's userData (and
    // lock) is the dedicated launcher dir, so the resident Default does not
    // contend with it at all.
    const app2 = await launchApp(tmpHome)
    try {
      const picker2 = await app2.firstWindow()
      await picker2.waitForLoadState('domcontentloaded')
      await expect(
        picker2.getByRole('heading', { name: 'Choose a Freshell profile' }),
      ).toBeVisible({ timeout: 30_000 })
    } finally {
      await app2.evaluate(() => process.exit(0)).catch(() => {})
      await app2.close().catch(() => {})
    }
  })

  // Racing flag-less launches: the second one loses the launcher lock, exits,
  // and the resident picker receives second-instance (one picker at a time).
  test('a second flag-less launch is turned away and delivers second-instance to the resident picker', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome)
    const picker = await app.firstWindow()
    await picker.waitForLoadState('domcontentloaded')
    await expect(picker.getByRole('heading', { name: 'Choose a Freshell profile' }))
      .toBeVisible({ timeout: 30_000 })

    await app.evaluate(({ app: launcherApp }) => {
      ;(globalThis as Record<string, unknown>).__pickerSecondInstance = 0
      launcherApp.on('second-instance', () => {
        ;(globalThis as Record<string, unknown>).__pickerSecondInstance =
          ((globalThis as Record<string, unknown>).__pickerSecondInstance as number) + 1
      })
    })

    const dupExit = await spawnDuplicateAndWaitForExit(tmpHome)
    expect(dupExit).toBe(0)

    await expect.poll(
      () => app!.evaluate(() => (globalThis as Record<string, unknown>).__pickerSecondInstance),
      { timeout: 15_000 },
    ).toBe(1)
    // The resident picker is still there, alive.
    expect(app!.process().exitCode).toBeNull()
    await expect(picker.getByRole('heading', { name: 'Choose a Freshell profile' })).toBeVisible()
  })

  // Same-profile turn-away: an explicit duplicate of the resident profile is
  // turned away at the lock gate; the resident's production second-instance
  // handler (installed in main(), not a test listener) surfaces it — proven
  // by hiding the resident's wizard window and asserting it re-appears.
  test('an explicit duplicate of a resident profile quits and the resident surfaces', async () => {
    tmpHome = createTempHomeWithRegistry({ profiles: [{ id: 'work', label: 'Work' }] })
    app = await launchApp(tmpHome, ['--profile=work'])
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // Named profile, fresh HOME → first-run wizard proves we are resident.
    await expect(window.locator('h1:has-text("Welcome to Freshell")')).toBeVisible({ timeout: 30_000 })

    // Hide the resident's window via the resident's own BrowserWindow API; the
    // surfacing claim only means something if production code is what restores
    // visibility. NB: read NATIVE visibility via isVisible() in the main
    // process — a DOM locator's visibility does not reflect native window
    // show/hide (DOM stays "visible" in the renderer while the OS window hides).
    await app.evaluate(({ BrowserWindow: BW }) => {
      const win = BW.getAllWindows().find((w) => !w.isDestroyed())
      win?.hide()
    })
    const isNativeVisible = () => app!.evaluate(({ BrowserWindow: BW }) => {
      const win = BW.getAllWindows().find((w) => !w.isDestroyed())
      return win ? win.isVisible() : false
    })
    expect(await isNativeVisible()).toBe(false)

    const dupExit = await spawnDuplicateAndWaitForExit(tmpHome, ['--profile=work'])
    expect(dupExit).toBe(0)

    // Production `second-instance` handler surfaced the resident's window.
    // (The resident's wizard was hidden by the test above; only production
    // surfacing can flip this back on.)
    await expect.poll(isNativeVisible, { timeout: 15_000 }).toBe(true)
    expect(app!.process().exitCode).toBeNull()
  })
})
