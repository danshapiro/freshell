// electron/profile.ts
import path from 'path'
import { z } from 'zod'

export const DEFAULT_PROFILE_ID = 'default'

/**
 * The profile-picker launcher reserves this id: a flag-less launch that is
 * about to show the picker namespaces its userData to
 * `<appData>/<AppName>-profile-picker` so the picker process never shares a
 * Chromium userData dir with a resident Default (or named) instance.
 */
export const PICKER_USERDATA_ID = 'profile-picker'

/**
 * Profile ids become directory names on every supported OS, so keep them
 * conservative: lowercase kebab-case, no path separators or dots (so no
 * '..' traversal), bounded length.
 */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export const ProfileEntrySchema = z.object({
  id: z.string().regex(PROFILE_ID_PATTERN),
  label: z.string().trim().min(1).max(64).optional(),
})

export const ProfilesRegistrySchema = z.object({
  profiles: z.array(ProfileEntrySchema),
}).superRefine((value, ctx) => {
  const seen = new Set<string>()
  for (const entry of value.profiles) {
    if (entry.id === DEFAULT_PROFILE_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${DEFAULT_PROFILE_ID}' is a reserved profile id` })
    }
    if (entry.id === PICKER_USERDATA_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${PICKER_USERDATA_ID}' is a reserved profile id` })
    }
    if (seen.has(entry.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate profile id '${entry.id}'` })
    }
    seen.add(entry.id)
  }
})

export type ProfileEntry = z.infer<typeof ProfileEntrySchema>

/**
 * Contract note — the built-in Default profile is ALWAYS part of the choice
 * set, so "more than one profile is configured" (per the User Request wording)
 * is satisfied as soon as the registry names ≥1 named profile: the effective
 * choices are `[Default, ...registry.profiles]`. This keeps the registry file
 * minimal (named profiles only) and matches the picker UX.
 */

export type ProfileSource = 'argv' | 'env' | 'default'

export interface ProfileSelection {
  id: string
  explicit: boolean
  source: ProfileSource
}

export interface ProfileSelectionResult {
  selection: ProfileSelection
  /** Set when an explicitly requested id was invalid and default was substituted. */
  error?: string
}

/** Extract `--profile=<id>` or `--profile <id>` from a raw argv slice. */
export function parseProfileArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) return next
      return undefined
    }
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return undefined
}

/** Remove every `--profile=<id>` / `--profile <id>` pair from an argv slice.
 * Mirrors parseProfileArg exactly: `--profile` only consumes the next token
 * when it is a non-flag value; `--profile --other` drops just `--profile`
 * (since no value was taken) and keeps `--other`. */
export function stripProfileArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--profile=')) continue
    if (arg === '--profile') {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) i++ // consumed a real value
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Resolve the active profile. Precedence: `--profile` argv > `FRESHELL_PROFILE`
 * env > (picker, by returning non-explicit default) > default.
 */
export function resolveProfileSelection(
  argv: string[],
  env: NodeJS.ProcessEnv,
): ProfileSelectionResult {
  const fromArgv = parseProfileArg(argv)
  const fromEnv = env.FRESHELL_PROFILE?.trim()
  const raw = fromArgv ?? (fromEnv ? fromEnv : undefined)
  const source: ProfileSource = fromArgv !== undefined ? 'argv' : raw !== undefined ? 'env' : 'default'
  if (raw === undefined) {
    return { selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' } }
  }
  if (raw === DEFAULT_PROFILE_ID) {
    return { selection: { id: DEFAULT_PROFILE_ID, explicit: true, source } }
  }
  if (raw === PICKER_USERDATA_ID) {
    return {
      selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' },
      error: `Profile id '${PICKER_USERDATA_ID}' is reserved for the picker launcher; using the default profile.`,
    }
  }
  if (!PROFILE_ID_PATTERN.test(raw)) {
    return {
      selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' },
      error: `Invalid profile id '${raw}' (must match ${PROFILE_ID_PATTERN}); using the default profile.`,
    }
  }
  return { selection: { id: raw, explicit: true, source } }
}

/** Profile config dir: `~/.freshell` for default, `~/.freshell-<id>` for named. */
export function configDirForProfile(id: string, homedir: string): string {
  if (id === DEFAULT_PROFILE_ID) return path.join(homedir, '.freshell')
  return path.join(homedir, `.freshell-${id}`)
}

/**
 * userData dir for a named profile. Returns undefined for the default
 * profile, meaning "leave Electron's default userData untouched".
 */
export function userDataDirForProfile(
  id: string,
  appName: string,
  appDataDir: string,
): string | undefined {
  if (id === DEFAULT_PROFILE_ID) return undefined
  return path.join(appDataDir, `${appName}-${id}`)
}

/**
 * userData dir for the ephemeral profile-picker launcher process. It MUST NOT
 * be the default profile's userData: when a Default instance is resident, a
 * picker launch that reused Default's userData would put two browser processes
 * on one Chromium profile dir (process-singleton violation, storage hazard).
 * The picker's own userData also re-keys the instance lock, giving one picker
 * at a time with `second-instance` focusing the resident picker.
 */
export function userDataDirForPicker(appName: string, appDataDir: string): string {
  return path.join(appDataDir, `${appName}-${PICKER_USERDATA_ID}`)
}

/** The registry is machine-global and always lives in the default config dir. */
export function registryPathForHome(homedir: string): string {
  return path.join(homedir, '.freshell', 'profiles.json')
}

export interface RegistryReadResult {
  profiles: ProfileEntry[]
  /** Set when a file existed but was unusable; profiles are then empty. */
  error?: string
}

/**
 * Read and validate the profile registry. A missing file is normal (no
 * profiles configured); a present-but-invalid file is an error the caller
 * should surface (log) while booting the default profile.
 */
export function readProfilesRegistry(
  registryPath: string,
  readFile: (p: string) => string | undefined,
): RegistryReadResult {
  let content: string | undefined
  try {
    content = readFile(registryPath)
  } catch (err) {
    // Exists-but-unreadable (EACCES, a directory named profiles.json, a TOCTOU
    // race between existsSync and readFileSync in the caller's reader): warn
    // and fall back to the default profile, exactly like an invalid registry.
    return { profiles: [], error: `Profile registry at ${registryPath} could not be read (${err instanceof Error ? err.message : String(err)}); ignoring it.` }
  }
  if (content === undefined) return { profiles: [] }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(content)
  } catch {
    return { profiles: [], error: `Profile registry at ${registryPath} is not valid JSON; ignoring it.` }
  }
  const parsed = ProfilesRegistrySchema.safeParse(parsedJson)
  if (!parsed.success) {
    return { profiles: [], error: `Profile registry at ${registryPath} is invalid; ignoring it.` }
  }
  return { profiles: parsed.data.profiles }
}

/** The picker appears when the choice set (default + named) has >1 entries. */
export function shouldShowProfilePicker(
  selection: ProfileSelection,
  registry: RegistryReadResult,
): boolean {
  return !selection.explicit && registry.profiles.length >= 1
}

/**
 * The full module-top boot decision for entry.ts. One of:
 * - 'picker': flag-less launch with ≥1 named profiles in the registry —
 *   userData is namespaced to the launcher dir and the boot shows ONLY
 *   the picker (configDir stays the default profile dir, since the registry
 *   and the launcher's diagnostic logs live there).
 * - 'explicit': argv/env named a valid profile — namespace userData (except
 *   default) and boot that profile.
 * - 'default': everything else — today's boot, zero behavior change.
 */
export interface BootShape {
  kind: 'picker' | 'explicit' | 'default'
  profileId: string
  userDataDir?: string
  configDir: string
  /** Set when an explicit request was invalid and default was substituted;
   *  entry.ts logs it (warn) so the fallback is visible. */
  error?: string
}

export function resolveBootShape(
  argv: string[],
  env: NodeJS.ProcessEnv,
  registry: RegistryReadResult,
  appName: string,
  appDataDir: string,
  homedir: string,
): BootShape {
  const { selection, error } = resolveProfileSelection(argv, env)
  // An explicitly requested but INVALID profile must NOT surface the picker:
  // the resolver already fell back to default; honor that and surface the
  // reason via `error`.
  if (error) {
    return {
      kind: 'default',
      profileId: DEFAULT_PROFILE_ID,
      configDir: configDirForProfile(DEFAULT_PROFILE_ID, homedir),
      error,
    }
  }
  if (selection.explicit) {
    return {
      kind: 'explicit',
      profileId: selection.id,
      userDataDir: userDataDirForProfile(selection.id, appName, appDataDir),
      configDir: configDirForProfile(selection.id, homedir),
    }
  }
  if (shouldShowProfilePicker(selection, registry)) {
    // The picker launcher is not itself a profile session: it logs to the
    // default config dir but parks its userData in its own dir.
    return {
      kind: 'picker',
      profileId: DEFAULT_PROFILE_ID,
      userDataDir: userDataDirForPicker(appName, appDataDir),
      configDir: configDirForProfile(DEFAULT_PROFILE_ID, homedir),
    }
  }
  return {
    kind: 'default',
    profileId: DEFAULT_PROFILE_ID,
    configDir: configDirForProfile(DEFAULT_PROFILE_ID, homedir),
  }
}

export interface PickerEntry {
  id: string
  label: string
}

/** Picker entries: the default profile first, then the registry in file order. */
export function buildPickerEntries(registry: RegistryReadResult): PickerEntry[] {
  return [
    { id: DEFAULT_PROFILE_ID, label: 'Default' },
    ...registry.profiles.map((p) => ({ id: p.id, label: p.label ?? p.id })),
  ]
}

/**
 * True when any named-profile state exists on disk, even when the registry is
 * missing/unreadable or an id was used without being listed (both are
 * documented: `FRESHELL_PROFILE=work` works with no registry entry — the id
 * "simply starts with a fresh configuration" in `~/.freshell-work`).
 *
 * A `~/.freshell-<id>` directory proves a profile ran here; the picker
 * launcher's own userData dir lives under appData, NOT homedir. Match ONLY
 * directories whose suffix is a valid profile id — anything else in home
 * resembling `.freshell-*` (backups, thirds' dumps, tarballs, the port's
 * oracle seed dirs) must not flip the Default boot into a server-owner.
 */
export function hasNamedProfileState(
  listHomeDirs: () => string[],
): boolean {
  return listHomeDirs().some((name) => {
    const m = /^\.freshell-(.+)$/.exec(name)
    return m !== null && PROFILE_ID_PATTERN.test(m[1])
  })
}

/**
 * Canonical server-ownership gate for a boot. A boot OWNS its server when:
 *   1. it is a named profile, OR
 *   2. the registry names any named profile (multi-profile install), OR
 *   3. the registry could not be read (fail closed: a broken registry must
 *      never re-enable neighbor-server adoption), OR
 *   4. a named-profile state dir exists on disk (covers unlisted ids and a
 *      deleted-after-use registry).
 * Anything else is a legacy single-profile install and keeps historical
 * discovery-based behavior.
 */
export function computeOwnsServer(options: {
  profileId: string
  registry: RegistryReadResult
  listHomeDirsWithState: () => string[]
}): boolean {
  if (options.profileId !== DEFAULT_PROFILE_ID) return true
  if (options.registry.error !== undefined) return true
  if (options.registry.profiles.length > 0) return true
  return hasNamedProfileState(options.listHomeDirsWithState)
}
