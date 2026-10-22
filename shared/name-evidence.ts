/**
 * The shared default/derived name classifier: one definition of "this text
 * is a default or derived label, not a name a session earned".
 *
 * Twin of `crates/freshell-sessions/src/name_evidence.rs`. Both are pinned by
 * the same table, `test/fixtures/name-evidence/cases.json` (consumed by
 * `test/unit/shared/name-evidence.test.ts` and
 * `crates/freshell-sessions/tests/name_evidence.rs`), so they cannot drift.
 * Change the rules in both places and add the fixture rows that pin it.
 *
 * A name is default/derived when, after trimming, it is empty or:
 * - a generated tab label: `Tab <digits>` (exact case, one space);
 * - the basename of the known working directory (only when a cwd is given,
 *   so a caller without a folder recognizes only folder-free patterns);
 * - a provider or mode label (`Claude`, `Claude CLI`, `Codex`, `Codex CLI`,
 *   `OpenCode`, `Shell`, `Freshclaude`, `Freshcodex`, `Freshopencode`,
 *   `Kilroy`, `Gemini`, `Kimi`, `Amplifier`), optionally prefixed with
 *   `Recovered ` and/or suffixed with ` agent`, ASCII case-insensitive;
 * - one of the bare words `Recovered`, `Untitled`, `Tab` (case-insensitive);
 * - a provider placeholder title (`isProviderPlaceholderTitle`) for the
 *   context's provider (else its mode); with neither known, any provider's;
 * - text that opens with a tool wrapper tag (`<tag>` or `<tag ` for a tag in
 *   `SYSTEM_CONTEXT_LEAD_TAGS`). Only that leading-tag check is used: the
 *   rest of the server's system-context test would also flag real names such
 *   as `$ ls -la` or `1, 2, 3`.
 *
 * Trimming and case folding follow the Rust side exactly (Unicode
 * White_Space trimming, ASCII-only lowercasing), so non-ASCII input
 * classifies the same in both languages.
 */
import { basenameSegment } from './path-basename.js'

/**
 * What the caller knows about the target of a name. Every field is optional;
 * an unknown field only narrows what can be recognized (no cwd → no
 * folder-name rule), it never makes a real name look like a default.
 */
export type NameEvidenceContext = {
  /** The target's working directory; its basename is a derived label. */
  cwd?: string | null
  /** The session provider wire string (`claude`, `codex`, `opencode`). */
  provider?: string | null
  /** The pane/terminal mode; stands in for `provider` when that is unknown. */
  mode?: string | null
}

/**
 * Copy of the server's `SYSTEM_CONTEXT_LEAD_TAGS`
 * (`crates/freshell-sessions/src/text.rs`). The fixture's wrapper-tag rows
 * keep the two lists in step.
 */
const SYSTEM_CONTEXT_LEAD_TAGS: readonly string[] = [
  'environment_context',
  'system_context',
  'system',
  'context',
  'instructions',
  'user_instructions',
  'permissions',
  'collaboration_mode',
  'skills_instructions',
]

/** Provider and mode labels, lowercase; matched after an optional `recovered ` prefix / ` agent` suffix. */
const PROVIDER_OR_MODE_LABELS: ReadonlySet<string> = new Set([
  'claude',
  'claude cli',
  'codex',
  'codex cli',
  'opencode',
  'shell',
  'freshclaude',
  'freshcodex',
  'freshopencode',
  'kilroy',
  'gemini',
  'kimi',
  'amplifier',
])

const BARE_DEFAULT_WORDS: ReadonlySet<string> = new Set(['recovered', 'untitled', 'tab'])

/** Providers that mint placeholder titles of their own. */
const PLACEHOLDER_PROVIDERS: readonly string[] = ['opencode']

// Rust `char::is_whitespace` (Unicode White_Space). Not JS `\s`, which adds
// U+FEFF and leaves out U+0085.
const WHITESPACE_CLASS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const TRIM_RE = new RegExp(`^[${WHITESPACE_CLASS}]+|[${WHITESPACE_CLASS}]+$`, 'g')
const WHITESPACE_CHAR_RE = new RegExp(`^[${WHITESPACE_CLASS}]$`)

const TAB_NUMBER_RE = /^Tab [0-9]+$/
const OPENCODE_PLACEHOLDER_RE =
  /^(?:New session|Child session|New Session) - [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/

function trimWhitespace(text: string): string {
  return text.replace(TRIM_RE, '')
}

function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase())
}

/**
 * The client's generated tab label, `Tab <digits>`: exact case, one space,
 * ASCII digits, nothing else (the `^Tab \d+$` rule). Not trimmed.
 */
export function isTabNumberLabel(text: string): boolean {
  return TAB_NUMBER_RE.test(text)
}

/**
 * Whether `title` is a placeholder the given provider writes for a session it
 * has not named yet. Only OpenCode has them (`New session - <ISO>`,
 * `Child session - <ISO>`, legacy `New Session - <ISO>`). Not trimmed, so it
 * agrees with the server's directory-index predicate byte for byte.
 */
export function isProviderPlaceholderTitle(provider: string, title: string): boolean {
  return provider === 'opencode' && OPENCODE_PLACEHOLDER_RE.test(title)
}

/** Whether `name` is a default or derived label rather than a real name. */
export function isDefaultOrDerivedName(name: string, ctx: NameEvidenceContext = {}): boolean {
  const trimmed = trimWhitespace(name)
  return trimmed === ''
    || isTabNumberLabel(trimmed)
    || isCwdBasename(trimmed, ctx.cwd)
    || isProviderOrModeLabel(trimmed)
    || isPlaceholderForContext(trimmed, ctx)
    || startsWithContextTag(trimmed)
}

function isCwdBasename(name: string, cwd: string | null | undefined): boolean {
  if (cwd == null) return false
  return basenameSegment(cwd) === name
}

function isProviderOrModeLabel(name: string): boolean {
  const lower = asciiLowercase(name)
  if (BARE_DEFAULT_WORDS.has(lower)) return true
  let core = lower.startsWith('recovered ') ? lower.slice('recovered '.length) : lower
  core = core.endsWith(' agent') ? core.slice(0, -' agent'.length) : core
  return PROVIDER_OR_MODE_LABELS.has(core)
}

function isPlaceholderForContext(name: string, ctx: NameEvidenceContext): boolean {
  const provider = ctx.provider || ctx.mode
  if (provider) return isProviderPlaceholderTitle(provider, name)
  return PLACEHOLDER_PROVIDERS.some((candidate) => isProviderPlaceholderTitle(candidate, name))
}

function startsWithContextTag(text: string): boolean {
  const trimmed = trimWhitespace(text)
  if (!trimmed.startsWith('<')) return false
  const rest = trimmed.slice(1)
  // ASCII lowercasing keeps every UTF-16 offset, so `tag.length` indexes `rest` too.
  const lower = asciiLowercase(rest)
  return SYSTEM_CONTEXT_LEAD_TAGS.some((tag) => {
    if (!lower.startsWith(tag)) return false
    const next = rest.charAt(tag.length)
    return next === '>' || WHITESPACE_CHAR_RE.test(next)
  })
}
