import fs from "node:fs";

const port = process.env.CDP_PORT;
if (!port) throw new Error("set CDP_PORT to the desktop's debugging port");
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
  r.json(),
);
const target = targets.find(
  (t) => t.type === "page" && !String(t.url).includes("surface="),
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
export const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
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
      deviceScaleFactor: 1,
      mobile: false,
    });
  if (cmd === "shot") await shot(arg);
  if (cmd === "click") await click(arg);
  ws.close();
}
