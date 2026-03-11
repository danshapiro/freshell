import { describe, it, expect } from 'vitest'
import { getOpencodeEnvOverrides, resolveOpencodeLaunchModel } from '../../../server/opencode-launch'

describe('opencode launch helpers', () => {
  it('maps GEMINI_API_KEY to GOOGLE_GENERATIVE_AI_API_KEY', () => {
    expect(getOpencodeEnvOverrides({
      GEMINI_API_KEY: 'gemini-key',
    })).toEqual({
      GOOGLE_GENERATIVE_AI_API_KEY: 'gemini-key',
    })
  })

  it('preserves an explicit GOOGLE_GENERATIVE_AI_API_KEY', () => {
    expect(getOpencodeEnvOverrides({
      GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
      GEMINI_API_KEY: 'gemini-key',
    })).toEqual({})
  })

  it('defaults to the google model when Google credentials are available through GEMINI_API_KEY', () => {
    expect(resolveOpencodeLaunchModel(undefined, {
      GEMINI_API_KEY: 'gemini-key',
    })).toBe('google/gemini-3-pro-preview')
  })

  it('falls back to the OpenAI model when Google credentials are missing', () => {
    expect(resolveOpencodeLaunchModel(undefined, {
      OPENAI_API_KEY: 'openai-key',
    })).toBe('openai/gpt-5')
  })

  it('falls back to the Anthropic model when only Anthropic credentials are available', () => {
    expect(resolveOpencodeLaunchModel(undefined, {
      ANTHROPIC_API_KEY: 'anthropic-key',
    })).toBe('anthropic/claude-sonnet-4-5')
  })

  it('preserves an explicitly configured model', () => {
    expect(resolveOpencodeLaunchModel('openai/gpt-5-mini', {
      GEMINI_API_KEY: 'gemini-key',
      OPENAI_API_KEY: 'openai-key',
    })).toBe('openai/gpt-5-mini')
  })
})
