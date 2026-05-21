export class FreshAgentApiContractError extends Error {
  readonly code = 'FRESH_AGENT_CONTRACT_PARSE_FAILED' as const

  constructor(
    message: string,
    readonly details: unknown,
  ) {
    super(message)
    this.name = 'FreshAgentApiContractError'
  }
}
