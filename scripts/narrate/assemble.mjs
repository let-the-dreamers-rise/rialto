// Lay the synthesized lines onto the recording at the cue times and mux the result.
//
//   node assemble.mjs <cues.json> <lines-dir> <video.mp4> <out.mp4>
//
// Cue i is matched to line i by order. Each WAV is delayed to its cue, all are mixed onto
// silence, loudness-normalised, and muxed with the video stream copied untouched.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [cuesPath, dir, video, out] = process.argv.slice(2)
const FF = process.env.FFMPEG ?? 'ffmpeg'
const { cues, total } = JSON.parse(readFileSync(cuesPath, 'utf8'))
const lines = JSON.parse(readFileSync(new URL('./lines.json', import.meta.url), 'utf8'))
if (cues.length !== lines.length) throw new Error(`${cues.length} cues but ${lines.length} lines`)

const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video]
const parts = []
lines.forEach((_, i) => {
  args.push('-i', `${dir}/${String(i).padStart(2, '0')}.wav`)
  const ms = Math.round(cues[i].at * 1000)
  parts.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}|${ms}[a${i}]`)
})
const mix = lines.map((_, i) => `[a${i}]`).join('')
const graph = parts.join(';')
  + `;${mix}amix=inputs=${lines.length}:normalize=0:dropout_transition=0,`
  + `apad=whole_dur=${total},loudnorm=I=-16:TP=-1.5:LRA=11[voice]`
args.push('-filter_complex', graph, '-map', '0:v', '-map', '[voice]',
  '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out)
const r = spawnSync(FF, args, { encoding: 'utf8' })
if (r.status !== 0) { console.error(r.stderr); process.exit(1) }
const probe = spawnSync(FF, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr
console.log(probe.split('\n').filter((l) => /Duration|Stream/.test(l)).join('\n'))
console.log(`wrote ${out}`)
