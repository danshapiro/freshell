import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

describe('FreshAgentTranscript', () => {
  it('renders normalized text turns', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            items: [{ id: 'item-1', kind: 'text', text: 'Hello from Fresh Agent' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('Assistant')).toBeInTheDocument()
    expect(screen.getByText('Hello from Fresh Agent')).toBeInTheDocument()
  })
})
