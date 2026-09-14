#!/usr/bin/env bash
# Produce the demo video end to end: snapshot the live site, record the walkthrough, encode.
#
#   scripts/render-video.sh [out.mp4]
#
# Needs a full ffmpeg on PATH or in FFMPEG (Playwright's bundled build only writes VP8), and
# a Chromium at CHROME (default: Playwright's). The feed should be fresh but older than 60s
# when the snapshot is taken, so the 60-second bound in the recording reverts for real and
# the 15-minute one succeeds — the script waits for that rather than faking either.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-rialto-demo.mp4}
SITE=${SITE:-https://rialto-arc.netlify.app}
FFMPEG=${FFMPEG:-$(command -v ffmpeg || true)}
[ -n "$FFMPEG" ] || { echo "no ffmpeg: set FFMPEG=/path/to/ffmpeg (needs libx264)" >&2; exit 1; }
SNAP=$(mktemp -d)
VID=$(mktemp -d)
trap 'rm -rf "$SNAP" "$VID"' EXIT

echo "==> refreshing the feed"
node scripts/publish-rate.mjs >/dev/null

echo "==> waiting for the feed to pass the 60s bound"
for _ in $(seq 1 40); do
  age=$(curl -sS --max-time 30 "$SITE/api/state" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).oracle.ageSeconds))')
  [ "${age:-0}" -gt 65 ] && break
  sleep 5
done
echo "    feed age ${age}s"

echo "==> snapshotting $SITE"
mkdir -p "$SNAP/api"
for f in index.html live-forward.json live-invoice.json corridors.json last-publish.json favicon.svg; do
  curl -sS --max-time 30 "$SITE/$f" -o "$SNAP/$f"
done
curl -sS --max-time 40 "$SITE/api/state" -o "$SNAP/api/state.json"
for b in 60 900 3600 86400; do
  curl -sS --max-time 40 "$SITE/api/getRate?maxAge=$b" -o "$SNAP/api/getRate-$b.json"
done
node -e '
  const s=require(process.argv[1]+"/api/state.json"), a=require(process.argv[1]+"/api/getRate-60.json"), b=require(process.argv[1]+"/api/getRate-900.json");
  console.log("    age", s.oracle.ageSeconds+"s | 60s ->", a.ok?"ok":"REVERT", "| 900s ->", b.ok?"ok":"REVERT");
  if (a.ok || !b.ok) { console.error("    snapshot does not have the revert/success pair the recording narrates"); process.exit(1) }
' "$SNAP"

echo "==> recording"
SNAP="$SNAP" OUT="$VID" PACE="${PACE:-1.5}" node scripts/demo-video.mjs
WEBM=$(ls "$VID"/*.webm | head -1)

echo "==> encoding $OUT"
"$FFMPEG" -hide_banner -loglevel error -y -i "$WEBM" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart -r 25 "$OUT"

# Narration is optional: it needs Piper and a voice model (see scripts/narrate/README.md).
# The silent, captioned cut is complete on its own; the voiced one is laid on top of it.
if [ -n "${NARRATE:-}" ]; then
  echo "==> narrating"
  LINES=$(mktemp -d)
  OUTDIR="$LINES" VOICES="${VOICES:-.}" node scripts/narrate/synth.mjs
  # The recorder logs a cue per caption; the title and end cards bracket them.
  node -e '
    const fs=require("fs"); const rec=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const endAt=Number((rec.total-5.2*rec.pace).toFixed(2));
    fs.writeFileSync(process.argv[2], JSON.stringify({ total: rec.total,
      cues: [{at:0.5,text:"title"}, ...rec.cues, {at:endAt,text:"end"}] }));
  ' "$VID/cues.json" "$LINES/cues19.json"
  FFMPEG="$FFMPEG" node scripts/narrate/assemble.mjs "$LINES/cues19.json" "$LINES" "$OUT" "${OUT%.mp4}-narrated.mp4"
  rm -rf "$LINES"
fi
"$FFMPEG" -hide_banner -i "$OUT" 2>&1 | grep -E 'Duration|Stream' || true
echo "==> done: $OUT"
