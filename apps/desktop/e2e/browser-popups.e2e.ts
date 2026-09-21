import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Sign-in popups (Google Identity Services, most OAuth providers) report
 * back through `window.opener`. Opening them as detached workspace tabs
 * left a blank page and a sign-in that never finished.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url?.startsWith("/popup")) {
    response.end(`<title>Popup</title><script>
      window.opener?.postMessage("signed-in", "*");
      window.close();
    </script>`);
    return;
  }
  response.end(`<title>Opener</title><script>
    addEventListener("message", (event) => {
      document.title = "got:" + event.data;
    });
  </script>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/opener`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const inGuest = (code: string) =>
  app.eval(
    `document.querySelector('webview').executeJavaScript(${JSON.stringify(code)}, true)`,
  );

describe("browser popups", () => {
  it("keeps a scripted popup attached to its opener", async () => {
    await app.waitFor(`document.querySelectorAll('webview').length === 1`);
    await app.waitFor(
      `document.querySelector('webview').getTitle?.() === 'Opener'`,
    );
    await inGuest(
      `window.open(${JSON.stringify(`${origin}/popup`)}, "signin", "width=480,height=640"); true`,
    );
    await app.waitFor(
      `document.querySelector('webview').getTitle() === 'got:signed-in'`,
    );
    // The popup was a window of its own, never a workspace tab.
    expect(await app.eval(`document.querySelectorAll('webview').length`)).toBe(
      1,
    );
  });

  it("still opens a plain new-tab request as a workspace tab", async () => {
    await inGuest(`window.open(${JSON.stringify(`${origin}/two`)}); true`);
    await app.waitFor(`document.querySelectorAll('webview').length === 2`);
  });

  // A self-closed page used to leave a dead, blank guest that kept focus
  // and swallowed Cmd+W.
  it("closes the tab when its page closes itself", async () => {
    const two = `[...document.querySelectorAll('webview')].find(view => view.getAttribute('src')?.endsWith('/two'))`;
    await app.waitFor(
      `${two}?.getTitle?.() !== undefined && !${two}.isLoading()`,
    );
    await app.eval(`${two}.executeJavaScript('window.close(); true', true)`);
    await app.waitFor(`document.querySelectorAll('webview').length === 1`);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
