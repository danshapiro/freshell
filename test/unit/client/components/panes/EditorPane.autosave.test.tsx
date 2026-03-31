import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e: any) => onChange?.(e.target.value)}
    />
  )
  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})

global.fetch = vi.fn()

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })

describe('EditorPane auto-save', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    vi.useFakeTimers()
    store = createMockStore()
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/api/files/stat')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            exists: true,
            size: 100,
            modifiedAt: '2026-01-01T00:00:00.000Z',
          })),
          json: () => Promise.resolve({
            exists: true,
            size: 100,
            modifiedAt: '2026-01-01T00:00:00.000Z',
          }),
        } as Response)
      }
      if (urlStr.includes('/api/files/read')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            content: 'initial',
            size: 7,
            modifiedAt: '2026-01-01T00:00:00.000Z',
            filePath: '/test.ts',
          })),
          json: () => Promise.resolve({
            content: 'initial',
            size: 7,
            modifiedAt: '2026-01-01T00:00:00.000Z',
            filePath: '/test.ts',
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: '2026-01-01T00:00:00.000Z' })),
        json: () => Promise.resolve({ success: true, modifiedAt: '2026-01-01T00:00:00.000Z' }),
      } as Response)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('auto-saves after 5 seconds of inactivity', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    const editor = screen.getByTestId('monaco-mock')
    const writeCalls = () => vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'changed content' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(writeCalls()).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(writeCalls().length).toBeGreaterThanOrEqual(1)
    expect(writeCalls()[0]).toEqual([
      '/api/files/write',
      expect.objectContaining({ method: 'POST' }),
    ])
  })

  it('does not auto-save scratch pads (no filePath)', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content="scratch content"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  it('resets debounce timer on each change', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    const editor = screen.getByTestId('monaco-mock')
    const writeCalls = () => vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'first change' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'second change' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(writeCalls()).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(writeCalls()).toHaveLength(1)
  })

  it('sends correct content in auto-save request', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    const editor = screen.getByTestId('monaco-mock')

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'updated content' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )
    expect(writeCalls.length).toBeGreaterThanOrEqual(1)
    expect(writeCalls[0]).toEqual([
      '/api/files/write',
      expect.objectContaining({ method: 'POST' }),
    ])

    const [, options] = writeCalls[0]
    expect(options?.body).toBeDefined()
    const body = JSON.parse(options?.body as string)
    expect(body).toEqual({
      path: '/test.ts',
      content: 'updated content',
    })
  })

  it('does not auto-save when readOnly is true', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={true}
          content="read only content"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )
    expect(writeCalls).toHaveLength(0)
  })

  it('cleans up timer on unmount', async () => {
    const { unmount } = render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')

    await act(async () => {
      fireEvent.change(editor, { target: { value: 'changed' } })
    })

    unmount()

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    const writeCalls = vi.mocked(fetch).mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
    )
    expect(writeCalls).toHaveLength(0)
  })

  describe('stat-polling auto-sync', () => {
    it('silently reloads when file changes on disk and buffer is clean', async () => {
      const initialMtime = '2026-03-29T12:00:00.000Z'
      const changedMtime = '2026-03-29T12:00:05.000Z'

      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 16,
              modifiedAt: changedMtime,
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 16,
              modifiedAt: changedMtime,
            }),
          } as Response)
        }
        if (urlStr.includes('/api/files/read')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              content: 'changed on disk',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            })),
            json: () => Promise.resolve({
              content: 'changed on disk',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: initialMtime })),
          json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
        } as Response)
      })

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/test.ts"
            language="typescript"
            readOnly={false}
            content="initial content"
            viewMode="source"
          />
        </Provider>
      )

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(screen.getByTestId('monaco-mock')).toHaveValue('changed on disk')
    })

    it('shows conflict banner when file changes on disk and buffer is dirty', async () => {
      const initialMtime = '2026-03-29T12:00:00.000Z'
      const changedMtime = '2026-03-29T12:00:05.000Z'

      let statCallCount = 0
      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          statCallCount++
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 20,
              modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 20,
              modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
            }),
          } as Response)
        }
        if (urlStr.includes('/api/files/read')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            })),
            json: () => Promise.resolve({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: initialMtime })),
          json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
        } as Response)
      })

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/test.ts"
            language="typescript"
            readOnly={false}
            content="initial content"
            viewMode="source"
          />
        </Provider>
      )

      const editor = screen.getByTestId('monaco-mock')
      await act(async () => {
        fireEvent.change(editor, { target: { value: 'local edit' } })
      })

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(screen.getByText(/file changed on disk/i)).toBeInTheDocument()
    })

    it('resolves conflict by reloading from disk', async () => {
      const initialMtime = '2026-03-29T12:00:00.000Z'
      const changedMtime = '2026-03-29T12:00:05.000Z'

      let statCallCount = 0
      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          statCallCount++
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 20,
              modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 20,
              modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
            }),
          } as Response)
        }
        if (urlStr.includes('/api/files/read')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            })),
            json: () => Promise.resolve({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: initialMtime })),
          json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
        } as Response)
      })

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/test.ts"
            language="typescript"
            readOnly={false}
            content="initial content"
            viewMode="source"
          />
        </Provider>
      )

      const editor = screen.getByTestId('monaco-mock')
      await act(async () => {
        fireEvent.change(editor, { target: { value: 'local edit' } })
      })

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      const reloadButton = screen.getByRole('button', { name: /reload/i })
      await act(async () => {
        fireEvent.click(reloadButton)
      })

      expect(screen.getByTestId('monaco-mock')).toHaveValue('external change')
      expect(screen.queryByText(/file changed on disk/i)).not.toBeInTheDocument()
    })

    it('cancels pending auto-save timer when conflict is reloaded from disk', async () => {
      const initialMtime = '2026-03-29T12:00:00.000Z'
      const changedMtime = '2026-03-29T12:00:05.000Z'

      let statCallCount = 0
      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          statCallCount++
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 20,
              modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 20,
              modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
            }),
          } as Response)
        }
        if (urlStr.includes('/api/files/read')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            })),
            json: () => Promise.resolve({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: initialMtime })),
          json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
        } as Response)
      })

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/test.ts"
            language="typescript"
            readOnly={false}
            content="initial content"
            viewMode="source"
          />
        </Provider>
      )

      const editor = screen.getByTestId('monaco-mock')
      await act(async () => {
        fireEvent.change(editor, { target: { value: 'local edit' } })
      })

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      const reloadButton = screen.getByRole('button', { name: /reload/i })
      await act(async () => {
        fireEvent.click(reloadButton)
      })

      const writeCallsAfter = vi.mocked(fetch).mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
      )

      await act(async () => {
        vi.advanceTimersByTime(10000)
      })

      const writeCallsLater = vi.mocked(fetch).mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
      )

      expect(writeCallsLater.length).toBe(writeCallsAfter.length)
    })

    it('keeps local edits after Keep Mine and does not mark buffer as clean', async () => {
      const initialMtime = '2026-03-29T12:00:00.000Z'
      const changedMtime = '2026-03-29T12:00:05.000Z'
      const secondChangeMtime = '2026-03-29T12:00:10.000Z'

      let statCallCount = 0
      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          statCallCount++
          const mtime = statCallCount <= 1 ? initialMtime : secondChangeMtime
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 20,
              modifiedAt: mtime,
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 20,
              modifiedAt: mtime,
            }),
          } as Response)
        }
        if (urlStr.includes('/api/files/read')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            })),
            json: () => Promise.resolve({
              content: 'external change',
              size: 16,
              modifiedAt: changedMtime,
              filePath: '/test.ts',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: initialMtime })),
          json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
        } as Response)
      })

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/test.ts"
            language="typescript"
            readOnly={false}
            content="initial content"
            viewMode="source"
          />
        </Provider>
      )

      const editor = screen.getByTestId('monaco-mock')
      await act(async () => {
        fireEvent.change(editor, { target: { value: 'local edit' } })
      })

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(screen.getByText(/file changed on disk/i)).toBeInTheDocument()

      const keepMineButton = screen.getByRole('button', { name: /keep/i })
      await act(async () => {
        fireEvent.click(keepMineButton)
      })

      expect(screen.queryByText(/file changed on disk/i)).not.toBeInTheDocument()
      expect(screen.getByTestId('monaco-mock')).toHaveValue('local edit')

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(screen.getByText(/file changed on disk/i)).toBeInTheDocument()
    })

    it('stops polling when pane is unmounted', async () => {
      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 16,
              modifiedAt: '2026-03-29T12:00:00.000Z',
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 16,
              modifiedAt: '2026-03-29T12:00:00.000Z',
            }),
          } as Response)
        }
        if (urlStr.includes('/api/files/read')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              content: 'initial content',
              size: 16,
              modifiedAt: '2026-03-29T12:00:00.000Z',
              filePath: '/test.ts',
            })),
            json: () => Promise.resolve({
              content: 'initial content',
              size: 16,
              modifiedAt: '2026-03-29T12:00:00.000Z',
              filePath: '/test.ts',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true })),
          json: () => Promise.resolve({ success: true }),
        } as Response)
      })

      const { unmount } = render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath="/test.ts"
            language="typescript"
            readOnly={false}
            content="initial content"
            viewMode="source"
          />
        </Provider>
      )

      unmount()

      const fetchCallsBefore = vi.mocked(fetch).mock.calls.length
      await act(async () => {
        vi.advanceTimersByTime(10000)
      })

      const fetchCallsAfter = vi.mocked(fetch).mock.calls.length
      expect(fetchCallsAfter).toBe(fetchCallsBefore)
    })

    it('does not poll for scratch pads (no filePath)', async () => {
      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content="scratch"
            viewMode="source"
          />
        </Provider>
      )

      await act(async () => {
        vi.advanceTimersByTime(10000)
      })

      const statCalls = vi.mocked(fetch).mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/stat')
      )
      expect(statCalls).toHaveLength(0)
    })

    it('does not poll for native file-picker panes', async () => {
      const fileContent = 'native file content'
      const mockFile = {
        text: () => Promise.resolve(fileContent),
        name: 'native-file.txt',
      }
      const mockHandle = {
        name: 'native-file.txt',
        getFile: () => Promise.resolve(mockFile),
        createWritable: undefined,
      }

      const originalPicker = (window as any).showOpenFilePicker
      ;(window as any).showOpenFilePicker = vi.fn().mockResolvedValue([mockHandle])

      vi.mocked(fetch).mockImplementation((url: string | Request | URL) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('/api/files/stat')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              exists: true,
              size: 100,
              modifiedAt: '2026-03-29T12:00:00.000Z',
            })),
            json: () => Promise.resolve({
              exists: true,
              size: 100,
              modifiedAt: '2026-03-29T12:00:00.000Z',
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true })),
          json: () => Promise.resolve({ success: true }),
        } as Response)
      })

      render(
        <Provider store={store}>
          <EditorPane
            paneId="pane-1"
            tabId="tab-1"
            filePath={null}
            language={null}
            readOnly={false}
            content=""
            viewMode="source"
          />
        </Provider>
      )

      const pickerButton = screen.getByTitle('Open file picker')
      await act(async () => {
        fireEvent.click(pickerButton)
      })

      await act(async () => {
        vi.advanceTimersByTime(0)
      })

      expect(screen.getByTestId('monaco-mock')).toHaveValue(fileContent)

      vi.mocked(fetch).mockClear()

      await act(async () => {
        vi.advanceTimersByTime(10000)
      })

      const nativeStatCalls = vi.mocked(fetch).mock.calls.filter(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/stat')
      )
      expect(nativeStatCalls).toHaveLength(0)

      ;(window as any).showOpenFilePicker = originalPicker
    })
  })
})
