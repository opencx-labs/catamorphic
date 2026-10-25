import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Video one</title><h1>Video one</h1>
    <script>
      const show = () => {
        const name = new URL(location).searchParams.get('video') || 'one';
        document.title = 'Video ' + name;
        document.querySelector('h1').textContent = document.title;
      };
      window.autoplay = (name) => setTimeout(() => {
        history.pushState({ video: name }, '', '?video=' + name);
        show();
      }, 0);
      addEventListener('popstate', show);
      show();
    </script>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/watch?video=one`] });
  await ready("one");
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const view = "document.querySelector('webview')";
const ready = (name: string) =>
  app.waitFor(
    `(() => { try { return ${view}.getTitle() === ${JSON.stringify(`Video ${name}`)} && !${view}.isLoading(); } catch { return false; } })()`,
    { label: `Video ${name}` },
  );
const page = (expression: string) =>
  app.eval(`${view}.executeJavaScript(${JSON.stringify(expression)}, false)`);

it("keeps the previous autoplayed video reachable from the back button", async () => {
  expect(await page("navigator.userActivation.hasBeenActive")).toBe(false);
  await page("window.autoplay('two'); true");
  await ready("two");
  const history = await app.eval<{ entries: { url: string }[]; index: number }>(
    `window.catamorphicDesktop.browserNavigationHistory({guestId:${view}.getWebContentsId()})`,
  );
  expect(history.entries.map((entry) => entry.url)).toEqual([
    `${origin}/watch?video=one`,
    `${origin}/watch?video=two`,
  ]);
  expect(history.index).toBe(1);
  await app.waitFor(
    "!document.querySelector('button[aria-label=Back]').disabled",
    {
      label: "back enabled after automatic navigation",
    },
  );
  const point = await app.eval<{ x: number; y: number }>(`(() => {
    const r=document.querySelector('button[aria-label=Back]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await app.clickPointer(point);
  await ready("one");
});

it("returns to the preceding video after an automatic full-page navigation", async () => {
  await page("location.assign('/watch?video=full-one');true");
  await ready("full-one");
  await page("setTimeout(()=>location.assign('/watch?video=full-two'),0);true");
  await ready("full-two");
  await app.waitFor(
    "!document.querySelector('button[aria-label=Back]').disabled",
  );
  const point = await app.eval<{ x: number; y: number }>(`(() => {
    const r=document.querySelector('button[aria-label=Back]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await app.clickPointer(point);
  await ready("full-one");
  const forward = await app.eval<{ x: number; y: number }>(`(() => {
    const r=document.querySelector('button[aria-label=Forward]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await app.clickPointer(forward);
  await ready("full-two");
  expect(app.getRendererErrors()).toEqual([]);
});
