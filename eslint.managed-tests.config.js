import parser from '@typescript-eslint/parser'
import plugin from '@typescript-eslint/eslint-plugin'

const managed = [
  "scripts/testing/owned-cleanup.ts",
  "test/e2e-browser/helpers/selection-nonvacuity.test.ts",
  "test/e2e-browser/helpers/managed-runtime.ts",
  "test/e2e-browser/helpers/external-managed-runtime.ts",
  "test/e2e-browser/helpers/runtime-chaos-evidence.ts",
  "test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts",
  "test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts",
  "test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts",
  "test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts",
  "test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts",
  "test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts",
  "test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts",
  "test/e2e-browser/specs/runtime-chaos-rust.spec.ts",
  "test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts",
  "test/e2e-browser/specs/runtime-external-target-smoke-rust.spec.ts",
  "test/integration/server/managed-provider-parity.test.ts",
  "test/integration/server/fresh-agent-parity.test.ts"
]
const runtime = [
  "test/runtime/managed-fixture-history.ts",
  "scripts/testing/qualification-observations.ts",
  "scripts/testing/task002-retained-fixture.ts",
  "scripts/testing/runtime-external-browser.ts",
  "scripts/testing/runtime-sandbox.ts",
  "scripts/testing/task007-destructive-sandbox.ts",
  "scripts/testing/runtime-test-broker.ts",
  "scripts/testing/runtime-provider-qualification.ts",
  "scripts/testing/runtime-fresh-agent-qualification.ts",
  "scripts/testing/runtime-landing-campaign.ts"
]
const typed = (files, project) => ({
  files,
  languageOptions: { parser, parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
  plugins: { '@typescript-eslint': plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
    '@typescript-eslint/no-misused-promises': 'error',
  },
})

export default [
  { ignores: ['**/*', '!**/', ...[...managed, ...runtime].map((file) => `!${file}`)] },
  typed(managed, './tsconfig.managed-tests.json'),
  typed(runtime, './tsconfig.runtime.json'),
]
