import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Site settings (ADR 0149): a page's permission request opens the site
 * settings modal centered with the question first; Allow is remembered
 * for the site; the toolbar gear reopens the same modal with everything
 * laid out; the Sites page lists the site; Delete data clears its cookies.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Lab</title><script>
    document.cookie = "lab=1; path=/";
    window.askNotifications = () => {
      document.title = "asking";
      Notification.requestPermission().then((r) => { document.title = "perm:" + r; });
    };
  </script>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/lab`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = `document.querySelector('webview')`;
const inGuest = (code: string) =>
  app.eval(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
const guestTitle = () => app.eval<string>(`${guest}.getTitle()`);
const modal = `document.querySelector('[data-testid="site-settings-modal"]')`;
const click = (selector: string) =>
  app.eval(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
const setSelect = (kind: string, value: string) =>
  app.eval(`(() => {
    const select = document.querySelector('[data-testid="site-permission-${kind}"] select');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

describe("site settings", () => {
  it("a page's permission request opens the modal with the question first", async () => {
    await app.waitFor(`${guest}?.getTitle?.() === 'Lab'`);
    await inGuest("askNotifications(); true");
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-permission-prompt"]')`,
      { label: "permission prompt" },
    );
    const text = await app.eval<string>(`${modal}.textContent`);
    expect(text).toContain(
      `${new URL(origin).host} wants to send you notifications`,
    );
    // The rest is folded under the question.
    expect(
      await app.eval(
        `document.querySelector('[data-testid="site-settings-permissions"]').dataset.open`,
      ),
    ).toBe("false");
    expect(await guestTitle()).toBe("asking");
  });

  it("Allow answers the page and is remembered for the site", async () => {
    await click('[data-testid="site-permission-allow"]');
    await app.waitFor(`${guest}.getTitle() === 'perm:granted'`, {
      label: "page granted",
    });
    await app.waitFor(`!${modal}`, { label: "modal closed" });
    // A second ask resolves from the stored choice, without a prompt.
    await inGuest("askNotifications(); true");
    await app.waitFor(`${guest}.getTitle() === 'perm:granted'`, {
      label: "granted again",
    });
    expect(await app.eval(`!!${modal}`)).toBe(false);
  });

  it("the toolbar gear opens the same modal laid out in full", async () => {
    await click('[data-testid="site-settings-button"]');
    await app.waitFor(`!!${modal}`, { label: "modal from gear" });
    expect(
      await app.eval(
        `document.querySelector('[data-testid="site-settings-permissions"]').dataset.open`,
      ),
    ).toBe("true");
    await app.waitFor(
      `document.querySelector('[data-testid="site-permission-notifications"] select')?.value === 'allow'`,
      { label: "notifications shows Allow" },
    );
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="site-permission-prompt"]')`,
      ),
    ).toBe(false);
  });

  it("Block from the modal denies the next request silently", async () => {
    await setSelect("notifications", "block");
    await app.waitFor(
      `document.querySelector('[data-testid="site-permission-notifications"] select')?.value === 'block'`,
      { label: "notifications blocked" },
    );
    await app.press("Escape");
    await app.waitFor(`!${modal}`, { label: "modal closed" });
    await inGuest("askNotifications(); true");
    await app.waitFor(`${guest}.getTitle() === 'perm:denied'`, {
      label: "page denied",
    });
    expect(await app.eval(`!!${modal}`)).toBe(false);
  });

  it("Delete data clears the site's cookies", async () => {
    await click('[data-testid="site-settings-button"]');
    await app.waitFor(
      `document.querySelector('[data-testid="site-settings-data"]')?.textContent.includes('1 cookie')`,
      { label: "one cookie counted" },
    );
    await click('[data-testid="site-settings-delete-data"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-settings-delete-confirm-button"]')`,
      { label: "delete confirm" },
    );
    await click('[data-testid="site-settings-delete-confirm-button"]');
    await app.waitFor(
      `document.querySelector('[data-testid="site-settings-data"]')?.textContent.includes('No cookies')`,
      { label: "cookies gone" },
    );
    expect(await inGuest("document.cookie")).toBe("");
    await app.press("Escape");
    await app.waitFor(`!${modal}`, { label: "modal closed" });
  });

  it("the Sites page lists the site and opens its settings", async () => {
    // The palette shortcut is Cmd+P on macOS and Ctrl+P elsewhere.
    await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    })); true`);
    await app.waitFor(
      `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].some((el) => document.activeElement === el)`,
      { label: "palette open" },
    );
    await app.insertText("Sites");
    await app.waitFor(
      `document.activeElement.closest('[role="dialog"]')?.querySelector('[role="option"]')?.textContent.startsWith('Sites')`,
      { label: "Sites row first" },
    );
    await app.press("Enter");
    await app.waitFor(
      `!!document.querySelector('[data-testid="sites-page"]')`,
      {
        label: "sites page",
      },
    );
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-row-notifications-block"]')`,
      { label: "site row with blocked notifications" },
    );
    await click('[data-testid="site-row"] button');
    await app.waitFor(`!!${modal}`, { label: "modal from Sites row" });
    // Reset appears once the site's details have loaded.
    await app.waitFor(
      `!!document.querySelector('[data-testid="site-settings-reset"]')`,
      { label: "reset button" },
    );
    await click('[data-testid="site-settings-reset"]');
    await app.waitFor(
      `document.querySelector('[data-testid="site-permission-notifications"] select')?.value === 'ask'`,
      { label: "reset to defaults" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
