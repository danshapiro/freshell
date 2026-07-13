const TOK = (await import('fs')).readFileSync('/home/dan/freshell-scratch-007i/tok.txt','utf8').trim()
const VARIANTS = [
  '',
  '?priority=visible',
  '?priority=background',
  '?priority=bogus',
  '?priority=visible&limit=1',
  '?priority=visible&limit=abc',
  '?priority=visible&query=hello',
  '?priority=visible&query=zzzznomatch',
  '?priority=visible&query=' + encodeURIComponent('こんにちは'),
  '?priority=visible&query=' + encodeURIComponent('マルチバイト'),
  '?priority=visible&includeSubagents=true&includeNonInteractive=true&includeEmpty=true',
  '?priority=visible&cursor=garbage',
]
async function get(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}/api/session-directory${path}`, { headers: { 'x-auth-token': TOK } })
  let body
  const text = await r.text()
  try { body = JSON.parse(text) } catch { body = { _raw: text } }
  return { status: r.status, body }
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]); return o }
  return v
}
function normalize(x, home) {
  return sortDeep(JSON.parse(JSON.stringify(x).replaceAll(home, '$QAHOME')))
}
// wait for both indexers to see all sessions (poll until stable & counts equal expectations)
async function stableCount(port, home) {
  let last = -1, same = 0
  for (let i = 0; i < 40; i++) {
    const { body } = await get(port, '?priority=visible&includeSubagents=true&includeNonInteractive=true&includeEmpty=true&limit=50')
    const n = Array.isArray(body.items) ? body.items.length : -2
    if (n === last) { same++ ; if (same >= 3) return n } else { same = 0; last = n }
    await new Promise(r => setTimeout(r, 500))
  }
  return last
}
const HO = '/home/dan/.freshell-qa-007i-orig', HR = '/home/dan/.freshell-qa-007i-rust'
const [co, cr] = await Promise.all([stableCount(17871, HO), stableCount(17872, HR)])
console.log('stable item counts (all-inclusive):', 'orig=', co, 'rust=', cr)
const results = { counts: { orig: co, rust: cr }, variants: {} }
let mismatches = 0
for (const v of VARIANTS) {
  const [o, r] = await Promise.all([get(17871, v), get(17872, v)])
  const no = normalize(o, HO), nr = normalize(r, HR)
  const eq = JSON.stringify(no) === JSON.stringify(nr)
  results.variants[v || '(none)'] = { equal: eq, orig: no, rust: nr }
  if (!eq) mismatches++
  console.log(eq ? 'EQUAL   ' : 'MISMATCH', v || '(none)', 'status', o.status, r.status, 'items', no.body?.items?.length, nr.body?.items?.length)
}
// cursor follow: limit=1 then follow nextCursor chain on both, compare full chains
async function chain(port, home) {
  const pages = []
  let cursor
  for (let i = 0; i < 20; i++) {
    const path = '?priority=visible&limit=1' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    const { status, body } = await get(port, path)
    pages.push(normalize({ status, body }, home))
    cursor = body.nextCursor
    if (!cursor) break
  }
  return pages
}
const [chO, chR] = await Promise.all([chain(17871, HO), chain(17872, HR)])
const chEq = JSON.stringify(chO) === JSON.stringify(chR)
console.log(chEq ? 'EQUAL   ' : 'MISMATCH', 'cursor-chain', 'pages', chO.length, chR.length)
results.cursorChain = { equal: chEq, orig: chO, rust: chR }
if (!chEq) mismatches++
;(await import('fs')).writeFileSync('/home/dan/freshell-scratch-007i/sd-results.json', JSON.stringify(results, null, 1))
console.log('TOTAL MISMATCHES:', mismatches)
