import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { SidebarItem } from '@/components/Sidebar'

function renderSidebarItem(item: any) {
  const store = configureStore({
    reducer: {
      extensions: (state = { entries: [] }) => state,
    },
  })

  return render(
    <Provider store={store}>
      <SidebarItem
        item={item}
        isActiveTab={false}
        showProjectBadge={false}
        onClick={() => {}}
      />
    </Provider>,
  )
}

describe('SidebarItem running state', () => {
  it('renders a running detached session as actionable but not open', () => {
    renderSidebarItem({
      id: 'session-codex-codex-live-1',
      provider: 'codex',
      sessionType: 'codex',
      sessionId: 'codex-live-1',
      title: 'Live Codex',
      timestamp: 1_700,
      hasTab: false,
      isRunning: true,
      runningTerminalId: 'term-codex-1',
      hasTitle: true,
    })

    const button = screen.getByRole('button', { name: /live codex/i })
    expect(button).toHaveAttribute('data-is-running', 'true')
    expect(button).toHaveAttribute('data-has-tab', 'false')
    expect(button).toHaveAttribute('data-running-terminal-id', 'term-codex-1')
    expect(button.querySelector('svg')).toHaveClass('text-muted-foreground')
    expect(button.querySelector('svg')).not.toHaveClass('text-success')
  })

  it('renders an open session as green when not busy', () => {
    renderSidebarItem({
      id: 'session-codex-codex-open-1',
      provider: 'codex',
      sessionType: 'codex',
      sessionId: 'codex-open-1',
      title: 'Open Codex',
      timestamp: 1_700,
      hasTab: true,
      isRunning: true,
      runningTerminalId: 'term-codex-1',
      hasTitle: true,
    })

    const button = screen.getByRole('button', { name: /open codex/i })
    expect(button).toHaveAttribute('data-has-tab', 'true')
    expect(button.querySelector('svg')).toHaveClass('text-success')
  })

  it('renders an empty running-terminal attribute when detached session is not running', () => {
    renderSidebarItem({
      id: 'session-codex-codex-idle-1',
      provider: 'codex',
      sessionType: 'codex',
      sessionId: 'codex-idle-1',
      title: 'Idle Codex',
      timestamp: 1_700,
      hasTab: false,
      isRunning: false,
      hasTitle: true,
    })

    const button = screen.getByRole('button', { name: /idle codex/i })
    expect(button).toHaveAttribute('data-is-running', 'false')
    expect(button).toHaveAttribute('data-running-terminal-id', '')
  })
})
