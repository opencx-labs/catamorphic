import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  if (request.url === "/plain.txt") {
    response.setHeader("Content-Type", "text/plain");
    response.end("Readable plain text");
    return;
  }
  response.setHeader("Content-Type", "text/html");
  const color = request.url === "/light" ? "#efe7d1" : "#121212";
  response.end(`<!doctype html><title>Page canvas</title><style>
    body { margin:0; height:100vh; background:${color}; color:white; }
    main { height:5000px; }
  </style><main>Scroll beyond the body's own box</main>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/dark`] });
  await app.waitFor(
    `(() => { try { const view=document.querySelector('webview'); return view?.getTitle()==='Page canvas' && !view.isLoading(); } catch { return false; } })()`,
  );
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = "document.querySelector('webview')";
const inside = <T>(code: string) =>
  app.eval<T>(`${guest}.executeJavaScript(${JSON.stringify(code)})`);
const canvasPixel = () =>
  app.eval<number[]>(`(async () => {
  await ${guest}.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const image = await ${guest}.capturePage();
  const img = new Image(); img.src=image.toDataURL(); await img.decode();
  const canvas = document.createElement('canvas'); canvas.width=img.width; canvas.height=img.height;
  const context=canvas.getContext('2d'); context.drawImage(img,0,0);
  return Array.from(context.getImageData(img.width-30,img.height-30,1,1).data);
})()`);

describe("browser page canvas", () => {
  it.each([
    { route: "dark", pixel: [18, 18, 18, 255] },
    { route: "light", pixel: [239, 231, 209, 255] },
  ])(
    "keeps a $route body's background on the canvas after scrolling",
    async ({ route, pixel }) => {
      await app.eval(
        `${guest}.loadURL(${JSON.stringify(`${origin}/`)}+${JSON.stringify(route)})`,
      );
      await app.waitFor(
        `(() => { try { return ${guest}.getTitle()==='Page canvas' && !${guest}.isLoading(); } catch { return false; } })()`,
      );
      await inside("scrollTo(0,1800)");
      await app.waitFor(`${guest}.executeJavaScript('scrollY >= 1800')`);
      await inside(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      expect(
        await inside(
          "getComputedStyle(document.documentElement).backgroundColor",
        ),
      ).toBe("rgba(0, 0, 0, 0)");
      expect(await canvasPixel()).toEqual(pixel);
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir,
          `browser-canvas-${route}.png`,
        ),
      );
    },
  );

  it("gives an unstyled plain-text viewer an opaque readable canvas", async () => {
    await app.eval(
      `${guest}.loadURL(${JSON.stringify(`${origin}/plain.txt`)})`,
    );
    await app.waitFor(
      `${guest}.executeJavaScript('document.body.textContent.includes("Readable plain text")')`,
    );
    const [red, green, blue, alpha] = await canvasPixel();
    expect(alpha).toBe(255);
    const foreground = await inside<string>(
      "getComputedStyle(document.body).color",
    );
    const components = foreground.match(/\d+/g)?.map(Number) ?? [];
    const luminance = (values: number[]) =>
      values
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) =>
            sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0),
          0,
        );
    const background = luminance([red ?? 0, green ?? 0, blue ?? 0]);
    const text = luminance(components.slice(0, 3));
    expect(
      (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05),
    ).toBeGreaterThan(4.5);
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("follows the page's own root background and color-scheme changes", async () => {
    await inside(
      "document.documentElement.style.backgroundColor='rgb(23,56,39)'",
    );
    expect(await canvasPixel()).toEqual([23, 56, 39, 255]);
    await inside(
      "document.documentElement.style.backgroundColor=''; document.documentElement.style.colorScheme='light'",
    );
    expect(await canvasPixel()).toEqual([255, 255, 255, 255]);
    await inside("document.documentElement.style.colorScheme='dark'");
    const dark = await canvasPixel();
    expect(dark[3]).toBe(255);
    expect(dark.slice(0, 3).every((channel) => channel < 80)).toBe(true);
  });
});
