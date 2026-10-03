import { test } from '../helpers/fixtures.js'
import {
  activityGeneratesOneSharedShortName,
  activityGeneratesOneSharedShortNameViaOneCliProxy,
  everyApplicableRenameEntryConverges,
  manualNameSurvivesLateGenerationAndSwitch,
  pendingNameSurvivesMaterializeAndReopen,
  twoBrowsersAndAnloadedHistoryConverge,
} from '../helpers/unified-agent-names-modes.js'

// UNIFIED AGENT NAMES (plan Task 8) — the [freshcodex] slice of the six-mode
// acceptance, split per coordinator ruling (task-008-decisions.md,
// Ruling 1): cloud packing is per spec FILE, and one 36-case file starved
// a single 2-CPU Cloud Run task. The five journey BODIES live in the
// shared modes helper; the test wrappers are declared HERE so Playwright
// attributes each case to this file (the cloud shard discovery matches
// spec files by the tests' reported location). The case names are the
// plan's, unchanged.

test.setTimeout(360_000)

test.describe('[freshcodex] unified agent names', () => {
  test('activity uses the OneCLI route before the direct fallback key', async ({ browser }) => {
    await activityGeneratesOneSharedShortNameViaOneCliProxy('freshcodex', browser)
  })

  test('activity generates one shared short name', async ({ browser }) => {
    await activityGeneratesOneSharedShortName('freshcodex', browser)
  })

  test('every applicable rename entry converges', async ({ browser }) => {
    // The broadest case: NINE rename entries, each verified on FIVE
    // surfaces — the bounded per-surface waits accumulate legitimately,
    // so this case gets double the file's default budget.
    test.setTimeout(480_000)
    await everyApplicableRenameEntryConverges('freshcodex', browser)
  })

  test('pending name survives materialize and reopen', async ({ browser }) => {
    // The pre-durable rename + materialize + reopen chain rides the
    // container's cold-fs bind tail (the verified pending->durable bind
    // converges in 60-120s there vs seconds locally): the cold attempt
    // legitimately sums every convergence window (~450s observed across
    // the five expectSharedName surfaces + the reopen chain) — 600s
    // leaves real headroom without masking anything (a correctness
    // failure still fails its own assertion long before this budget).
    test.setTimeout(600_000)
    await pendingNameSurvivesMaterializeAndReopen('freshcodex', browser)
  })

  test('two browsers and an unloaded history page converge', async ({ browser }) => {
    // The longest journey (two live browsers + an unloaded history page +
    // three convergence windows): the 360s file ceiling has no headroom
    // under a full local 3-worker lane — the same per-case treatment the
    // rename-entry case gets.
    test.setTimeout(480_000)
    await twoBrowsersAndAnloadedHistoryConverge('freshcodex', browser)
  })

  test('manual name survives late generation and conversation switch', async ({ browser }) => {
    await manualNameSurvivesLateGenerationAndSwitch('freshcodex', browser)
  })
})
