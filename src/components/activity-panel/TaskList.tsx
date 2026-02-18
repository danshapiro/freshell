import { Check, Circle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ActivityTask } from '@/store/activityPanelTypes'

interface TaskListProps {
  tasks: ActivityTask[]
}

function TaskStatusIcon({ status }: { status: ActivityTask['status'] }) {
  switch (status) {
    case 'completed':
      return <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
    case 'in_progress':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-spin" />
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
  }
}

export default function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) {
    return null
  }

  return (
    <div className="space-y-1 px-3 py-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          className={cn(
            'flex items-center gap-2 py-1 text-xs',
            task.status === 'completed' && 'opacity-50',
          )}
        >
          <TaskStatusIcon status={task.status} />
          <span className="truncate">
            {task.status === 'in_progress' && task.activeForm
              ? task.activeForm
              : task.subject}
          </span>
        </div>
      ))}
    </div>
  )
}
