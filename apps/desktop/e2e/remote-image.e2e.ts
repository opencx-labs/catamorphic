import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

// Responses stay unfinished until the test releases them. Approval must not
// change a single bounding box while the network has nothing to show yet.
const pending = new Map<string, ServerResponse>();
const requests = new Map<string, number>();
const chart =
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="128"><rect width="360" height="128" rx="6" fill="#eee8ff"/><path d="M20 100L90 70L160 80L230 45L340 20" fill="none" stroke="#8060c0" stroke-width="3"/></svg>';
const certs = fs.mkdtempSync(path.join(os.tmpdir(), "remote-image-tls-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(certs, "key.pem"),
    "-out",
    path.join(certs, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=Image fixture",
  ],
  { stdio: "ignore" },
);
const server = https.createServer(
  {
    key: fs.readFileSync(path.join(certs, "key.pem")),
    cert: fs.readFileSync(path.join(certs, "cert.pem")),
  },
  (request, response) => {
    const name =
      new URL(request.url ?? "/", "http://fixture").searchParams.get("case") ??
      "";
    requests.set(name, (requests.get(name) ?? 0) + 1);
    pending.set(name, response);
  },
);
let app: AppHandle;
let port: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  port = address.port;
  app = await launchApp();
  // Accept the disposable self-signed fixture in this private renderer.
  // Production certificate checks and CSP stay unchanged.
  await app.cdp("Security.setIgnoreCertificateErrors", { ignore: true });
  await app.waitFor("!!document.querySelector('[data-sidebar=\"left\"]')");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Image consent',rootPath:${JSON.stringify(`${app.userDataDir}/image-consent`)}})`,
  );
  await app.reload();
  await app.waitFor('!!document.querySelector("[data-workspace-ready]")');
});
afterAll(async () => {
  for (const response of pending.values()) response.destroy();
  await app?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(certs, { recursive: true, force: true });
});

const pill = `[...document.querySelectorAll('[data-remote-image-placeholder]')].find(pill=>!pill.parentElement.closest('[inert]')&&!pill.closest('[data-lurking]'))`;
const helpers = `
  const pill = ${pill};
  const frame = pill.parentElement;
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  };
  const geometry = () => [frame,pill,...pill.querySelectorAll('button')].map(rect);
`;
type Rect = { x: number; y: number; width: number; height: number };
const bounds = () =>
  app.eval<Rect[]>(`(() => {${helpers} return geometry();})()`);

async function ask(name: string) {
  await app.waitFor(
    "!!document.querySelector('[data-dock-rail] button[aria-label=\"New chat\"]')",
  );
  await app.eval(
    "document.querySelector('[data-dock-rail] button[aria-label=\"New chat\"]').click(); true",
  );
  await app.waitFor(
    `[...document.querySelectorAll('[data-composer-input]')].some(el => !el.closest('[inert]'))`,
  );
  // Chromium resolves *.localhost to loopback on every supported platform;
  // macOS does not route unconfigured 127.0.0.2-style aliases to this server.
  // Each name is untrusted independently, so the last test can save its host.
  const text = `Here is the weekly chart.\n\n![Weekly progress](https://${name}.localhost:${port}/chart.svg?case=${name})\n\nThe caption stays below the chart.`;
  await app.eval(`(() => {
    ${setReactValueJs}
    const input=[...document.querySelectorAll('[data-composer-input]')].find(el=>!el.closest('[inert]'));
    setReactValue(input,${JSON.stringify(text)});
    input.closest('form').requestSubmit();
  })()`);
  await app.waitFor(
    `!!${pill} && !!document.querySelector('[aria-label*="Session status:"][aria-label*="Ready"]')`,
  );
  await app.eval(
    `document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))`,
  );
  await app.eval(`${pill}.scrollIntoView({block:'nearest'}); true`);
  // Measure consent after the chat/message entrance has actually settled.
  // Ready describes the agent, not its ancestor animations or follow spring.
  await app.waitFor(
    `(async () => {${helpers}
      for(let node=frame;node;node=node.parentElement)
        if(node.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity)) return false;
      const before=geometry();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return geometry().every((box,index)=>['x','y','width','height'].every(axis=>Math.abs(box[axis]-before[index][axis])<0.01));
    })()`,
    { label: "image consent layout at rest" },
  );
}

async function approve(always = false) {
  const point = await app.eval<{ x: number; y: number }>(`(() => {${helpers}
    const button=pill.querySelectorAll('button')[${always ? 1 : 0}];
    const r=button.getBoundingClientRect();
    if (!button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))) throw new Error('Approval is not clickable');
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}

async function unchangedWhileLoading(before: Rect[]) {
  const samples = await app.eval<Rect[][]>(`new Promise(resolve => {${helpers}
    const samples=[];
    const tick=()=>{ samples.push(geometry()); if(samples.length===16) resolve(samples); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })`);
  for (const sample of samples)
    for (const [index, box] of sample.entries())
      for (const axis of ["x", "y", "width", "height"] as const)
        expect(
          Math.abs(box[axis] - before[index]![axis]),
          JSON.stringify({ index, axis, before: before[index], actual: box }),
        ).toBeLessThan(0.75);
  expect(
    await app.eval(
      `!!${pill} && [...${pill}.querySelectorAll('button')].every(button=>button.disabled)`,
    ),
  ).toBe(true);
}

async function requestArrived(name: string, count = 1) {
  // Rendering an <img> does not mean its DNS/TLS handshake has finished.
  // Hold the response after arrival, then measure a genuinely pending load.
  if ((requests.get(name) ?? 0) < count) {
    await new Promise<void>((resolve, reject) => {
      const arrived = () => {
        if ((requests.get(name) ?? 0) < count) return;
        clearTimeout(timeout);
        server.off("request", arrived);
        resolve();
      };
      const timeout = setTimeout(() => {
        server.off("request", arrived);
        reject(
          new Error(
            `Image fixture did not receive request ${count} for ${name}`,
          ),
        );
      }, 15_000);
      server.on("request", arrived);
    });
  }
  expect(requests.get(name)).toBe(count);
}

async function release(name: string, failed = false) {
  const response = pending.get(name);
  expect(response, "image request reached the fixture").toBeDefined();
  pending.delete(name);
  response!.writeHead(failed ? 503 : 200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "no-store",
  });
  response!.end(failed ? "Unavailable" : chart);
  await app.waitFor(
    failed
      ? `!!document.querySelector('[data-remote-image="failed"]')`
      : `!!document.querySelector('[data-remote-image="loaded"]') && !${pill}`,
  );
}

it("holds every approval box until the image is ready, then reveals from those exact dimensions", async () => {
  await ask("once");
  expect(requests.get("once")).toBeUndefined();
  const before = await bounds();
  await approve();
  await app.waitFor(
    `!!document.querySelector('[data-remote-image="loading"] img')`,
  );
  await requestArrived("once");
  await unchangedWhileLoading(before);
  await app.eval(`(() => {${helpers}
    window.imageReveal = new Promise(resolve=>{
      const watch=()=>{
        const animation=frame.getAnimations().find(a=>a.effect.getKeyframes()[0].height);
        if(animation) resolve(animation.effect.getKeyframes());
        else requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
  })()`);
  pending.get("once")!.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "no-store",
  });
  pending.get("once")!.end(chart);
  pending.delete("once");
  const keys =
    await app.eval<Array<{ width: string; height: string }>>(
      "window.imageReveal",
    );
  expect(parseFloat(keys[0]!.width)).toBeCloseTo(before[0]!.width, 1);
  expect(parseFloat(keys[0]!.height)).toBeCloseTo(before[0]!.height, 1);
  await app.waitFor(`!${pill}`);
  expect(
    await app.eval(
      `document.querySelector('[data-remote-image="loaded"] img').getBoundingClientRect().width`,
    ),
  ).toBe(360);
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps the same pill on failure and retries from it", async () => {
  await ask("retry");
  const before = await bounds();
  await approve();
  await requestArrived("retry");
  await unchangedWhileLoading(before);
  await release("retry", true);
  const failed = await bounds();
  for (const [index, box] of failed.entries())
    for (const axis of ["x", "y", "width", "height"] as const)
      expect(Math.abs(box[axis] - before[index]![axis])).toBeLessThan(0.75);
  expect(await app.eval(`${pill}.textContent`)).toContain("Image unavailable");
  await approve();
  await requestArrived("retry", 2);
  await unchangedWhileLoading(before);
  await release("retry");
});

it("holds a wrapped pill in a narrow layout, including with reduced motion", async () => {
  await app.cdp("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await ask("narrow");
  const before = await bounds();
  expect(before[0]!.width).toBeLessThan(340);
  await approve();
  await requestArrived("narrow");
  await unchangedWhileLoading(before);
  await release("narrow");
  expect(
    await app.eval(
      `document.querySelector('[data-remote-image="loaded"]').getAnimations({subtree:true}).length`,
    ),
  ).toBe(0);
  await app.cdp("Emulation.clearDeviceMetricsOverride");
  await app.cdp("Emulation.setEmulatedMedia", { features: [] });
});

it("keeps the pill through host saving and the shared trust refresh", async () => {
  // A slow entrance must finish before its coordinates become the baseline.
  await app.cdp("Animation.enable");
  try {
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 0.1 });
    await ask("always");
  } finally {
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
    await app.cdp("Animation.disable");
  }
  const before = await bounds();
  await approve(true);
  await app.waitFor(
    `!!document.querySelector('[data-remote-image="loading"] img')`,
  );
  await requestArrived("always");
  await unchangedWhileLoading(before);
  await release("always");
  expect(app.getRendererErrors()).toEqual([]);
});
