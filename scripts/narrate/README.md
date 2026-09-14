# Narration

The demo video's voice is synthesised offline with [Piper](https://github.com/rhasspy/piper),
placed at the caption timestamps the recorder logs, and mixed under the picture. No hosted
service, no credits, no account: the same input produces the same video on any machine.

```bash
pip install piper-tts                       # the engine
# a voice: ~63 MB, not committed — en_US-lessac-medium from rhasspy/piper-voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
curl -LO $B/en_US-lessac-medium.onnx && curl -LO $B/en_US-lessac-medium.onnx.json

node scripts/narrate/synth.mjs              # lines.json -> one WAV per line, with a fit report
node scripts/narrate/assemble.mjs <cues.json> <lines-dir> <video.mp4> <out.mp4>
```

`lines.json` is the spoken script — sparser than the captions on purpose, since the captions
carry the detail and a voice reading them verbatim would race. Line *i* is spoken at cue *i*:
the title card, then the seventeen captions in the order the recorder shows them, then the
end card. `synth.mjs` reports how each line fits the window before the next cue; an overrun
means two lines would talk over each other, so `assemble.mjs` is only run on a clean report.

The recorder writes `cues.json` alongside the WebM. At `PACE=1` two lines overrun; `PACE=1.5`
(the shipped cut, 2:38) gives every line room, and the captions more time to be read.
