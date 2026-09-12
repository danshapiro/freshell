import { useState } from 'react'
import type { Machine } from '@/lib/machine-identity'
import { Button } from '@/components/ui/button'

const HEADING_ID = 'machine-chooser-heading'

export function MachineChooser({
  machines,
  suggestedLabel,
  onSelectMachine,
  onAddMachine,
}: {
  machines: Machine[]
  suggestedLabel: string
  onSelectMachine: (machine: Machine) => Promise<void> | void
  onAddMachine: (label: string) => Promise<void> | void
}) {
  const [newMachineName, setNewMachineName] = useState(suggestedLabel)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const run = async (operation: () => Promise<void> | void) => {
    setPending(true)
    setError(undefined)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not choose a machine')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={HEADING_ID}
        className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg"
      >
        <h1 id={HEADING_ID} className="text-xl font-semibold">Choose a machine</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This server already has saved workspaces. Choose the one you want to open, or add this computer as a new machine.
        </p>

        <div className="mt-5 space-y-2" aria-label="Existing machines">
          {machines.map((machine) => (
            <Button
              key={machine.id}
              type="button"
              variant="outline"
              className="h-auto w-full justify-between px-4 py-3 text-left"
              disabled={pending}
              onClick={() => void run(() => onSelectMachine(machine))}
            >
              <span>{machine.label}</span>
              <span className="text-xs text-muted-foreground">Use {machine.label}</span>
            </Button>
          ))}
        </div>

        <form
          className="mt-6 border-t border-border pt-5"
          onSubmit={(event) => {
            event.preventDefault()
            const label = newMachineName.trim()
            if (!label) {
              setError('Enter a name for this machine')
              return
            }
            void run(() => onAddMachine(label))
          }}
        >
          <label htmlFor="new-machine-name" className="block text-sm font-medium">
            New machine name
          </label>
          <input
            id="new-machine-name"
            type="text"
            value={newMachineName}
            disabled={pending}
            onChange={(event) => setNewMachineName(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
          <div className="mt-3 flex justify-end">
            <Button type="submit" disabled={pending}>Add this machine</Button>
          </div>
        </form>
      </section>
    </main>
  )
}
