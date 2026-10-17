// CDP driver for UI automation of the desktop app in dev mode. Zero deps
// (uses Node's built-in WebSocket). From the repository root, start the app
// with `bun run dev:desktop`, then set CDP_PORT to the port in the
// development orchestrator's printed `CDP:` URL before invoking this script.
//
// Usage: node scripts/drive.mjs <command> [args...]
//   shot <path>                - screenshot the page to a png
//   click <selector>           - click the center of an element
//   type <selector> <text...>  - click element, then insert text
//   key <key> [mods]           - press a key: a name (Enter, Space, Escape, Tab,
//                                arrows, Home, End, PageUp, PageDown, F6, ...)
//                                or one character; mods as for record
//   eval <js>                  - evaluate JS in the page, print JSON result
//   text <selector>            - print element innerText
//   hover <selector>           - move the pointer over an element
//   wheel <selector> [deltaY]  - scroll the wheel over an element
//   drag <selector> <dx> <dy>  - drag an element by an offset
//   window <maximize|unmaximize|minimize|restore> - window state (dev IPC)
//   window setSize <w> <h>     - resize the window
//   window zoom <factor>       - page zoom (1.3125 lays a 1680x1050 window out at 1280x800)
//   clip <path> <x> <y> <w> <h> [scale] - screenshot a region (CSS pixels), sharp at scale
//   record <out.gif> <x> <y> <w> <h> <steps> - a GIF of a region while steps run
//
// record's <steps> is JSON (or @file.json): an array of { "key": "ArrowDown",
// "mods": 4 } (keys as for `key`; mods: Alt=1, Ctrl=2, Meta=4, Shift=8),
// { "click": selector }, { "move": [x, y] }, { "wheel": selector,
// "deltaY": 120 }, { "eval": js } and { "wait": ms }. Frames come from Chromium's screencast, so motion plays at
// its real pace; ffmpeg (on PATH) crops them and builds the palette. Pull
// requests that change UI show it (AGENTS.md "Pull requests that change
// UI"): record for anything that moves, clip for stills.
//
// Default test viewport: run `window maximize` before screenshotting.
// Screenshots are in device pixels; divide by devicePixelRatio for CSS
// coordinates. CDP_TARGET=main picks the workspace window and
// CDP_TARGET=surface=dock the detached dock (unset, the first page wins).

const PORT = process.env.CDP_PORT ?? "9333";

const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) =>
  r.json(),
);
// CDP_TARGET narrows to the page whose URL contains it (e.g. "surface=dock");
// "main" picks the workspace window, which carries no surface parameter and
// is not the hidden voice audio page; "title=<title>" picks the window of
// that title (its project), where several workspace windows are open.
const wanted = process.env.CDP_TARGET;
const isWorkspace = (url) =>
  !url.includes("surface=") &&
  !url.includes("voice.html") &&
  !url.startsWith("chrome-extension:") &&
  // The pill's drop-target overlay (ADR 0242).
  !url.startsWith("data:");
const matches = (target) => {
  const url = String(target.url);
  if (!wanted) return true;
  if (wanted === "main") return isWorkspace(url);
  if (wanted.startsWith("title="))
    return isWorkspace(url) && target.title === wanted.slice("title=".length);
  return url.includes(wanted);
};
const page = targets.find((t) => t.type === "page" && matches(t));
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
/** What CDP needs to press a named key or a character, as a person does. */
const NAMED_KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  F6: { code: "F6", keyCode: 117 },
};
/**
 * Presses a key (a NAMED_KEYS name or one character) with a modifier
 * bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). Keys that type send their text,
 * so Enter and Space press a focused button; with Alt, Ctrl or Meta held a
 * character is a shortcut and types nothing.
 */
async function pressKey(name, modifiers = 0) {
  const named = NAMED_KEYS[name];
  if (!named && [...name].length !== 1)
    throw new Error(
      `unknown key "${name}" (one character or ${Object.keys(NAMED_KEYS).join(", ")})`,
    );
  const upper = name.toUpperCase();
  const shortcut = (modifiers & 7) !== 0;
  const key = named
    ? {
        key: named.key ?? name,
        code: named.code,
        windowsVirtualKeyCode: named.keyCode,
        text: named.text,
      }
    : {
        key: name,
        code: /[a-z]/i.test(name)
          ? `Key${upper}`
          : /[0-9]/.test(name)
            ? `Digit${name}`
            : undefined,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: shortcut ? undefined : name,
      };
  await send("Input.dispatchKeyEvent", {
    type: key.text ? "keyDown" : "rawKeyDown",
    ...key,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...key,
    text: undefined,
    modifiers,
  });
}

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
    // Optional second arg: modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).
    await pressKey(args[0], Number(args[1] ?? 0));
    console.log("pressed", args[0]);
    break;
  }
  case "wheel": {
    // wheel <selector> [deltaY]: a real mouse-wheel tick over the element,
    // the way a trackpad or mouse scrolls it (synthetic WheelEvents don't).
    const box = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(args[0])});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`not found: ${args[0]}`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: box.x,
      y: box.y,
      deltaX: 0,
      deltaY: Number(args[1] ?? 120),
    });
    console.log("wheeled", args[0]);
    break;
  }
  case "drag": {
    // drag <selector> <dx> [dy]: press on the element, move in steps, release.
    const box = await evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(args[0])});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`not found: ${args[0]}`);
    const dx = Number(args[1] ?? 0);
    const dy = Number(args[2] ?? 0);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x + (dx * step) / 8,
        y: box.y + (dy * step) / 8,
        button: "left",
        buttons: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    if (args[3]) {
      // drag <selector> <dx> <dy> <shot.png>: capture mid-drag, then release.
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(args[3], Buffer.from(shot.data, "base64"));
      console.log(
        "mid-drag",
        await evalJs(
          `JSON.stringify({targets:[...document.querySelectorAll("[data-dock-target]")].map(t=>t.dataset.dockTarget+(t.dataset.active?"*":"")),dragging:document.querySelector("[data-dock-rail]")?.dataset.dockDragging})`,
        ),
      );
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x + dx,
      y: box.y + dy,
      button: "left",
      clickCount: 1,
    });
    console.log("dragged", args[0], dx, dy);
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
        w ? `, ${[w, h].filter(Boolean).map(Number).join(", ")}` : ""
      })`,
    );
    console.log(JSON.stringify(result));
    break;
  }
  case "clip": {
    const [file, x, y, w, h, scale = "2"] = args;
    const r = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: +x, y: +y, width: +w, height: +h, scale: +scale },
    });
    const fs = await import("node:fs");
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("saved", file);
    break;
  }
  case "record": {
    const [file, x, y, w, h, stepsArg] = args;
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const steps = JSON.parse(
      stepsArg?.startsWith("@")
        ? fs.readFileSync(stepsArg.slice(1), "utf8")
        : (stepsArg ?? "[]"),
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-record-"));
    const frames = [];
    const previous = ws.onmessage;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method !== "Page.screencastFrame") return previous(event);
      const frame = path.join(
        dir,
        `${String(frames.length).padStart(5, "0")}.png`,
      );
      fs.writeFileSync(frame, Buffer.from(msg.params.data, "base64"));
      frames.push({ file: frame, at: msg.params.metadata.timestamp });
      void send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const at = async (selector) => {
      const box = await evalJs(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) throw new Error(`not found: ${selector}`);
      return box;
    };
    const ratio = await evalJs("devicePixelRatio");
    await send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await sleep(400);
    for (const step of steps) {
      if (step.wait) await sleep(step.wait);
      else if (step.eval) await evalJs(step.eval);
      else if (step.move)
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: step.move[0],
          y: step.move[1],
        });
      else if (step.wheel)
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...(await at(step.wheel)),
          deltaX: 0,
          deltaY: step.deltaY ?? 120,
        });
      else if (step.click) {
        const box = await at(step.click);
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            ...box,
            button: "left",
            clickCount: 1,
          });
      } else if (step.key) {
        await pressKey(step.key, step.mods ?? 0);
      }
    }
    await sleep(600);
    await send("Page.stopScreencast");
    if (frames.length === 0) throw new Error("no frames captured");
    // A frame comes when something changes: each holds until the next.
    const list = `${frames
      .map(
        (frame, index) =>
          `file '${frame.file}'\nduration ${Math.max(
            0.016,
            (frames[index + 1]?.at ?? frame.at + 0.6) - frame.at,
          ).toFixed(3)}`,
      )
      .join("\n")}\nfile '${frames.at(-1).file}'\n`;
    fs.writeFileSync(path.join(dir, "frames.txt"), list);
    const crop = [w, h, x, y].map((v) => Math.round(Number(v) * ratio));
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      path.join(dir, "frames.txt"),
      "-vf",
      `crop=${crop.join(":")},fps=30,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`,
      file,
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("saved", file, `${frames.length} frames`);
    break;
  }
  default:
    throw new Error(`unknown command: ${cmd}`);
}
ws.close();
