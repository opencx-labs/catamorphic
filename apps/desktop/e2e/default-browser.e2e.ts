import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<title>External link fixture</title><h1>Opened from another app</h1>",
  );
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/one`, `${origin}/two`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});
describe("default browser links", () => {
  it("retains every cold-launch link until a profile workspace is ready", async () => {
    await app.waitFor(`document.querySelectorAll('webview').length === 2`);
    const urls = await app.eval<string[]>(
      `[...document.querySelectorAll('webview')].map(view=>view.getAttribute('src'))`,
    );
    expect(urls.sort()).toEqual([`${origin}/one`, `${origin}/two`]);
    expect(
      await app.eval("window.catamorphicDesktop.browserTakePendingUrls()"),
    ).toEqual([]);
    expect(app.getRendererErrors()).toEqual([]);
  });
  it("does not change the operating system defaults from a development/test executable", async () => {
    expect(
      await app.eval("window.catamorphicDesktop.defaultBrowserRequest()"),
    ).toMatchObject({ available: false, isDefault: false });
  });
});
