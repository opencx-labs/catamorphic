import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * A call site's microphone, end to end (ADR 0150), the way Google Meet
 * uses it: ask with getUserMedia, then list devices and open the one the
 * person picks. An Allow must leave the page with a live track, labelled
 * devices and a granted permission. When the OS keeps the device from
 * Work, the window says so instead of the site silently failing. The
 * harness gives Chromium a fake capture device, and the OS answer is
 * seeded (CATAMORPHIC_E2E_SYSTEM_MEDIA_ACCESS).
 */
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Call</title><script>
    window.askMic = (constraints = true) => {
      document.title = "asking";
      navigator.mediaDevices.getUserMedia({ audio: constraints }).then(
        (stream) => {
          const track = stream.getAudioTracks()[0];
          window.picked = track.getSettings().deviceId;
          document.title = "mic:" + track.readyState;
          stream.getTracks().forEach((t) => t.stop());
        },
        (error) => { document.title = "mic-error:" + error.name; },
      );
    };
    window.micState = async () => ({
      permission: (await navigator.permissions.query({ name: "microphone" })).state,
      inputs: (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({ id: device.deviceId, label: device.label })),
    });
  </script>`);
});
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => {
  server.close();
});

const guest = `document.querySelector('webview')`;
const modal = `document.querySelector('[data-testid="site-settings-modal"]')`;
/**
 * Escape once the modal can hear it: it takes focus in the same effect
 * that starts listening for keys, a moment after it appears.
 */
const escapeModal = async (app: AppHandle) => {
  await app.waitFor(
    `!!${modal}?.closest('[role="dialog"]')?.contains(document.activeElement)`,
    { label: "modal focused" },
  );
  await app.press("Escape");
};

function helpers(app: () => AppHandle) {
  const inGuest = <T>(code: string) =>
    app().eval<T>(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
  const titleIs = (title: string) =>
    app().waitFor(`${guest}.getTitle() === ${JSON.stringify(title)}`, {
      label: `page title ${title}`,
    });
  const pageReady = () =>
    app().waitFor(
      `(() => { const view = ${guest}; try { return view.getTitle() === 'Call' && !view.isLoading(); } catch { return false; } })()`,
      { label: "call page ready" },
    );
  const click = (testId: string) =>
    app().eval(
      `document.querySelector('[data-testid="${testId}"]').click(); true`,
    );
  return { inGuest, titleIs, pageReady, click };
}

describe("site microphone", () => {
  let app: AppHandle;
  const { inGuest, titleIs, pageReady, click } = helpers(() => app);

  beforeAll(async () => {
    app = await launchApp({ urls: [`${origin}/call`] });
  });
  afterAll(async () => {
    await app?.stop();
  });

  it("asks once and hands the page a live microphone", async () => {
    await pageReady();
    await inGuest("askMic(); true");
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-permission-prompt"]')`,
      { label: "microphone prompt" },
    );
    expect(await app.eval<string>(`${modal}.textContent`)).toContain(
      `${new URL(origin).host} wants to use your microphone`,
    );
    await click("site-permission-allow");
    await titleIs("mic:live");
    await app.waitFor(`!${modal}`, { label: "modal closed" });
  });

  it("leaves devices listed, labelled and selectable, as a call site needs", async () => {
    const state = await inGuest<{
      permission: string;
      inputs: { id: string; label: string }[];
    }>("micState()");
    expect(state.permission).toBe("granted");
    expect(state.inputs.length).toBeGreaterThan(0);
    for (const input of state.inputs) {
      expect(input.id).not.toBe("");
      expect(input.label).not.toBe("");
    }
    // Picking a specific microphone opens it without asking again.
    const wanted = state.inputs.at(-1)?.id ?? "";
    await inGuest(
      `askMic({ deviceId: { exact: ${JSON.stringify(wanted)} } }); true`,
    );
    await titleIs("mic:live");
    expect(await inGuest("window.picked")).toBe(wanted);
    expect(await app.eval(`!!${modal}`)).toBe(false);
  });

  it("remembers the Allow across a reload", async () => {
    await inGuest("location.reload(); true");
    await pageReady();
    await inGuest("askMic(); true");
    await titleIs("mic:live");
    expect(await app.eval(`!!${modal}`)).toBe(false);
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("keeps a native clone live after its original track stops", async () => {
    await inGuest(`navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
      window.liveMic=stream;window.clonedMic=stream.clone();return true;
    })`);
    expect(
      await inGuest("window.liveMic.getTracks().map(t=>t.readyState)"),
    ).toEqual(["live"]);
    expect(
      await inGuest("window.clonedMic.getTracks().map(t=>t.readyState)"),
    ).toEqual(["live"]);
    await inGuest("window.liveMic.getTracks().forEach(t=>t.stop());true");
    expect(
      await inGuest("window.liveMic.getTracks().map(t=>t.readyState)"),
    ).toEqual(["ended"]);
    expect(
      await inGuest("window.clonedMic.getTracks().map(t=>t.readyState)"),
    ).toEqual(["live"]);
    await inGuest("window.clonedMic.getTracks().forEach(t=>t.stop());true");
    expect(
      await inGuest("window.clonedMic.getTracks().map(t=>t.readyState)"),
    ).toEqual(["ended"]);
  });

  it("ends only matching capture and clones when a site permission is blocked", async () => {
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'camera',state:'allow'})`,
    );
    await inGuest(
      `navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(stream=>{window.liveCall=stream;window.clonedCall=stream.clone();return true})`,
    );
    expect(
      await inGuest(
        "window.liveCall.getTracks().every(t=>t.readyState==='live')",
      ),
    ).toBe(true);
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'block'})`,
    );
    await app.waitFor(
      `${guest}.executeJavaScript('[window.liveCall,window.clonedCall].every(s=>s.getAudioTracks().every(t=>t.readyState==="ended")&&s.getVideoTracks().every(t=>t.readyState==="live"))')`,
      { label: "blocking microphone ends audio and preserves camera" },
    );
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'camera',state:'block'})`,
    );
    await app.waitFor(
      `${guest}.executeJavaScript('[window.liveCall,window.clonedCall].every(s=>s.getTracks().every(t=>t.readyState==="ended"))')`,
      { label: "blocking camera ends the remaining video tracks" },
    );
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'allow'})`,
    );
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("ends capture in a same-origin embedded frame when permission is blocked", async () => {
    await inGuest(`new Promise(resolve=>{
      const frame=document.createElement('iframe');frame.src='/call';
      frame.onload=()=>frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{frame.contentWindow.liveMic=stream;resolve(true)});
      frame.id='call-frame';document.body.append(frame);
    })`);
    expect(
      await inGuest(
        "document.getElementById('call-frame').contentWindow.liveMic.getTracks().map(t=>t.readyState)",
      ),
    ).toEqual(["live"]);
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'block'})`,
    );
    await app.waitFor(
      `${guest}.executeJavaScript('document.getElementById("call-frame").contentWindow.liveMic.getTracks().every(t=>t.readyState==="ended")')`,
      { label: "origin revocation reaches embedded capture" },
    );
    await inGuest("document.getElementById('call-frame').remove();true");
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'allow'})`,
    );
  });

  it("revokes a microphone cloned into its parent page through another realm", async () => {
    await inGuest(`new Promise(resolve=>{
      const frame=document.createElement('iframe');frame.src='/call';frame.id='call-frame';
      frame.onload=()=>frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
        frame.contentWindow.liveMic=stream;
        window.parentClone=new MediaStream(stream.getTracks()).clone();
        // Another realm's stop entry point must not lose the clone's capture kind.
        for(const track of stream.getTracks())MediaStreamTrack.prototype.stop.call(track);
        resolve(true);
      });document.body.append(frame);
    })`);
    expect(
      await inGuest(
        "document.getElementById('call-frame').contentWindow.liveMic.getTracks().map(t=>t.readyState)",
      ),
    ).toEqual(["ended"]);
    expect(
      await inGuest("window.parentClone.getTracks().map(t=>t.readyState)"),
    ).toEqual(["live"]);
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'block'})`,
    );
    await app.waitFor(
      `${guest}.executeJavaScript('window.parentClone.getTracks().every(t=>t.readyState==="ended")')`,
      { label: "origin revocation reaches cross-frame clone" },
    );
    await inGuest("document.getElementById('call-frame').remove();true");
    await app.eval(
      `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'allow'})`,
    );
  });

  it("revokes capture from both callback-based browser APIs", async () => {
    for (const name of ["getUserMedia", "webkitGetUserMedia"]) {
      await inGuest(
        `new Promise((resolve,reject)=>navigator[${JSON.stringify(name)}]({audio:true},stream=>{window.callbackMic=stream;resolve(true)},reject))`,
      );
      expect(
        await inGuest("window.callbackMic.getTracks().map(t=>t.readyState)"),
      ).toEqual(["live"]);
      await app.eval(
        `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'block'})`,
      );
      await app.waitFor(
        `${guest}.executeJavaScript('window.callbackMic.getTracks().every(t=>t.readyState==="ended")')`,
        { label: `${name} native capture revoked` },
      );
      await app.eval(
        `window.catamorphicDesktop.siteSettingsSet({origin:${JSON.stringify(origin)},kind:'microphone',state:'allow'})`,
      );
    }
  });
});

describe("site microphone the OS refuses", () => {
  let app: AppHandle;
  const { inGuest, titleIs, pageReady, click } = helpers(() => app);

  beforeAll(async () => {
    app = await launchApp({
      urls: [`${origin}/call`],
      env: { CATAMORPHIC_E2E_SYSTEM_MEDIA_ACCESS: "denied" },
    });
  });
  afterAll(async () => {
    await app?.stop();
  });

  it("explains, after Allow, that the Mac keeps the microphone from Work", async () => {
    await pageReady();
    await inGuest("askMic(); true");
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-permission-prompt"]')`,
      { label: "microphone prompt" },
    );
    await click("site-permission-allow");
    await titleIs("mic-error:NotAllowedError");
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-system-refusal"]')`,
      { label: "refusal notice" },
    );
    const text = await app.eval<string>(`${modal}.textContent`);
    expect(text).toContain(
      `${new URL(origin).host} is allowed, but this Mac keeps your microphone from Work`,
    );
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="site-system-refusal-open-microphone"]')`,
      ),
    ).toBe(true);
    // The site's own choice stands; only the OS is in the way.
    expect(
      await app.eval(
        `document.querySelector('[data-testid="site-settings-permissions"]').dataset.open`,
      ),
    ).toBe("false");
  });

  it("says it once per page, not on every retry", async () => {
    await escapeModal(app);
    await app.waitFor(`!${modal}`, { label: "notice closed" });
    // Mark the page first so the retry's own failure is what settles.
    await inGuest("document.title = 'retry'; true");
    await titleIs("retry");
    await inGuest("askMic(); true");
    await titleIs("mic-error:NotAllowedError");
    // Main sends any notice before the page hears its refusal; give the
    // window a beat to have shown one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await app.eval(`!!${modal}`)).toBe(false);
    // A fresh page load earns a fresh explanation.
    await inGuest("location.reload(); true");
    await pageReady();
    await inGuest("askMic(); true");
    await titleIs("mic-error:NotAllowedError");
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-system-refusal"]')`,
      { label: "notice after reload" },
    );
    await escapeModal(app);
    await app.waitFor(`!${modal}`, { label: "notice closed again" });
    expect(app.getRendererErrors()).toEqual([]);
  });
});
