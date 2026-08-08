// Records a demo video of the desktop app: launches an isolated e2e-style
// instance with CDP, screencasts frames while driving a choreography, and
// writes frames + a duration manifest for ffmpeg assembly.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DESKTOP_DIR = path.resolve(import.meta.dirname, "..");
const OUT_DIR = process.argv[2] ?? "./demo-frames";
const PORT = 9300 + Math.floor(Math.random() * 400);

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-demo-"));
const electronPackage = path.join(DESKTOP_DIR, "node_modules", "electron");
const electronBinary = path.join(
  electronPackage,
  "dist",
  fs.readFileSync(path.join(electronPackage, "path.txt"), "utf-8").trim(),
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CATAMORPHIC_E2E_DATA_DIR = userDataDir;
env.CATAMORPHIC_E2E_FAKE_AGENT = "1";

const child = spawn(electronBinary, [".", `--remote-debugging-port=${PORT}`], {
  cwd: DESKTOP_DIR,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let appOut = "";
const logStream = fs.createWriteStream(path.join(OUT_DIR, "app-output.log"));
child.stdout?.on("data", (c) => { appOut += c; logStream.write(c); });
child.stderr?.on("data", (c) => { appOut += c; logStream.write(c); });
child.on("exit", (code) => console.error(`[app exited: ${code}]`));

async function getPage() {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Electron exited early: ${child.exitCode}\n` + appOut.slice(-2000));
    try {
      const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("no CDP page target\n" + appOut.slice(-2000));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let id = 0;
const pending = new Map();
const frames = [];
let frameIdx = 0;
function wireMessages() { ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === "Page.screencastFrame") {
    const { data, metadata, sessionId } = msg.params;
    const file = path.join(OUT_DIR, `f${String(frameIdx++).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, ts: metadata.timestamp });
    send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  }
}; }
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => {
      if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout: ${method}`)); }
    }, 10_000);
  });
}
// Connect with churn tolerance: a target picked mid-boot can be silently
// dead; verify each connection with a fast ping and retry on silence.
for (let attempt = 0; attempt < 8; attempt++) {
  const page = await getPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error("open timeout")), 5000); });
    wireMessages();
    await Promise.race([
      send("Runtime.enable"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ping silence")), 4000)),
    ]);
    await send("Page.enable");
    console.error(`[cdp connected on attempt ${attempt + 1}]`);
    break;
  } catch (e) {
    console.error(`[connect attempt ${attempt + 1} failed: ${e.message}]`);
    try { ws.close(); } catch {}
    ws = null;
    await sleep(1500);
  }
}
if (!ws) throw new Error("could not establish a live CDP connection");
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

// Wait for the embedded server, then size the window.
for (let i = 0; i < 120; i++) {
  try {
    const ok = await evalJs("window.catamorphicDesktop && window.catamorphicDesktop.getServerState().then(s=>!!s.url)");
    if (ok) break;
  } catch {}
  await sleep(500);
}
try { await evalJs("window.catamorphicDesktop.devWindow('setSize', 1440, 900)"); } catch (e) { console.error("setSize failed:", e.message); }
await sleep(800);

// Seed a project (mirrors e2e flow), landing on a palette New Tab.
await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('New project')).click(); true`);
for (let i = 0; i < 40; i++) { if (await evalJs(`!!document.querySelector('[data-testid=\"project-name-input\"]')`)) break; await sleep(250); }
await evalJs(`(() => {
  const el = document.querySelector('[data-testid="project-name-input"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, 'acme');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
for (let i = 0; i < 40; i++) { if (await evalJs(`!document.querySelector('[data-testid=\"project-submit\"]').disabled`)) break; await sleep(250); }
await evalJs(`document.querySelector('[data-testid="project-submit"]').click(); true`);
for (let i = 0; i < 120; i++) { if (await evalJs(`!document.querySelector('[data-testid=\"project-submit\"]')`)) break; await sleep(500); }
await sleep(1500);
console.error("[project seeded]");

const KEYS = {
  m: { windowsVirtualKeyCode: 77, key: "m", code: "KeyM" },
  "`": { windowsVirtualKeyCode: 192, key: "`", code: "Backquote" },
  p: { windowsVirtualKeyCode: 80, key: "p", code: "KeyP" },
  t: { windowsVirtualKeyCode: 84, key: "t", code: "KeyT" },
  b: { windowsVirtualKeyCode: 66, key: "b", code: "KeyB" },
  n: { windowsVirtualKeyCode: 78, key: "n", code: "KeyN" },
  "[": { windowsVirtualKeyCode: 219, key: "[", code: "BracketLeft" },
  "\\": { windowsVirtualKeyCode: 220, key: "\\", code: "Backslash" },
  Enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Escape: { windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" },
};
async function press(name, modifiers = 0) {
  const k = KEYS[name];
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...k });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k });
}
const CMD = 4;
async function typeText(text, delay = 42) {
  for (const ch of text) {
    await send("Input.insertText", { text: ch });
    await sleep(delay);
  }
}

// Click a question-panel option by its visible text.
async function clickOption(text) {
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('section[aria-label="The agent has a question"] button')]
      .find((b) => b.textContent.trim().includes(${JSON.stringify(text)}));
    if (!btn) throw new Error("option not found: " + ${JSON.stringify(text)});
    btn.click();
    return true;
  })()`);
}

// ---- pre-roll (not recorded): open a browser page for the dock to float over
await typeText("catamorphic.ai", 20); await sleep(300);
await press("Enter"); await sleep(3500);
console.error("[pre-roll done]");

await send("Page.bringToFront").catch((e) => console.error("bringToFront:", e.message));
await sleep(500);
console.error("[recording]"); await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
await sleep(900);

// A. Command palette: Cmd+P overlay, open github.com in a NEW tab (Cmd+Enter)
await press("p", CMD); await sleep(950);
await typeText("github.com", 42); await sleep(650);
await press("Enter", CMD); await sleep(2800);

// B. Floating chat over the page; agent asks structured questions
await press("n", CMD); await sleep(950);
await typeText("Set up this project for me. Ask me a couple of onboarding questions first.", 28);
await sleep(450);
await press("Enter"); await sleep(2800);
await clickOption("Orange"); await sleep(1400);
await clickOption("Cats"); await sleep(900);
await clickOption("Submit"); await sleep(2100);

// C. Agent runs a real command in its own terminal
await typeText("terminal: git log --oneline", 32); await sleep(350);
await press("Enter"); await sleep(4000);

// D. Tile the agent terminal to the side via the surface chip's split button
await evalJs(`(() => {
  const chip = document.querySelector('[data-testid="surface-chip"]');
  const btn = chip && chip.querySelector("button");
  if (!btn) throw new Error("no split button on surface chip");
  btn.click();
  return true;
})()`);
await sleep(2800);

// E. Expand the chat into a full workspace tab
await press("m", CMD | 8); await sleep(2400);

// F. Your own terminal, one keystroke away
await press("`", 2); await sleep(2400);

// G. Tile it with the chat (Cmd+backslash; harmless no-op if unbound)
await press("\\", CMD); await sleep(2000);

// H. End on the agent's terminal: ring + take-over pill
await press("[", CMD); await sleep(1300);
await press("[", CMD); await sleep(1900);

await send("Page.stopScreencast").catch(() => {});
await sleep(300);

fs.writeFileSync(path.join(OUT_DIR, "frames.json"), JSON.stringify(frames, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "app-output.log"), appOut);
console.log(`frames: ${frames.length}, span: ${(frames.at(-1).ts - frames[0].ts).toFixed(1)}s`);

ws.close();
child.kill("SIGTERM");
await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); });
fs.rmSync(userDataDir, { recursive: true, force: true });
