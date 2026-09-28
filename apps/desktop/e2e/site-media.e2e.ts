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
    await app.press("Escape");
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
    await app.press("Escape");
    await app.waitFor(`!${modal}`, { label: "notice closed again" });
    expect(app.getRendererErrors()).toEqual([]);
  });
});
