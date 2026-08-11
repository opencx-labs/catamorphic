// Assemble screencast frames (variable timing) into an mp4 via ffmpeg
// concat demuxer, honoring per-frame durations from frames.json.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2] ?? "./demo-frames";
const OUT = process.argv[3] ?? "./desktop-demo.mp4";
const frames = JSON.parse(fs.readFileSync(path.join(DIR, "frames.json")));
if (frames.length < 10) throw new Error(`too few frames: ${frames.length}`);

let list = "";
for (let i = 0; i < frames.length; i++) {
  const dur = i < frames.length - 1 ? frames[i + 1].ts - frames[i].ts : 0.5;
  list += `file '${path.resolve(frames[i].file)}'\n`;
  list += `duration ${Math.max(dur, 0.016).toFixed(4)}\n`;
}
// concat demuxer quirk: repeat last file without duration
list += `file '${path.resolve(frames.at(-1).file)}'\n`;
const listPath = path.join(DIR, "concat.txt");
fs.writeFileSync(listPath, list);

execFileSync(
  "ffmpeg",
  [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    "fps=30,scale=1280:-2:flags=lanczos,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "22",
    "-preset",
    "slow",
    "-movflags",
    "+faststart",
    OUT,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);

const size = fs.statSync(OUT).size;
console.log(`wrote ${OUT} (${(size / 1024 / 1024).toFixed(2)} MB)`);
