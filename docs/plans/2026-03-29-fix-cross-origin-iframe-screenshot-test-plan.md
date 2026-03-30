# Test Plan: Fix Cross-Origin Iframe Screenshot

**Implementation plan:** `docs/plans/2026-03-29-fix-cross-origin-iframe-screenshot.md`

**Testing strategy (approved):** Strip iframe-blocking headers from proxy responses so proxied localhost content renders in browser pane iframes and the MCP screenshot tool captures real content instead of placeholders.

**Strategy reconciliation notes:**
- The approved strategy names a Playwright e2e test as highest priority. The project has Playwright infrastructure in `test/e2e-browser/` with a running `TestServer` that boots a real Freshell instance. The existing `browser-pane.spec.ts` already exercises browser pane creation and URL loading. A new Playwright test can load a localhost URL through the proxy, then use the MCP agent API `screenshot-view` CLI command (or the `requestUiScreenshot` harness method) to verify the screenshot contains image content rather than a placeholder. This test exercises the entire fix end-to-end: proxy strips headers, iframe renders, screenshot captures real content.
- The implementation plan omits the Playwright e2e test entirely, covering only Vitest unit tests. This test plan adds it as test 1.
- The implementation plan omits the MCP instructions update verification. This test plan adds it as test 7 (a simple Grep-based assertion on the instructions text).
- The implementation plan's proxy-router unit tests and ui-screenshot unit test align with strategy items 2-4 and are included here as tests 3-6.
- No strategy changes requiring user approval: all tests use existing harnesses and infrastructure.

---

## Harness requirements

No new harnesses need to be built. All tests use existing infrastructure:

1. **Playwright E2E harness** (`test/e2e-browser/helpers/fixtures.ts`): Boots a real Freshell production server via `TestServer`, provides `freshellPage` fixture with auth + WebSocket, `harness` for Redux state inspection, and `terminal` helper. The server includes the proxy router, so proxied URLs work out of the box.

2. **Vitest + supertest** (`test/unit/server/proxy-router.test.ts`): Existing test file boots a target express server on an ephemeral port and sends requests through the proxy router via supertest. New tests add routes to the existing `targetApp` that return iframe-blocking headers.

3. **Vitest + jsdom** (`test/unit/client/ui-screenshot.test.ts`): Existing test file mocks `html2canvas` and tests `captureUiScreenshot` with synthetic DOM. Same-origin iframes in jsdom allow `contentDocument` access, so proxy-URL iframe tests work without browser-level header stripping.

---

## Test plan

### Test 1: Browser pane screenshot captures proxied localhost content as image, not placeholder

- **Name:** Screenshot of browser pane with proxied localhost URL produces image content, not a cross-origin placeholder
- **Type:** scenario
- **Disposition:** new
- **Harness:** Playwright E2E (`test/e2e-browser/specs/browser-pane-screenshot.spec.ts`)
- **Preconditions:**
  - Freshell test server is running (production build, via `TestServer` fixture)
  - A static HTTP server running on an ephemeral localhost port inside the test, serving a page with known canary text (e.g., `<h1>SCREENSHOT_CANARY</h1>`)
  - A browser pane is open and navigated to the canary server's localhost URL
  - The proxy has rewritten the URL to `/api/proxy/http/<port>/`
- **Actions:**
  1. Start a tiny HTTP server on localhost that returns a page with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` headers, plus a known canary `<h1>` element.
  2. Create a browser pane via the Freshell UI (right-click terminal -> split -> Browser).
  3. Navigate the browser pane to `http://localhost:<canary-port>/`.
  4. Wait for the iframe to load (verify `iframe[title="Browser content"]` is attached and its `src` contains `/api/proxy/http/`).
  5. Take a Playwright screenshot of the page.
  6. Also invoke the MCP screenshot path: call the agent API `screenshot-view` endpoint (via `fetch` from the page context or the CLI) and inspect the response.
- **Expected outcome:**
  - The Playwright screenshot does NOT show a placeholder div with "Iframe content is not directly capturable" text. Source of truth: the implementation plan states the proxy strips `X-Frame-Options` and `Content-Security-Policy`, so the iframe content renders normally.
  - The agent API screenshot response has `ok: true` and `imageBase64` that is a valid PNG (starts with PNG signature bytes when decoded). Source of truth: the implementation plan states `captureIframeReplacement` succeeds when `contentDocument` is accessible.
  - The page does NOT contain an element with `data-screenshot-iframe-placeholder="true"` during the screenshot capture.
- **Interactions:** Exercises proxy-router header stripping, BrowserPane URL resolution via `buildHttpProxyUrl`, iframe rendering, and the `captureUiScreenshot` → `captureIframeReplacement` → `html2canvas` chain.

### Test 2: Browser pane screenshot falls back to placeholder for truly cross-origin URLs

- **Name:** Screenshot of browser pane with external cross-origin URL gracefully shows placeholder with source URL
- **Type:** regression
- **Disposition:** extend (based on existing `browser-pane.spec.ts` patterns)
- **Harness:** Playwright E2E (`test/e2e-browser/specs/browser-pane-screenshot.spec.ts`)
- **Preconditions:**
  - Freshell test server is running
  - A browser pane is open and navigated to a truly cross-origin URL (e.g., `https://example.com`)
- **Actions:**
  1. Create a browser pane and navigate to `https://example.com`.
  2. Wait for the iframe to load.
  3. Take a Playwright screenshot to inspect the visual output.
- **Expected outcome:**
  - The iframe shows a placeholder with the source URL text (since `https://example.com` is truly cross-origin and the proxy only handles localhost URLs). Source of truth: implementation plan states "No client-side changes needed" -- the existing placeholder behavior for truly cross-origin URLs is preserved.
  - The page contains visible text matching `example.com`.
- **Interactions:** Exercises the graceful fallback in `captureIframeReplacement` when `contentDocument` is null. Confirms the fix does not break the existing placeholder behavior for non-proxied cross-origin content.

### Test 3: Proxy strips X-Frame-Options header from responses

- **Name:** Proxied response does not contain X-Frame-Options header regardless of upstream value
- **Type:** integration
- **Disposition:** new
- **Harness:** Vitest + supertest (`test/unit/server/proxy-router.test.ts`)
- **Preconditions:**
  - Target express server has a route `/with-xfo` that returns `X-Frame-Options: DENY`
  - Proxy app is configured with auth token
- **Actions:**
  1. `GET /api/proxy/http/<targetPort>/with-xfo` with auth header
- **Expected outcome:**
  - Response status is 200
  - Response body is `'framed content'`
  - `res.headers['x-frame-options']` is `undefined`
  - Source of truth: implementation plan Task 1 Step 1 specifies this exact test case.
- **Interactions:** Exercises the `stripIframeBlockingHeaders` function in the proxy response path.

### Test 4: Proxy strips Content-Security-Policy header from responses

- **Name:** Proxied response does not contain Content-Security-Policy header regardless of upstream value
- **Type:** integration
- **Disposition:** new
- **Harness:** Vitest + supertest (`test/unit/server/proxy-router.test.ts`)
- **Preconditions:**
  - Target express server has a route `/with-csp` that returns `Content-Security-Policy: frame-ancestors 'none'; default-src 'self'`
  - Proxy app is configured with auth token
- **Actions:**
  1. `GET /api/proxy/http/<targetPort>/with-csp` with auth header
- **Expected outcome:**
  - Response status is 200
  - Response body is `'csp content'`
  - `res.headers['content-security-policy']` is `undefined`
  - Source of truth: implementation plan Task 1 Step 1 and Design Decision on CSP removal.
- **Interactions:** Same as Test 3.

### Test 5: Proxy strips both iframe-blocking headers simultaneously

- **Name:** Proxied response strips X-Frame-Options and Content-Security-Policy when both are present
- **Type:** boundary
- **Disposition:** new
- **Harness:** Vitest + supertest (`test/unit/server/proxy-router.test.ts`)
- **Preconditions:**
  - Target express server has a route `/with-both` that returns both `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'none'`
  - Proxy app is configured with auth token
- **Actions:**
  1. `GET /api/proxy/http/<targetPort>/with-both` with auth header
- **Expected outcome:**
  - Response status is 200
  - Response body is `'both headers'`
  - `res.headers['x-frame-options']` is `undefined`
  - `res.headers['content-security-policy']` is `undefined`
  - Source of truth: implementation plan Task 1 Step 1.
- **Interactions:** Same as Test 3, exercises the case where both headers coexist.

### Test 6: Proxy preserves non-iframe-blocking headers

- **Name:** Proxied response preserves custom and non-security headers that do not block iframe embedding
- **Type:** invariant
- **Disposition:** new
- **Harness:** Vitest + supertest (`test/unit/server/proxy-router.test.ts`)
- **Preconditions:**
  - Target express server has a route `/no-frame-headers` that returns `X-Custom-Header: keep-me`
  - Proxy app is configured with auth token
- **Actions:**
  1. `GET /api/proxy/http/<targetPort>/no-frame-headers` with auth header
- **Expected outcome:**
  - Response status is 200
  - Response body is `'no frame headers'`
  - `res.headers['x-custom-header']` is `'keep-me'`
  - Source of truth: implementation plan Design Decision "Strip only iframe-blocking headers, not all security headers."
- **Interactions:** Confirms the stripping logic is precise and does not overshoot by removing all headers.

### Test 7: Proxy-URL iframe captured as image in ui-screenshot

- **Name:** captureUiScreenshot replaces a proxy-URL iframe with an image element (not placeholder) when contentDocument is accessible
- **Type:** unit
- **Disposition:** new
- **Harness:** Vitest + jsdom (`test/unit/client/ui-screenshot.test.ts`)
- **Preconditions:**
  - DOM contains `<div data-context="global">` with an `<iframe src="/api/proxy/http/3000/">` inside
  - `iframe.contentDocument` is accessible (jsdom same-origin)
  - `html2canvas` is mocked to call `onclone` and return canvas objects
- **Actions:**
  1. Write HTML content into the iframe's `contentDocument`
  2. Call `captureUiScreenshot({ scope: 'view' }, runtime)`
- **Expected outcome:**
  - `result.ok` is `true`
  - The cloned DOM contains an element with `data-screenshot-iframe-image="true"` (image replacement)
  - The cloned DOM does NOT contain an element with `data-screenshot-iframe-placeholder` (no fallback)
  - The cloned DOM does NOT contain any `<iframe>` elements (iframe replaced entirely)
  - Source of truth: implementation plan Task 2 states this test documents the proxy-URL scenario and should pass because `captureIframeReplacement` already handles same-origin iframes.
- **Interactions:** Exercises `captureIframeReplacement` → `html2canvas` for the specific proxy URL pattern `/api/proxy/http/PORT/`.

### Test 8: MCP tool instructions updated to reflect fixed behavior

- **Name:** MCP tool instructions no longer claim browser pane screenshots always show placeholder for proxied content
- **Type:** invariant
- **Disposition:** new
- **Harness:** Vitest file content assertion or simple grep check (can be a unit test in `test/unit/server/` or verified as part of the proxy-router test file)
- **Preconditions:**
  - `server/mcp/freshell-tool.ts` exists and contains the MCP tool instructions
- **Actions:**
  1. Read the content of `server/mcp/freshell-tool.ts`
  2. Check line 66 and line 425 area where cross-origin placeholder instructions are documented
- **Expected outcome:**
  - The instructions text should either:
    - Remove the "cross-origin iframe content renders a placeholder" caveat for localhost/proxied URLs, OR
    - Clarify that proxied localhost URLs now render actual content and only truly cross-origin URLs show placeholders
  - Source of truth: the implementation plan does not explicitly list this file as modified, but the approved testing strategy includes "MCP instructions update verification" as item 5. The fix changes the behavior described in these instructions.
- **Interactions:** None (static content check).

---

## Coverage summary

### Covered areas

| Action / Behavior | Tests |
|---|---|
| Proxy strips `X-Frame-Options` from responses | Test 3 |
| Proxy strips `Content-Security-Policy` from responses | Test 4 |
| Proxy strips both headers when both present | Test 5 |
| Proxy preserves other headers | Test 6 |
| Screenshot captures proxied iframe as image (Vitest/jsdom) | Test 7 |
| Screenshot captures proxied iframe as image (Playwright/real browser) | Test 1 |
| Screenshot falls back to placeholder for truly cross-origin URLs | Test 2 |
| MCP instructions accuracy | Test 8 |

### Explicitly excluded per strategy

| Area | Reason |
|---|---|
| `Content-Security-Policy-Report-Only` header stripping | Mentioned in implementation plan but extremely rare in dev servers. Tests 3-5 cover the pattern; CSP-Report-Only uses the same `IFRAME_BLOCKED_HEADERS` set. Low risk of regression. |
| Performance testing | The header stripping is a trivial O(n) object-key filter on a small header set. No performance risk. |
| WebSocket proxy header behavior | The WebSocket upgrade handler (`attachProxyUpgradeHandler`) does not proxy HTTP response headers -- it pipes raw TCP. No iframe-blocking headers apply to WebSocket upgrades. |

### Risks from exclusions

- **CSP-Report-Only**: If a dev server sends only `Content-Security-Policy-Report-Only` (without the enforcing header), the current test plan does not have an explicit test for it. Risk is minimal because the implementation uses a `Set` lookup that includes it, and the pattern is tested for the other two headers in the set.
