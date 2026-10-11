import fs from "node:fs";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: film scripts run outside turbo
const port = process.env.CDP_PORT;
if (!port) throw new Error("set CDP_PORT to the desktop's debugging port");
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
  r.json(),
);
const target = targets.find(
  (t) =>
    t.type === "page" &&
    !String(t.url).includes("surface=") &&
    !String(t.url).startsWith("chrome-extension:"),
);
if (!target) throw Error("Desktop page not found");
export const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((yes, no) => {
  ws.onopen = yes;
  ws.onerror = no;
});
let seq = 0;
const pending = new Map();
export const events = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  } else events.get(m.method)?.(m.params);
};
// A reply that never comes (a closed socket, a page that went away) fails
// the scene loudly instead of stalling the take.
export const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`CDP ${method} timed out`));
    }, 20000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("close", () => {
  for (const [, p] of pending) p.reject(Error("CDP socket closed"));
  pending.clear();
});
export async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.exception?.description || r.exceptionDetails.text,
    );
  return r.result.value;
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function click(selector, modifiers = 0) {
  const b = await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      ...b,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: 1,
      modifiers,
    });
}
export async function shot(path) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path, Buffer.from(r.data, "base64"));
}
if (process.argv[1]?.endsWith("/cdp.mjs")) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "eval") console.log(JSON.stringify(await evaluate(arg), null, 2));
  if (cmd === "viewport")
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: Number(arg ?? 2),
      mobile: false,
    });
  if (cmd === "clearViewport")
    await send("Emulation.clearDeviceMetricsOverride");
  if (cmd === "shot") await shot(arg);
  if (cmd === "click") await click(arg);
  ws.close();
}
