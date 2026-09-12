import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MachineChooser } from '@/components/MachineChooser'

const MACHINES = [
  {
    id: 'machine-desktop',
    label: 'DANDESKTOP',
    createdAt: 1_789_171_200_000,
    lastSeenAt: 1_789_171_200_000,
  },
  {
    id: 'machine-garage',
    label: 'garageserver',
    createdAt: 1_789_171_200_000,
    lastSeenAt: 1_789_171_200_000,
  },
]

describe('MachineChooser', () => {
  afterEach(() => cleanup())

  it('lists existing machines and lets the user choose one accessibly', async () => {
    const user = userEvent.setup()
    const onSelectMachine = vi.fn().mockResolvedValue(undefined)

    render(
      <MachineChooser
        machines={MACHINES}
        suggestedLabel="Windows device"
        onSelectMachine={onSelectMachine}
        onAddMachine={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: /choose a machine/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /use dandesktop/i }))
    expect(onSelectMachine).toHaveBeenCalledWith(MACHINES[0])
  })

  it('offers Add this machine with an editable suggested label', async () => {
    const user = userEvent.setup()
    const onAddMachine = vi.fn().mockResolvedValue(undefined)

    render(
      <MachineChooser
        machines={MACHINES}
        suggestedLabel="Windows device"
        onSelectMachine={vi.fn()}
        onAddMachine={onAddMachine}
      />,
    )

    const name = screen.getByRole('textbox', { name: /new machine name/i })
    expect(name).toHaveValue('Windows device')
    await user.clear(name)
    await user.type(name, 'Laptop')
    await user.click(screen.getByRole('button', { name: /^add this machine$/i }))

    expect(onAddMachine).toHaveBeenCalledWith('Laptop')
  })
})
