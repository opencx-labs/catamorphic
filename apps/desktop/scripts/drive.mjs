// CDP driver for UI automation of the desktop app in dev mode. Zero deps
// (uses Node's built-in WebSocket). Start the app with:
//   env -u ELECTRON_RUN_AS_NODE bunx electron-vite dev -- --remote-debugging-port=9333
//
// Usage: node scripts/drive.mjs <command> [args...]
//   shot <path>                - screenshot the page to a png
//   click <selector>           - click the center of an element
//   type <selector> <text...>  - click element, then insert text
//   key <Enter|Escape|Tab>     - press a key
//   eval <js>                  - evaluate JS in the page, print JSON result
//   text <selector>            - print element innerText
//   window <maximize|unmaximize|minimize|restore> - window state (dev IPC)
//   window setSize <w> <h>     - resize the window
//
// Default test viewport: run `window maximize` before screenshotting.

const PORT = process.env.CDP_PORT ?? "9333";

const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) =>
  r.json(),
);
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target — is the app running with CDP?");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`,
    );
  }
  return r.result.value;
}

async function click(selector) {
  const box = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`not found: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "shot": {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const fs = await import("node:fs");
    fs.writeFileSync(args[0], Buffer.from(r.data, "base64"));
    console.log("saved", args[0]);
    break;
  }
  case "click":
    await click(args[0]);
    console.log("clicked", args[0]);
    break;
  case "hover": {
    const box = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(args[0])});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`not found: ${args[0]}`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
    });
    console.log("hovering", args[0]);
    break;
  }
  case "type": {
    await click(args[0]);
    await send("Input.insertText", { text: args.slice(1).join(" ") });
    console.log("typed into", args[0]);
    break;
  }
  case "key": {
    const keyMap = {
      Enter: {
        windowsVirtualKeyCode: 13,
        key: "Enter",
        code: "Enter",
        text: "\r",
      },
      Escape: { windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" },
      Tab: { windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" },
    };
    const k = keyMap[args[0]] ?? { key: args[0] };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    console.log("pressed", args[0]);
    break;
  }
  case "eval":
    console.log(JSON.stringify(await evalJs(args.join(" ")), null, 2));
    break;
  case "text":
    console.log(
      await evalJs(
        `document.querySelector(${JSON.stringify(args[0])})?.innerText ?? "(not found)"`,
      ),
    );
    break;
  case "window": {
    // Electron's CDP endpoint lacks Browser.setWindowBounds, so window
    // geometry goes through the dev-only IPC exposed in main (ipc.ts).
    const [action, w, h] = args;
    const result = await evalJs(
      `window.catamorphicDesktop.devWindow(${JSON.stringify(action)}${
        w ? `, ${Number(w)}, ${Number(h)}` : ""
      })`,
    );
    console.log(JSON.stringify(result));
    break;
  }
  default:
    throw new Error(`unknown command: ${cmd}`);
}
ws.close();
