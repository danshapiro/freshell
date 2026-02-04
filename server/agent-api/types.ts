export type AgentStatus = 'ok' | 'approx' | 'ignored' | 'error'
export type AgentResponse<T = unknown> = {
  status: AgentStatus
  message?: string
  data?: T
  resolvedTarget?: { tabId?: string; paneId?: string; terminalId?: string }
}
