import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 720 } })
await p.goto('file://' + process.cwd() + '/deck.html', { waitUntil: 'load' })
await p.pdf({ path: 'rialto-deck.pdf', width: '1280px', height: '720px', printBackground: true, preferCSSPageSize: true })
await b.close(); console.log('pdf written')
