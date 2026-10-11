// Records the workspace window as a timestamped JPEG screencast. The frames
// come at the window's physical size: a 1280x800 window on a Retina display
// gives 2560x1600; on a 1x display, scenes.mjs prep sizes the window to
// 1680x1050 and zooms it by 1.3125 instead. Device-metrics emulation does not
// help: the screencast still arrives at the window's own size.
import fs from "node:fs";
import path from "node:path";
import { events, send, ws } from "./cdp.mjs";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: film scripts run outside turbo
const dir = new URL(`./${process.env.RAW ?? "raw"}/`, import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });
const frames = [];
await new Promise((r) => setTimeout(r, 1200));
const start = performance.now();
fs.writeFileSync(
  new URL("./start.json", import.meta.url),
  JSON.stringify({ start: Date.now() }),
);
let writing = Promise.resolve();
// While a scene waits on the agent it drops a sparse.flag: keep a frame
// every quarter second instead of every one, so a long wait stays small.
const sparseFlag = new URL("./sparse.flag", import.meta.url).pathname;
let lastKept = -1;
events.set("Page.screencastFrame", async (e) => {
  const t = (performance.now() - start) / 1000;
  if (fs.existsSync(sparseFlag) && t - lastKept < 0.25) {
    await send("Page.screencastFrameAck", { sessionId: e.sessionId });
    return;
  }
  lastKept = t;
  const file = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
  frames.push({ file, t, captureTimestamp: e.metadata.timestamp });
  const data = Buffer.from(e.data, "base64");
  writing = writing.then(() =>
    fs.promises.writeFile(path.join(dir, file), data),
  );
  await send("Page.screencastFrameAck", { sessionId: e.sessionId });
});
await send("Page.startScreencast", {
  format: "jpeg",
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: film scripts run outside turbo
  quality: Number(process.env.QUALITY ?? 92),
  maxWidth: 2560,
  maxHeight: 1600,
  everyNthFrame: 1,
});
console.log("RECORDING", new Date().toISOString());
await new Promise((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await send("Page.stopScreencast");
await writing;
const duration = (performance.now() - start) / 1000;
fs.writeFileSync(
  path.join(dir, "manifest.json"),
  // render.py reads the frame size from the frames themselves.
  JSON.stringify({ duration, frames }, null, 2),
);
console.log(JSON.stringify({ duration, frames: frames.length }));
ws.close();
process.exit(0);
