import type { AgentResponse } from './types.js'

export const ok = <T>(data?: T, message?: string): AgentResponse<T> => ({ status: 'ok', data, message })
export const approx = <T>(data?: T, message?: string): AgentResponse<T> => ({ status: 'approx', data, message })
export const ignored = (message: string): AgentResponse => ({ status: 'ignored', message })
export const fail = (message: string): AgentResponse => ({ status: 'error', message })
