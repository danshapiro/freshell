import { FRESH_AGENT_CONTRACT_SCHEMA_NAMES } from '../../../shared/fresh-agent-contract.js'

export type FreshAgentContractTraceEntry = {
  schema: typeof FRESH_AGENT_CONTRACT_SCHEMA_NAMES[number]
  producers: readonly string[]
  serverParser: string
  clientParser: string
  stateOwner: string
  uiConsumer: string
  fixtures: readonly string[]
  tests: readonly string[]
}

export const FRESH_AGENT_CONTRACT_TRACEABILITY: readonly FreshAgentContractTraceEntry[] =
  FRESH_AGENT_CONTRACT_SCHEMA_NAMES.map((schema) => ({
    schema,
    producers: [
      'server/fresh-agent/adapters/claude/normalize.ts',
      'server/fresh-agent/adapters/codex/normalize.ts',
    ],
    serverParser: 'server/fresh-agent/runtime-manager.ts',
    clientParser: 'src/lib/api.ts',
    stateOwner: 'src/store/freshAgentSlice.ts',
    uiConsumer: 'src/components/fresh-agent/FreshAgentView.tsx',
    fixtures: [
      'test/fixtures/fresh-agent/claude/contract-fixtures.ts',
      'test/fixtures/fresh-agent/codex/contract-fixtures.ts',
    ],
    tests: [
      'test/unit/shared/fresh-agent-contract.test.ts',
      'test/unit/shared/fresh-agent-contract-traceability.test.ts',
    ],
  }))
