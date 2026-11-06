// Shared driving helpers for the v5 film. Every pointer event is also
// logged to pointer.jsonl (seconds from the capture start, CSS pixels), so
// the render can draw the cursor CDP input never shows on screen.
import fs from "node:fs";
import { evaluate, pause, send } from "./cdp.mjs";

export { evaluate, pause, send };

const here = new URL(".", import.meta.url).pathname;
function since() {
  try {
    return (
      (Date.now() - JSON.parse(fs.readFileSync(`${here}start.json`)).start) /
      1000
    );
  } catch {
    return null;
  }
}
export function mark(event) {
  const t = since();
  if (t === null) return console.log("(no capture running)", event);
  fs.appendFileSync(
    `${here}markers.jsonl`,
    `${JSON.stringify({ t, event })}\n`,
  );
  console.log(t.toFixed(2), event);
}
function logPointer(entry) {
  const t = since();
  if (t !== null)
    fs.appendFileSync(
      `${here}pointer.jsonl`,
      `${JSON.stringify({ t, ...entry })}\n`,
    );
}
const state = JSON.parse(
  (() => {
    try {
      return fs.readFileSync(`${here}pointer-state.json`, "utf8");
    } catch {
      return '{"x":1220,"y":430}';
    }
  })(),
);
let pointer = { x: state.x, y: state.y };
function remember() {
  fs.writeFileSync(`${here}pointer-state.json`, JSON.stringify(pointer));
}
export async function mouse(type, x, y, extra = {}) {
  pointer = { x, y };
  logPointer({
    type,
    x,
    y,
    ...(extra.modifiers ? { modifiers: extra.modifiers } : {}),
  });
  await send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
    ...extra,
  });
  remember();
}
export async function wheel(x, y, deltaY) {
  pointer = { x, y };
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY,
  });
}
// macOS hides the pointer while you type; the render follows these marks.
export const typingStarts = () => logPointer({ type: "hide" });
const jitter = (base, spread) => base + Math.random() * spread;
export async function type(text, { fast = false } = {}) {
  typingStarts();
  for (const char of text) {
    await send("Input.insertText", { text: char });
    const k = fast ? 0.7 : 1;
    await pause(k * (char === " " ? jitter(70, 50) : jitter(38, 40)));
    if (/[,.!?:]/.test(char)) await pause(k * jitter(110, 80));
  }
}
export async function enter() {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}
export async function selectAll() {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    commands: ["selectAll"],
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    windowsVirtualKeyCode: 65,
  });
}
export async function backspace(n = 1) {
  for (let i = 0; i < n; i += 1) {
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await pause(jitter(45, 30));
  }
}
export async function until(expression, label, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return;
    await pause(300);
  }
  throw new Error(`timeout: ${label}`);
}
// Glides the pointer along an eased path, the way a hand moves a mouse:
// quick in the middle, settling at the target. Duration scales with distance.
export async function moveTo(x, y, ms) {
  const from = { ...pointer };
  const dist = Math.hypot(x - from.x, y - from.y);
  if (dist < 1) return;
  const duration = ms ?? Math.min(650, Math.max(220, 160 + dist * 0.55));
  const steps = Math.max(6, Math.round(duration / 16));
  // A slight arc reads as a hand, not a robot.
  const bend = Math.min(40, dist * 0.08) * (Math.random() < 0.5 ? -1 : 1);
  const nx = -(y - from.y) / (dist || 1);
  const ny = (x - from.x) / (dist || 1);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const arc = Math.sin(Math.PI * e) * bend;
    await mouse(
      "mouseMoved",
      from.x + (x - from.x) * e + nx * arc,
      from.y + (y - from.y) * e + ny * arc,
    );
    await pause(16);
  }
}
export async function boxOf(expression) {
  return evaluate(
    `(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y }; })()`,
  );
}
export async function pressAt({ x, y }, { modifiers = 0, glide = true } = {}) {
  if (glide) await moveTo(x, y);
  else await mouse("mouseMoved", x, y);
  await pause(120);
  await mouse("mousePressed", x, y, { modifiers });
  await pause(85);
  await mouse("mouseReleased", x, y, { modifiers });
}
export async function clickEl(expression, label = expression, opts = {}) {
  const box = await boxOf(expression);
  if (!box) throw new Error(`missing ${label}`);
  await pressAt(box, opts);
  return box;
}
export const clickAt = (selector, opts) =>
  clickEl(
    `document.querySelector(${JSON.stringify(selector)})`,
    selector,
    opts,
  );
export const park = (x = 1220, y = 430) => moveTo(x, y);
// A trackpad flick: many small wheel ticks, fast first and settling.
export async function flick(x, y, total, ms) {
  const step = 16;
  const ticks = Math.max(1, Math.round(ms / step));
  let sent = 0;
  for (let i = 1; i <= ticks; i += 1) {
    const eased = 1 - (1 - i / ticks) ** 3;
    const delta = Math.round(total * eased) - sent;
    sent += delta;
    if (delta !== 0) await wheel(x, y, delta);
    await pause(step);
  }
}
export const visible = `[data-workspace-visible="true"]`;
export const visibleStatuses = `[...document.querySelectorAll('[data-testid=session-inspector-trigger]')].filter(e => e.getClientRects().length).map(e => e.getAttribute('aria-label') || '')`;
export const chatWorking = `(${visibleStatuses}).some(s => /Working|Starting|Running/.test(s))`;
export const chatIdle = `(() => { const s = ${visibleStatuses}; return s.some(x => /Ready|Idle/.test(x)) && !s.some(x => /Working|Starting|Running/.test(x)); })()`;
export const composer = `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`;
