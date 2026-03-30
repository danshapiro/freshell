# Fix Cross-Origin Iframe Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP screenshot tool capture actual browser pane content instead of a placeholder when the iframe points at a proxied localhost URL.

**Architecture:** The proxy router (`server/proxy-router.ts`) already makes localhost URLs same-origin by rewriting `http://localhost:PORT/path` to `/api/proxy/http/PORT/path`. However, many localhost services (Vite, Express, Next.js, etc.) send `X-Frame-Options` and/or `Content-Security-Policy` response headers that instruct the browser to refuse iframe embedding. Because the proxy forwards these headers verbatim, the browser blocks the iframe content, making `iframe.contentDocument` inaccessible. The fix strips these iframe-blocking headers from proxied responses so the browser renders the content in the iframe, which makes the existing `captureIframeReplacement` screenshot logic succeed (it already handles same-origin iframes correctly). No client-side code changes are needed since `captureIframeReplacement` already uses `html2canvas` on `iframe.contentDocument` when accessible.

**Tech Stack:** Node.js/Express (server), Vitest + supertest (tests), html2canvas (existing screenshot infra)

---

## Problem Analysis

When the MCP screenshot tool captures a browser pane that shows a proxied localhost URL:

1. `BrowserPane.tsx` converts `http://localhost:3000/` to `/api/proxy/http/3000/` via `buildHttpProxyUrl()` -- this makes it same-origin with Freshell.
2. The proxy at `server/proxy-router.ts` line 79 does: `res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)` -- forwarding ALL upstream headers.
3. Many dev servers send headers like:
   - `X-Frame-Options: DENY` or `X-Frame-Options: SAMEORIGIN` (the browser interprets SAMEORIGIN relative to the *response* origin, not the iframe parent, and with the proxy rewriting the origin, this can still block)
   - `Content-Security-Policy: frame-ancestors 'none'` or similar CSP directives that block iframe embedding
4. The browser refuses to render the iframe content, making `iframe.contentDocument` return `null`.
5. `captureIframeReplacement` in `ui-screenshot.ts` catches the null document at line 120 and falls through to the placeholder path (line 152).

The fix is purely server-side: strip the iframe-blocking headers from proxied responses. The client-side screenshot code already handles same-origin iframes correctly when the content is accessible.

## Design Decisions

**Decision: Strip only iframe-blocking headers, not all security headers.**
Justification: We want minimal interference with the upstream response. Only `X-Frame-Options` and `Content-Security-Policy` headers prevent iframe embedding. Other security headers (e.g., `Strict-Transport-Security`, `X-Content-Type-Options`) are harmless in an iframe context and should be preserved. For CSP, rather than fully removing it, we remove only the `frame-ancestors` directive and pass the rest through. However, CSP can also contain directives that reference the original origin (e.g., `connect-src 'self'`) which would break since 'self' now refers to the proxy origin. Since the proxy exists specifically to make content embeddable, and any CSP the upstream sends was designed for direct access (not proxied iframe access), removing the entire CSP header is the pragmatic choice for a dev-tools proxy.

**Decision: Strip headers on the proxy response path, not via a separate middleware.**
Justification: The header stripping is intrinsic to the proxy's purpose (making localhost content embeddable). Putting it in the same response handler keeps the logic co-located and avoids ordering dependencies with other middleware.

**Decision: Case-insensitive header deletion.**
Justification: HTTP headers are case-insensitive per RFC 7230. Node.js normalizes incoming headers to lowercase, but we should be defensive and handle any casing since we're operating on the raw headers object from `http.IncomingMessage`.

**Decision: No client-side changes needed.**
Justification: `captureIframeReplacement` already correctly accesses `iframe.contentDocument` and uses `html2canvas` to render it. The only reason it falls back to placeholder is that `contentDocument` is null due to the blocked iframe. Once headers are stripped, the existing code path succeeds.

## File Structure

- **Modify:** `server/proxy-router.ts` -- Add header-stripping function and call it before `writeHead`
- **Modify:** `test/unit/server/proxy-router.test.ts` -- Add tests for header stripping
- **Modify:** `test/unit/client/ui-screenshot.test.ts` -- Add test confirming screenshot capture succeeds for proxy-URL iframes (same-origin scenario already tested, but add explicit proxy-URL test for documentation)

---

### Task 1: Strip iframe-blocking headers from proxy responses

**Files:**
- Modify: `server/proxy-router.ts:54-103` (the HTTP proxy handler)
- Test: `test/unit/server/proxy-router.test.ts`

- [ ] **Step 1: Write failing tests for header stripping**

Add tests to `test/unit/server/proxy-router.test.ts` that verify the proxy strips `X-Frame-Options` and `Content-Security-Policy` headers from upstream responses. The target test server needs routes that return these headers.

Add these routes to the existing `targetApp` in the `beforeAll` of the `HTTP reverse proxy` describe block:

```typescript
targetApp.get('/with-xfo', (_req, res) => {
  res.set('X-Frame-Options', 'DENY')
  res.send('framed content')
})
targetApp.get('/with-csp', (_req, res) => {
  res.set('Content-Security-Policy', "frame-ancestors 'none'; default-src 'self'")
  res.send('csp content')
})
targetApp.get('/with-both', (_req, res) => {
  res.set('X-Frame-Options', 'SAMEORIGIN')
  res.set('Content-Security-Policy', "frame-ancestors 'none'")
  res.send('both headers')
})
targetApp.get('/no-frame-headers', (_req, res) => {
  res.set('X-Custom-Header', 'keep-me')
  res.send('no frame headers')
})
```

Add these test cases:

```typescript
it('strips X-Frame-Options header from proxied responses', async () => {
  process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
  const app = createApp(manager)

  const res = await request(app)
    .get(`/api/proxy/http/${targetPort}/with-xfo`)
    .set('x-auth-token', TEST_AUTH_TOKEN)

  expect(res.status).toBe(200)
  expect(res.text).toBe('framed content')
  expect(res.headers['x-frame-options']).toBeUndefined()
})

it('strips Content-Security-Policy header from proxied responses', async () => {
  process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
  const app = createApp(manager)

  const res = await request(app)
    .get(`/api/proxy/http/${targetPort}/with-csp`)
    .set('x-auth-token', TEST_AUTH_TOKEN)

  expect(res.status).toBe(200)
  expect(res.text).toBe('csp content')
  expect(res.headers['content-security-policy']).toBeUndefined()
})

it('strips both X-Frame-Options and Content-Security-Policy simultaneously', async () => {
  process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
  const app = createApp(manager)

  const res = await request(app)
    .get(`/api/proxy/http/${targetPort}/with-both`)
    .set('x-auth-token', TEST_AUTH_TOKEN)

  expect(res.status).toBe(200)
  expect(res.text).toBe('both headers')
  expect(res.headers['x-frame-options']).toBeUndefined()
  expect(res.headers['content-security-policy']).toBeUndefined()
})

it('preserves non-iframe-blocking headers from proxied responses', async () => {
  process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  const manager = { forward: vi.fn(), close: vi.fn() } as unknown as PortForwardManager
  const app = createApp(manager)

  const res = await request(app)
    .get(`/api/proxy/http/${targetPort}/no-frame-headers`)
    .set('x-auth-token', TEST_AUTH_TOKEN)

  expect(res.status).toBe(200)
  expect(res.text).toBe('no frame headers')
  expect(res.headers['x-custom-header']).toBe('keep-me')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --run test/unit/server/proxy-router.test.ts`
Expected: The 3 header-stripping tests FAIL (headers are still present), the preservation test PASSES.

- [ ] **Step 3: Implement header stripping in the proxy**

In `server/proxy-router.ts`, add a helper function before the `createProxyRouter` function:

```typescript
/**
 * Headers that prevent iframe embedding. The HTTP reverse proxy strips these
 * so that proxied localhost content renders inside Freshell's browser pane
 * iframe. Without this, dev servers that send X-Frame-Options or CSP
 * frame-ancestors directives cause the browser to block the iframe content,
 * which in turn makes the MCP screenshot tool fall back to a placeholder.
 */
const IFRAME_BLOCKED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
])

function stripIframeBlockingHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const cleaned: http.IncomingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!IFRAME_BLOCKED_HEADERS.has(key.toLowerCase())) {
      cleaned[key] = value
    }
  }
  return cleaned
}
```

Then modify the proxy callback (line 78-80) from:

```typescript
(proxyRes) => {
  res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
  proxyRes.pipe(res)
},
```

to:

```typescript
(proxyRes) => {
  const headers = stripIframeBlockingHeaders(proxyRes.headers)
  res.writeHead(proxyRes.statusCode ?? 502, headers)
  proxyRes.pipe(res)
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- --run test/unit/server/proxy-router.test.ts`
Expected: All tests PASS including the 4 new ones.

- [ ] **Step 5: Refactor and verify**

Review the implementation for clarity. Ensure the header set is well-documented, the function is pure, and the comment explains the "why" not just the "what". Also strip `Content-Security-Policy-Report-Only` which has the same blocking semantics.

Run: `npm run test:vitest -- --run test/unit/server/proxy-router.test.ts`
Run: `npm run test:vitest -- --run test/unit/client/ui-screenshot.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add server/proxy-router.ts test/unit/server/proxy-router.test.ts
git commit -m "fix: strip iframe-blocking headers from proxy responses

Dev servers commonly send X-Frame-Options and Content-Security-Policy
headers that prevent iframe embedding. Since the proxy exists to make
localhost content embeddable in browser panes, strip these headers so
the iframe renders content and the MCP screenshot tool can capture it."
```

---

### Task 2: Add screenshot test for proxy-URL iframe scenario

**Files:**
- Modify: `test/unit/client/ui-screenshot.test.ts`

- [ ] **Step 1: Write a test that exercises the proxy-URL iframe screenshot path**

This test documents the end-to-end scenario: an iframe whose `src` is a proxy URL (`/api/proxy/http/3000/`) should be captured as image content (not placeholder) when the iframe document is accessible. This is already covered by the existing same-origin test, but adding an explicit proxy-URL test makes the intended behavior discoverable and guards against regressions specific to the proxy URL pattern.

Add to the `captureUiScreenshot iframe handling` describe block:

```typescript
it('captures proxy-URL iframe as image content when document is accessible', async () => {
  document.body.innerHTML = `
    <div data-context="global">
      <iframe id="proxy-frame" src="/api/proxy/http/3000/"></iframe>
    </div>
  `
  const target = document.querySelector('[data-context="global"]') as HTMLElement
  const iframe = document.getElementById('proxy-frame') as HTMLIFrameElement
  setRect(target, 800, 500)
  setRect(iframe, 500, 300)

  const iframeDoc = iframe.contentDocument
  expect(iframeDoc).toBeTruthy()
  iframeDoc?.open()
  iframeDoc?.write('<!doctype html><html><body><p>Proxied localhost content</p></body></html>')
  iframeDoc?.close()

  let clonedHtml = ''
  vi.mocked(html2canvas).mockImplementation(async (_el: any, opts: any = {}) => {
    if (typeof opts.onclone === 'function') {
      const cloneDoc = document.implementation.createHTMLDocument('clone')
      const cloneTarget = target.cloneNode(true) as HTMLElement
      cloneDoc.body.appendChild(cloneTarget)
      opts.onclone(cloneDoc)
      clonedHtml = cloneTarget.innerHTML
      return {
        width: 800,
        height: 500,
        toDataURL: () => 'data:image/png;base64,PROXYPNG',
      } as any
    }

    return {
      width: 500,
      height: 300,
      toDataURL: () => 'data:image/png;base64,IFRAMEPROXYPNG',
    } as any
  })

  const result = await captureUiScreenshot({ scope: 'view' }, createRuntime() as any)

  expect(result.ok).toBe(true)
  expect(result.imageBase64).toBe('PROXYPNG')
  // The iframe should be replaced with an image, not a placeholder
  expect(clonedHtml).toContain('data-screenshot-iframe-image="true"')
  expect(clonedHtml).not.toContain('data-screenshot-iframe-placeholder')
  expect(clonedHtml).not.toContain('<iframe')
})
```

- [ ] **Step 2: Run test to verify it passes**

This test should already pass because the existing `captureIframeReplacement` code handles same-origin iframes. The test is a documentation/regression guard, not a red test.

Run: `npm run test:vitest -- --run test/unit/client/ui-screenshot.test.ts`
Expected: PASS (the proxy-URL iframe test is same-origin in jsdom, so contentDocument is accessible).

- [ ] **Step 3: No implementation needed**

The client-side code already works correctly for same-origin iframes. This task only adds test coverage.

- [ ] **Step 4: Verify all related tests pass**

Run: `npm run test:vitest -- --run test/unit/client/ui-screenshot.test.ts`
Run: `npm run test:vitest -- --run test/unit/server/proxy-router.test.ts`
Expected: All PASS.

- [ ] **Step 5: Refactor and verify**

Verify no duplication with the existing same-origin test. The new test is justified because it uses a proxy URL pattern (`/api/proxy/http/PORT/`) and documents the specific scenario the fix addresses, making it easier to find when investigating proxy-related screenshot issues.

Run full related test suite:
Run: `npm run test:vitest -- --run test/unit/client/ui-screenshot.test.ts test/unit/server/proxy-router.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add test/unit/client/ui-screenshot.test.ts
git commit -m "test: add proxy-URL iframe screenshot regression test

Documents that browser pane iframes using /api/proxy/http/PORT/ URLs
are captured as image content (not placeholders) when the proxy strips
iframe-blocking headers, making the content same-origin accessible."
```

---

### Task 3: Run full test suite and verify no regressions

- [ ] **Step 1: Run the full test suite**

Run: `npm run check`
Expected: Typecheck passes, all tests pass.

- [ ] **Step 2: Verify changed files are correct**

Run: `git diff --name-only main...HEAD`
Expected:
```
docs/plans/2026-03-29-fix-cross-origin-iframe-screenshot.md
server/proxy-router.ts
test/unit/client/ui-screenshot.test.ts
test/unit/server/proxy-router.test.ts
```

- [ ] **Step 3: Final commit if any cleanup needed**

Only commit if there are unstaged changes from refactoring. Otherwise, the work is complete.
