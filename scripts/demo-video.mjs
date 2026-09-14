// Record the demo video: a scripted walk through the live page, captions burned in.
//
//   SNAP=<dir with a snapshot of the live site> OUT=<dir> node scripts/demo-video.mjs
//
// The page is served from a snapshot rather than the network, for two reasons: the
// recording machine's browser cannot reach the internet through its proxy, and a snapshot
// makes the recording reproducible — the same bytes, the same live data, every run. The
// snapshot is the published page plus the /api responses it made at that moment, so nothing
// in the video is staged: the rate, the age, the reserves and the earned fee are whatever
// the chain said when the snapshot was taken.
//
// Playwright records WebM; scripts/render-video.sh turns it into an H.264 MP4.
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const SNAP = process.env.SNAP
const OUT = process.env.OUT ?? '/tmp/rialto-video'
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
if (!SNAP) throw new Error('SNAP=<snapshot dir> is required')
await mkdir(OUT, { recursive: true })

const W = 1280, H = 720
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' }

/* ── title and end cards, served alongside the snapshot ── */
const card = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b0b0b;color:#fff;font:16px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .c{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 120px;box-sizing:border-box}
  .k{font:600 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:#8d8b82;margin-bottom:22px}
  h1{font-size:64px;line-height:1.05;letter-spacing:-.03em;margin:0 0 22px;font-weight:700}
  p{font-size:24px;line-height:1.45;color:#c3c2b7;margin:0 0 10px;max-width:820px}
  .m{font:15px/1.8 ui-monospace,Menlo,monospace;color:#8d8b82;margin-top:30px}
  .o{color:#eb6834}
</style></head><body><div class="c">${body}</div></body></html>`
await writeFile(join(SNAP, 'title.html'), card(`
  <div class="k">Rialto · live on Arc testnet</div>
  <h1>Pay a foreign invoice<br>in one transaction.</h1>
  <p>Cross-border settlement at the FX rate that actually exists — on a chain that, until
  now, could not read one.</p>
  <div class="m">Everything in this recording is on-chain. Every hash opens on Arcscan.</div>`))
await writeFile(join(SNAP, 'end.html'), card(`
  <div class="k">Rialto</div>
  <h1><span class="o">rialto-arc.netlify.app</span></h1>
  <p>Six contracts, source-verified. An invoice settled. A forward settled. A live FX feed.</p>
  <p>Arc mainnet launches 16 September 2026. There is still no price oracle on it.</p>
  <div class="m">github.com/let-the-dreamers-rise/rialto<br>Circle Developer Grants · Cohort 2</div>`))

/* ── the snapshot server: routes /api/getRate?maxAge=N to the response captured for N ── */
const srv = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let p = url.pathname === '/' ? '/index.html' : url.pathname
  if (p === '/api/getRate') p = `/api/getRate-${url.searchParams.get('maxAge')}.json`
  else if (p.startsWith('/api/')) p += '.json'
  try {
    const body = await readFile(SNAP + p)
    res.writeHead(200, { 'content-type': TYPES[p.slice(p.lastIndexOf('.'))] ?? 'text/plain' })
    res.end(body)
  } catch { res.writeHead(404); res.end('') }
})
await new Promise((r) => srv.listen(8087, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:8087'

/* ── browser ── */
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--hide-scrollbars'] })
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  colorScheme: 'light',
})
const page = await ctx.newPage()

// The overlay: a caption bar, a cursor, and a highlight ring. Installed on every document
// so it survives the navigations between cards and the page.
await page.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__cap')) return
    const st = document.createElement('style')
    st.textContent = `
      #__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;padding:46px 64px 26px;min-height:60px;
        background:linear-gradient(to top,#080808 0%,#080808 74%,rgba(8,8,8,0) 100%);
        color:#fff;font:500 24px/1.38 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
        letter-spacing:-.005em;pointer-events:none;opacity:0;transition:opacity .25s}
      #__cap.on{opacity:1}
      #__cap b{color:#ffb38a;font-weight:650}
      #__tag{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;font:600 11px/1 ui-monospace,Menlo,monospace;
        letter-spacing:.14em;text-transform:uppercase;color:#fff;background:rgba(8,8,8,.78);
        padding:8px 11px;border-radius:6px;pointer-events:none}
      #__tag i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#1baf7a;margin-right:7px;vertical-align:middle}
      #__cur{position:fixed;left:0;top:0;width:18px;height:18px;z-index:2147483001;pointer-events:none;
        transform:translate(-2px,-2px);transition:left .55s cubic-bezier(.2,.8,.2,1),top .55s cubic-bezier(.2,.8,.2,1);opacity:0}
      #__cur.on{opacity:1}
      #__cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
      #__ring{position:fixed;left:0;top:0;width:0;height:0;border:3px solid #eb6834;border-radius:12px;z-index:2147482999;
        pointer-events:none;opacity:0;transition:all .4s ease;box-shadow:0 0 0 6px rgba(235,104,52,.16)}
      #__ring.on{opacity:1}
      #__click{position:fixed;width:34px;height:34px;border-radius:50%;border:3px solid #eb6834;z-index:2147483001;
        pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(.3)}
      @keyframes __pop{0%{opacity:.9;transform:translate(-50%,-50%) scale(.3)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.4)}}
    `
    document.documentElement.appendChild(st)
    const cap = document.createElement('div'); cap.id = '__cap'
    const tag = document.createElement('div'); tag.id = '__tag'; tag.innerHTML = '<i></i>Arc testnet · recorded live'
    const cur = document.createElement('div'); cur.id = '__cur'
    cur.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5 L2 14.5 L5.6 11.2 L8 16.4 L10.4 15.3 L8.1 10.2 L13 10 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    const ring = document.createElement('div'); ring.id = '__ring'
    const clk = document.createElement('div'); clk.id = '__click'
    for (const el of [cap, tag, cur, ring, clk]) document.documentElement.appendChild(el)
    window.__cap = (html) => { if (!html) { cap.classList.remove('on'); return } cap.innerHTML = html; cap.classList.add('on') }
    window.__cursor = (x, y) => { cur.classList.add('on'); cur.style.left = x + 'px'; cur.style.top = y + 'px' }
    window.__ring = (r) => { if (!r) { ring.classList.remove('on'); return }
      ring.style.left = (r.x - 8) + 'px'; ring.style.top = (r.y - 8) + 'px'
      ring.style.width = (r.w + 16 - 6) + 'px'; ring.style.height = (r.h + 16 - 6) + 'px'; ring.classList.add('on') }
    window.__click = (x, y) => { clk.style.left = x + 'px'; clk.style.top = y + 'px'; clk.style.animation = 'none'
      void clk.offsetWidth; clk.style.animation = '__pop .45s ease-out forwards' }
    // Smooth scroll that does not depend on the browser honouring behavior:'smooth' headless.
    window.__scroll = (to, ms = 700) => new Promise((done) => {
      const from = window.scrollY, d = to - from, t0 = performance.now()
      const ease = (t) => (t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
      const step = (now) => { const t = Math.min(1, (now - t0) / ms); window.scrollTo(0, from + d * ease(t))
        if (t < 1) requestAnimationFrame(step); else done() }
      requestAnimationFrame(step)
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install()
})

/* ── scene helpers ── */
const hold = (ms) => page.waitForTimeout(ms)
const say = (html) => page.evaluate((h) => window.__cap(h), html)
const hush = () => page.evaluate(() => window.__cap(''))
const tag = (on) => page.evaluate((v) => { document.getElementById('__tag').style.display = v ? '' : 'none' }, on)
async function goTo(sel, offset = 72, ms = 800) {
  await page.evaluate(async ({ sel, offset, ms }) => {
    const el = document.querySelector(sel); if (!el) return
    const y = el.getBoundingClientRect().top + window.scrollY - offset
    await window.__scroll(Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)), ms)
  }, { sel, offset, ms })
}
async function ring(sel) {
  await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return window.__ring(null)
    const r = el.getBoundingClientRect(); window.__ring({ x: r.left, y: r.top, w: r.width, h: r.height }) }, sel)
}
const unring = () => page.evaluate(() => window.__ring(null))
async function cursorTo(sel, dx = 0, dy = 0) {
  const box = await page.locator(sel).first().boundingBox()
  if (!box) return null
  const x = box.x + box.width / 2 + dx, y = box.y + box.height / 2 + dy
  await page.evaluate(([x, y]) => window.__cursor(x, y), [x, y])
  await hold(650)
  return { x, y }
}
async function click(sel) {
  const at = await cursorTo(sel)
  if (!at) return
  await page.evaluate(([x, y]) => window.__click(x, y), [at.x, at.y])
  await page.locator(sel).first().click()
}
const hideCursor = () => page.evaluate(() => document.getElementById('__cur').classList.remove('on'))

/* ── the film ── */
await page.goto(`${BASE}/title.html`, { waitUntil: 'load' })
await tag(false)
await hold(4200)

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await tag(true)
await hold(400)
await say('A supplier bills you <b>€5,000</b>. You hold dollars. Today that is 40–60bp through a provider, 200–300bp through a bank, and one to three days.')
await hold(4600)
await say('Rialto settles it on-chain in <b>one transaction</b>, at 25bp, at the rate that actually exists — and the payee receives <b>exactly</b> what they billed.')
await hold(4600)

await goTo('.clock', 120)
await ring('.clock')
await say('<b>Arc mainnet launches in three days.</b> Circle has partner stablecoins in eight currencies — and there is still no price oracle on Arc for a pool to read.')
await hold(5200)
await unring()

await goTo('h2:nth-of-type(2)', 40) // Which part of the payment this is
await say('This is not a payments company. Getting in and out is Circle\'s network. <b>The FX leg</b> — the one thing Arc could not do — is the product.')
await hold(5000)

await goTo('#status', 130)
await ring('#status')
await say('Live right now: the <b>oracle</b>, a <b>rate lock</b> that ran to settlement, and a <b>spot pool</b> quoting off the feed. All read from the chain as this page loads.')
await hold(5400)
await unring()

await goTo('#iv-rows', 210)
await ring('#iv-rows')
await say('A real invoice, settled. A payer holding only dollars; a payee owed euros; one transaction.')
await hold(4200)
await unring()
await goTo('#iv-result', 330)
await ring('#iv-result')
await say('The payee received <b>exactly EUR 1.00</b>. All-in <b>27bp</b> — the 25bp fee plus 2bp of slippage on a faucet-sized book.')
await hold(5200)
await unring()

await goTo('#lf-rows', 150)
await ring('#lf-rows')
await say('The other half: a <b>rate lock</b>. Opened by a writer, taken by an importer, settled against the oracle at maturity — five transactions.')
await hold(5000)
await unring()
await goTo('#lf-result', 330)
await ring('#lf-result')
await say('Locked at 1.1622, settled at 1.1652 — both real ECB prints. The lock paid the importer <b>3.00 USDC</b>, out of the writer\'s margin, exactly the difference.')
await hold(5600)
await unring()

await goTo('.rig', 100)
await say('The piece that makes it possible: <b>a live FX feed on Arc</b>. Signed by publishers, verified on-chain, permissionless to read.')
await hold(4400)
await goTo('.try', 200)
await say('It is pull-based. You name how stale a rate you will accept — and the contract <b>reverts</b> rather than hand you an older one.')
await hold(1200)
await click('#bounds button[data-v="60"]')
await hold(2600)
await say('Sixty seconds: <b>reverted</b>. The feed is older than that bound, so the call refuses — that is the contract working, not failing.')
await hold(4800)
await click('#bounds button[data-v="900"]')
await hold(2200)
await say('Fifteen minutes — the bound the pool itself settles against: <b>1.1592 USD per EUR</b>, the ECB reference rate, live.')
await hold(4600)
await hideCursor()

await goTo('#cards', 110)
await ring('#cards')
await say('<b>Six contracts</b>, deployed and source-verified on Arcscan. The code at every address can be read, not trusted.')
await hold(4600)
await unring()

await goTo('#rev', 130)
await ring('#rev')
await say('How it makes money: <b>12.5bp</b> of everything settled — half the fee, capped at half by the contract. The first cell is not a projection; it is what the invoice above paid, read off the pool.')
await hold(6000)
await unring()

await goTo('.figure', 60)
await say('Why nobody had built this: a 1:1 stableswap loses <b>33–39% a year</b> on emerging-market corridors. Rate-anchored, near flat. 259 days of real ECB data.')
await hold(6000)

await goTo('.ask', 90)
await ring('.ask')
await say('What a grant buys, in order — and every item is a limitation this page already admits to.')
await hold(5000)
await unring()
await hush()
await hold(600)

await page.goto(`${BASE}/end.html`, { waitUntil: 'load' })
await tag(false)
await hold(5200)

const video = page.video()
await ctx.close()
const path = await video.path()
await browser.close()
srv.close()
console.log(`recorded ${path}`)
