import { test, expect } from '../helpers/fixtures.js'

test.describe('Editor Pane', () => {
  // Helper: create an editor pane via context menu split + picker.
  // Context menu on terminal shows "Split horizontally" (role="menuitem").
  // PanePicker buttons have aria-label matching the label text.
  async function createEditorPane(page: any) {
    const termContainer = page.locator('.xterm').first()
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()

    // The new pane shows the PanePicker; click "Editor" (aria-label="Editor")
    const editorButton = page.getByRole('button', { name: /^Editor$/i })
    await expect(editorButton).toBeVisible({ timeout: 10_000 })
    await editorButton.click()

    // Wait for the editor pane to render (has data-testid="editor-pane")
    await page.locator('[data-testid="editor-pane"]').waitFor({ state: 'visible', timeout: 15_000 })
  }

  test('opens editor pane via pane picker', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await createEditorPane(page)

    // Verify the pane layout includes an editor leaf
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')

    const hasEditor = layout.children.some((c: any) =>
      c.type === 'leaf' && c.content?.kind === 'editor'
    )
    expect(hasEditor).toBe(true)
  })

  test('editor pane has path input and open button', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await createEditorPane(page)

    // EditorToolbar renders a path input with placeholder="Enter file path..."
    const pathInput = page.getByPlaceholder('Enter file path...')
    await expect(pathInput).toBeVisible()

    // Open file picker button: title="Open file picker"
    const openButton = page.locator('button[title="Open file picker"]')
    await expect(openButton).toBeVisible()
  })

  test('editor supports text input', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await createEditorPane(page)

    // When first created with no file, the editor shows an empty state.
    // Set content via harness dispatch to load Monaco with a scratch pad.
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    const editorPane = layout.children?.find((c: any) => c.content?.kind === 'editor')
    expect(editorPane).toBeTruthy()

    await page.evaluate(({ tabId, paneId }: { tabId: string, paneId: string }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId,
          content: {
            kind: 'editor',
            filePath: null,
            language: 'plaintext',
            content: '',
            readOnly: false,
            viewMode: 'source',
          },
        },
      })
    }, { tabId: activeTabId!, paneId: editorPane!.id })

    // Monaco should now be visible
    const monaco = page.locator('.monaco-editor')
    await expect(monaco).toBeVisible({ timeout: 10_000 })

    // Click into Monaco and type
    await monaco.click()
    await page.keyboard.type('Hello from E2E test')

    // Verify text appears in Monaco
    await expect(page.locator('.monaco-editor').getByText('Hello from E2E test')).toBeVisible({ timeout: 5_000 })
  })

  test('editor source/preview toggle for markdown', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await createEditorPane(page)

    // Load a markdown file to enable the preview toggle.
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    const editorPane = layout.children?.find((c: any) => c.content?.kind === 'editor')

    // If no editor pane found in layout, skip (shouldn't happen after createEditorPane)
    expect(editorPane).toBeTruthy()

    // Set the pane content to markdown via harness dispatch
    await page.evaluate(({ tabId, paneId }: { tabId: string, paneId: string }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId,
          content: {
            kind: 'editor',
            filePath: 'test.md',
            language: 'markdown',
            content: '# Hello\n\nWorld',
            readOnly: false,
            viewMode: 'source',
          },
        },
      })
    }, { tabId: activeTabId!, paneId: editorPane!.id })

    await page.waitForTimeout(500)

    // Preview toggle should now be visible with aria-label="Preview"
    const previewToggle = page.getByRole('button', { name: 'Preview' })
    await expect(previewToggle).toBeVisible({ timeout: 5_000 })
    await previewToggle.click()

    // After toggling, the button should change to aria-label="Source"
    const sourceToggle = page.getByRole('button', { name: 'Source' })
    await expect(sourceToggle).toBeVisible({ timeout: 3_000 })

    // Toggle back to source
    await sourceToggle.click()
    await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible({ timeout: 3_000 })
  })

  test('editor pane preserves content across tab switches', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await createEditorPane(page)

    // Set editor content via harness to get Monaco loaded
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    const editorPane = layout.children?.find((c: any) => c.content?.kind === 'editor')
    expect(editorPane).toBeTruthy()

    const marker = `e2e-persist-test-${Date.now()}`

    await page.evaluate(({ tabId, paneId, content }: { tabId: string, paneId: string, content: string }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId,
          content: {
            kind: 'editor',
            filePath: null,
            language: 'plaintext',
            content,
            readOnly: false,
            viewMode: 'source',
          },
        },
      })
    }, { tabId: activeTabId!, paneId: editorPane!.id, content: marker })

    // Monaco should show the marker content
    const monaco = page.locator('.monaco-editor')
    await expect(monaco).toBeVisible({ timeout: 10_000 })
    await expect(monaco.getByText(marker)).toBeVisible({ timeout: 5_000 })

    // Create a new tab and switch to it
    const addTabButton = page.getByRole('button', { name: /new tab|add tab/i })
    await addTabButton.click()
    await harness.waitForTabCount(2)

    // Switch back to the first tab
    await page.getByRole('tab').first().click()
    await page.waitForTimeout(500)

    // Editor content should still contain the marker
    await expect(page.locator('.monaco-editor').getByText(marker)).toBeVisible({ timeout: 5_000 })
  })
})
