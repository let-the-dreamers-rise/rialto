// Synthesize each narration line with Piper and report how it fits the window before the
// next line. Durations are read from the WAV header, so nothing depends on ffmpeg's log.
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, statSync } from 'node:fs'
const VOICE = process.env.VOICE ?? 'en_US-lessac-medium'
const SCALE = process.env.SCALE ?? '1.0'
const TOTAL = Number(process.env.TOTAL ?? 109.9)
const OUT = process.env.OUTDIR ?? `lines-${VOICE}-${SCALE}`
mkdirSync(OUT, { recursive: true })
const lines = JSON.parse(readFileSync(new URL('./lines.json', import.meta.url), 'utf8'))
const wavSeconds = (p) => { const b = readFileSync(p); const rate = b.readUInt32LE(24), ch = b.readUInt16LE(22), bits = b.readUInt16LE(34)
  return (statSync(p).size - 44) / (rate * ch * (bits / 8)) }
let over = 0
for (let i = 0; i < lines.length; i++) {
  const { at, text } = lines[i]
  const win = (i + 1 < lines.length ? lines[i + 1].at : TOTAL) - at
  const out = `${OUT}/${String(i).padStart(2, '0')}.wav`
  const r = spawnSync(process.env.PIPER ?? 'piper', ['--model', `${process.env.VOICES ?? '.'}/${VOICE}.onnx`, '--length-scale', SCALE, '--output_file', out], { input: text, encoding: 'utf8' })
  if (r.status !== 0) { console.log(`${i} piper failed: ${r.stderr.slice(-200)}`); process.exit(1) }
  const d = wavSeconds(out)
  const slack = win - d
  const flag = slack < 0 ? '  <-- OVERRUNS by ' + (-slack).toFixed(1) + 's' : slack < 0.6 ? '  <-- tight' : ''
  if (slack < 0) over++
  console.log(`${String(i).padStart(2, '0')}  at ${at.toFixed(1).padStart(6)}s  window ${win.toFixed(1).padStart(5)}s  speech ${d.toFixed(2).padStart(5)}s${flag}`)
}
console.log(`\n${over} line(s) overrun at length-scale ${SCALE} (${VOICE})`)
