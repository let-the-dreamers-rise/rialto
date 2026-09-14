// Record the codebase walkthrough: the real source files, rendered as a reader would see
// them, with the lines where Circle's products live highlighted and captioned.
//
//   OUT=<dir> node scripts/code-video.mjs
//
// Grant reviewers ask to see the code where USDC and Circle products are integrated, not a
// slide about it. So this reads the files off disk at record time — nothing is pasted or
// retyped — and writes cues.json so a narration can be laid on afterwards.
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.OUT ?? '/tmp/rialto-code-video'
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const PACE = Number(process.env.PACE ?? 1)
await mkdir(OUT, { recursive: true })
const W = 1280, H = 720
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FILES = [
  ['sdk',    'packages/sdk/index.mjs'],
  ['deploy', 'deployments/arc-testnet.json'],
  ['pool',   'contracts/src/RialtoPool.sol'],
  ['oracle', 'contracts/src/RialtoOracle.sol'],
  ['settle', 'contracts/src/RialtoSettlement.sol'],
  ['invoice','scripts/live-invoice.mjs'],
  ['pub',    'site/netlify/functions/publish-rate.mjs'],
]
const sections = []
for (const [id, path] of FILES) {
  const src = await readFile(join(ROOT, path), 'utf8')
  const lines = src.replace(/\n$/, '').split('\n')
  sections.push(`<section id="f-${id}"><div class="fh"><span class="dot"></span>${path}</div><pre>${
    lines.map((l, i) => `<div class="ln" id="${id}-${i + 1}"><span class="n">${i + 1}</span><span class="c">${esc(l) || ' '}</span></div>`).join('')
  }</pre></section>`)
}
const card = (id, body) => `<section id="${id}" class="card"><div class="cc">${body}</div></section>`
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0f1012;color:#d8d6cf;font:14.5px/1.5 ui-monospace,Menlo,Consolas,monospace}
  section{padding:0 0 60px}
  .fh{position:sticky;top:0;z-index:5;background:#17181b;color:#9a9890;padding:10px 22px;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;border-bottom:1px solid #26272b}
  .fh .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#eb6834;margin-right:10px;vertical-align:middle}
  pre{margin:0;padding:10px 0}
  .ln{display:flex;padding:0 22px;white-space:pre}
  .ln .n{width:44px;flex:none;color:#4d4f55;text-align:right;padding-right:18px;user-select:none}
  .ln .c{flex:1;min-width:0}
  .ln.hl{background:#1f2430}
  .ln.hl .n{color:#eb6834}
  .card{height:${H}px;display:flex;align-items:center;background:#0b0b0b;font:16px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .cc{padding:0 110px;max-width:1000px}
  .cc .k{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:#8d8b82;margin-bottom:20px}
  .cc h1{font-size:52px;line-height:1.08;letter-spacing:-.03em;margin:0 0 20px;color:#fff;font-weight:700}
  .cc p{font-size:22px;line-height:1.45;color:#c3c2b7;margin:0 0 10px}
  .cc ul{margin:14px 0 0;padding-left:22px;color:#c3c2b7;font-size:20px;line-height:1.5}
  .cc li{margin-bottom:8px}
  .cc b{color:#ffb38a;font-weight:650}
</style></head><body>
${card('c-title', `<div class="k">Rialto · codebase walkthrough</div><h1>Where Circle's products<br>live in the code.</h1><p>Every file shown is read from the repository at record time. Nothing is pasted.</p>`)}
${sections.join('\n')}
${card('c-planned', `<div class="k">Planned integrations</div><h1>Not yet in the code.<br>Said so.</h1><ul>
  <li><b>CCTP v2 and Gateway</b> — route USDC inventory into the pools from other chains. Milestone 2.</li>
  <li><b>Circle Wallets</b> — LP and publisher key management, replacing the site-held key. Milestone 4.</li>
  <li><b>Partner stablecoins</b> — BRL, MXN, PHP, ZAR as they ship: one rate source and one pool each, no new code path.</li>
  <li><b>StableFX</b> — a complement, not a competitor: institutions quoting RFQ can hedge into the pool.</li></ul>`)}
${card('c-next', `<div class="k">Integration demonstration</div><h1>Now the product, live.</h1><p>Arc testnet. Real transactions. Every hash opens on Arcscan.</p>`)}
</body></html>`
await writeFile(join(OUT, 'code.html'), html)

const srv = createServer(async (req, res) => {
  try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(join(OUT, 'code.html'))) }
  catch { res.writeHead(404); res.end('') }
})
await new Promise((r) => srv.listen(8084, '127.0.0.1', r))

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--hide-scrollbars'] })
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: 'dark' })
const page = await ctx.newPage()
const T0 = Date.now()
const cues = []

await page.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__cap')) return
    const st = document.createElement('style')
    st.textContent = `
      #__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;padding:46px 64px 26px;min-height:60px;
        background:linear-gradient(to top,#080808 0%,#080808 74%,rgba(8,8,8,0) 100%);
        color:#fff;font:500 24px/1.38 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
        letter-spacing:-.005em;pointer-events:none;opacity:0;transition:opacity .25s}
      #__cap.on{opacity:1} #__cap b{color:#ffb38a;font-weight:650}
      #__tag{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;font:600 11px/1 ui-monospace,Menlo,monospace;
        letter-spacing:.14em;text-transform:uppercase;color:#fff;background:rgba(8,8,8,.78);padding:8px 11px;border-radius:6px;pointer-events:none}
      #__tag i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#eb6834;margin-right:7px;vertical-align:middle}
    `
    document.documentElement.appendChild(st)
    const cap = document.createElement('div'); cap.id = '__cap'
    const tag = document.createElement('div'); tag.id = '__tag'; tag.innerHTML = '<i></i>github.com/let-the-dreamers-rise/rialto'
    document.documentElement.append(cap, tag)
    window.__cap = (h) => { if (!h) { cap.classList.remove('on'); return } cap.innerHTML = h; cap.classList.add('on') }
    window.__scroll = (to, ms = 700) => new Promise((done) => {
      const from = window.scrollY, d = to - from, t0 = performance.now()
      const ease = (t) => (t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
      const step = (now) => { const t = Math.min(1, (now - t0) / ms); window.scrollTo(0, from + d * ease(t)); if (t < 1) requestAnimationFrame(step); else done() }
      requestAnimationFrame(step)
    })
    // Highlight a line range and scroll it into the upper part of the viewport, above the caption.
    window.__show = async (id, from, to, ms) => {
      document.querySelectorAll('.ln.hl').forEach((e) => e.classList.remove('hl'))
      for (let i = from; i <= to; i++) document.getElementById(`${id}-${i}`)?.classList.add('hl')
      const first = document.getElementById(`${id}-${from}`)
      const y = first.getBoundingClientRect().top + window.scrollY - 96
      await window.__scroll(Math.max(0, y), ms)
    }
    window.__card = async (id, ms) => {
      const el = document.getElementById(id)
      await window.__scroll(el.getBoundingClientRect().top + window.scrollY, ms)
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install()
})

const hold = (ms) => page.waitForTimeout(Math.round(ms * PACE))
const say = (h) => { cues.push({ at: Number(((Date.now() - T0) / 1000).toFixed(2)), text: h.replace(/<[^>]+>/g, '') }); return page.evaluate((x) => window.__cap(x), h) }
const hush = () => page.evaluate(() => window.__cap(''))
const show = (id, from, to, ms = 800) => page.evaluate(({ id, from, to, ms }) => window.__show(id, from, to, ms), { id, from, to, ms })
const cardTo = (id, ms = 600) => page.evaluate(({ id, ms }) => window.__card(id, ms), { id, ms })
const tag = (on) => page.evaluate((v) => { document.getElementById('__tag').style.display = v ? '' : 'none' }, on)

await page.goto('http://127.0.0.1:8084/', { waitUntil: 'load' })
await tag(false)
await hold(3600)
await tag(true)

await show('sdk', 7, 27)
await say('<b>Arc, USDC and EURC are constants, not configuration.</b> USDC is Arc\'s native gas token — 18 decimals natively, 6 through ERC-20, the same balance seen two ways. Chain 5042002.')
await hold(7200)

await show('deploy', 1, 27)
await say('Six contracts on Arc testnet, all <b>source-verified</b>, pointed at the live USDC and EURC.')
await hold(5600)

await show('pool', 150, 160)
await say('The pool holds <b>USDC as token0</b> and <b>EURC as token1</b>, and reads its rate from the oracle through a rate source.')
await hold(5800)
await show('pool', 199, 212)
await say('<code>_scaled</code> lifts both to 18 decimals and expresses EURC in USDC at the oracle rate — so the curve is centred on the <b>real price</b>, not on 1.00.')
await hold(6400)
await show('pool', 240, 250)
await say('Every swap\'s fee splits <b>in code</b>: half to LPs, half to <code>protocolFees</code>. That is the 12.5bp the business model rests on.')
await hold(6000)

await show('oracle', 149, 180)
await say('The oracle. Publishers sign <b>EIP-712</b> attestations; <code>submit</code> recovers each signer, checks the quorum, and refuses a print outside the deviation cap.')
await hold(7200)
await show('oracle', 194, 206)
await say('<code>getRate</code> takes the caller\'s <b>own staleness bound</b> and reverts past it. A pool never prices off an old number.')
await hold(5800)

await show('settle', 52, 72)
await say('Settlement. An <code>Instruction</code> is denominated in what the <b>payee receives</b>, with the invoice reference carried on-chain.')
await hold(6000)
await show('settle', 98, 122)
await say('<code>swapExactOut</code> delivers exactly that amount <b>straight to the payee</b>, and <code>InvoiceSettled</code> records the reference and the effective rate.')
await hold(6400)

await show('invoice', 137, 162)
await say('This script settled <b>INV-2026-114</b> on testnet: the payer approves USDC to the settlement contract and calls <code>settle</code>; the pool pays EURC to the payee.')
await hold(7000)

await show('pub', 60, 92)
await say('The publisher runs <b>every ten minutes</b> on Netlify: fetches the ECB print, signs it with a key the site holds, pays gas in USDC, submits.')
await hold(6800)
await hush()

await cardTo('c-planned')
await say('What is <b>not</b> in the code yet, said plainly: CCTP v2 and Gateway, Circle Wallets, partner stablecoins as they ship.')
await hold(7600)
await hush()
await cardTo('c-next')
await tag(false)
await hold(3000)

const video = page.video()
const total = Number(((Date.now() - T0) / 1000).toFixed(2))
await ctx.close()
const path = await video.path()
await browser.close(); srv.close()
await writeFile(join(OUT, 'cues.json'), JSON.stringify({ pace: PACE, total, cues }, null, 2))
console.log(`recorded ${path}`)
console.log(`cues     ${cues.length} captions, ${total}s`)
