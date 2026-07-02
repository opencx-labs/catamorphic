// Cuts chapter clips (c1..c6.mp4) out of the raw capture using the phase
// markers emitted by capture.mjs, applying an 8x timelapse to the "agent is
// working" wait. Writes clip durations to video/clips.json for the Revideo
// composition. Usage: node cut.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;
const OUT = path.join(DIR, "out");
const PUBLIC = path.join(DIR, "public");
const SPEEDUP = 8;

const { videoPath, markers } = JSON.parse(
  readFileSync(path.join(OUT, "markers.json"), "utf8"),
);
const at = (name) => {
  const marker = markers.find((m) => m.name === name);
  if (!marker) throw new Error(`Missing marker: ${name}`);
  return marker.at / 1000;
};

mkdirSync(PUBLIC, { recursive: true });

const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });

const FULL = path.join(OUT, "full.mp4");
ffmpeg([
  "-i", videoPath,
  "-r", "30",
  "-c:v", "libx264",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  FULL,
]);

const simpleCut = (name, start, end) => {
  ffmpeg([
    "-i", FULL,
    "-ss", String(start),
    "-to", String(end),
    "-c:v", "libx264",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    path.join(PUBLIC, `${name}.mp4`),
  ]);
  return end - start;
};

/** Cut with a sped-up middle section (the agent wait). */
const timelapseCut = (name, start, fastStart, fastEnd, end) => {
  ffmpeg([
    "-i", FULL,
    "-filter_complex",
    [
      `[0:v]trim=start=${start}:end=${fastStart},setpts=PTS-STARTPTS[a]`,
      `[0:v]trim=start=${fastStart}:end=${fastEnd},setpts=(PTS-STARTPTS)/${SPEEDUP}[b]`,
      `[0:v]trim=start=${fastEnd}:end=${end},setpts=PTS-STARTPTS[c]`,
      "[a][b][c]concat=n=3:v=1:a=0[out]",
    ].join(";"),
    "-map", "[out]",
    "-r", "30",
    "-c:v", "libx264",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    path.join(PUBLIC, `${name}.mp4`),
  ]);
  return (
    (fastStart - start) + (fastEnd - fastStart) / SPEEDUP + (end - fastEnd)
  );
};

const durations = {
  c1: simpleCut("c1", at("app-loaded") + 0.2, at("chat-typing-start")),
  c2: timelapseCut(
    "c2",
    at("chat-typing-start"),
    at("agent-prompt-sent") + 4.0,
    at("agent-replied") - 1.5,
    at("open-workflow"),
  ),
  c3: simpleCut("c3", at("open-workflow"), at("run-click")),
  c4: simpleCut("c4", at("run-click"), at("deploy-click")),
  c5: simpleCut("c5", at("deploy-click"), at("code-tab")),
  c6: simpleCut("c6", at("code-tab"), at("end")),
};

writeFileSync(
  path.join(DIR, "video", "clips.json"),
  JSON.stringify(durations, null, 2),
);
console.log(durations);
