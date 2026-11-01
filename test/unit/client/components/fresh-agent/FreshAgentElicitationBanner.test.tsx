import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FreshAgentElicitationBanner from '@/components/fresh-agent/FreshAgentElicitationBanner'
import type { FreshAgentPendingElicitation } from '@shared/fresh-agent-contract'

afterEach(cleanup)
const base: FreshAgentPendingElicitation = { requestId: '41', mode: 'form', serverName: 'contract', message: 'A native form' }

it('sends primitive and enum-array values with their exact native field IDs', () => {
  const onRespond = vi.fn()
  render(<FreshAgentElicitationBanner request={{ ...base, fields: [
    { id: 'token-id', title: 'Token', type: 'string', required: true, secret: true, default: 'do not restore this default' },
    { id: 'count-id', title: 'Count', type: 'integer', required: true, minimum: 1, maximum: 5 },
    { id: 'enabled-id', title: 'Enabled', type: 'boolean', required: true },
    { id: 'color-id', title: 'Color', type: 'string', required: true, choices: [{ value: 'blue,green', label: 'Blue and green' }] },
    { id: 'colors-id', title: 'Colors', type: 'array', required: true, choices: [{ value: 'blue', label: 'Blue' }, { value: 'green', label: 'Green' }] },
  ] }} onRespond={onRespond} />)
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password')
  expect(screen.getByLabelText('Token')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: ' exact, token! ' } })
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText('Enabled'), { target: { value: 'false' } })
  fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'blue,green' } })
  const colors = screen.getByLabelText('Colors') as HTMLSelectElement
  colors.options[0].selected = true
  colors.options[1].selected = true
  fireEvent.change(colors)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onRespond).toHaveBeenCalledWith('accept', { 'token-id': ' exact, token! ', 'count-id': 3, 'enabled-id': false, 'color-id': 'blue,green', 'colors-id': ['blue', 'green'] })
})

it('opening a URL does not accept it; each explicit action sends null content', () => {
  const onRespond = vi.fn()
  render(<FreshAgentElicitationBanner request={{ ...base, mode: 'url', url: 'https://example.com/verify', elicitationId: 'public-url-id' }} onRespond={onRespond} />)
  fireEvent.click(screen.getByRole('link', { name: 'Open contract page' }))
  expect(onRespond).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onRespond.mock.calls).toEqual([['accept', null], ['decline', null], ['cancel', null]])
})

it('does not submit required or out-of-range values', () => {
  const onRespond = vi.fn()
  render(<FreshAgentElicitationBanner request={{ ...base, fields: [{ id: 'count', title: 'Count', type: 'integer', required: true, minimum: 1, maximum: 5 }] }} onRespond={onRespond} />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onRespond).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '8' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onRespond).not.toHaveBeenCalled()
})

it('clears optional boolean and enum choices without silently retaining an old answer', () => {
  const onRespond = vi.fn()
  render(<FreshAgentElicitationBanner request={{ ...base, fields: [
    { id: 'optional-bool', title: 'Enabled', type: 'boolean', required: false },
    { id: 'optional-enum', title: 'Color', type: 'string', required: false, choices: [{ value: 'blue', label: 'Blue' }] },
    { id: 'optional-array', title: 'Colors', type: 'array', required: false, choices: [{ value: 'blue', label: 'Blue' }] },
  ] }} onRespond={onRespond} />)
  fireEvent.change(screen.getByLabelText('Enabled'), { target: { value: 'true' } })
  fireEvent.change(screen.getByLabelText('Enabled'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'blue' } })
  fireEvent.change(screen.getByLabelText('Color'), { target: { value: '' } })
  const colors = screen.getByLabelText('Colors') as HTMLSelectElement
  colors.options[0].selected = true
  fireEvent.change(colors)
  colors.options[0].selected = false
  fireEvent.change(colors)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onRespond).toHaveBeenCalledWith('accept', {})
})


it('keeps a date-time answer with its explicit UTC zone as the native string', () => {
  const onRespond = vi.fn()
  render(<FreshAgentElicitationBanner request={{ ...base, fields: [{ id: 'time', title: 'When', type: 'string', required: true, format: 'date-time' }] }} onRespond={onRespond} />)
  fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-10-26T10:30:00Z' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onRespond).toHaveBeenCalledWith('accept', { time: '2026-10-26T10:30:00Z' })
})
