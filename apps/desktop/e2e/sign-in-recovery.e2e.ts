import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * A Claude Code sign-in that is not really lost (ADR 0227). The fake agent
 * answers as a local Claude Code agent and is turned away the way a CLI
 * that lost its token refresh is; the agent's sign-in is a file this test
 * writes (the e2e credentials seam), never a real login.
 *
 * - While the sign-in can still refresh, the turn retries once, quietly:
 *   "Reconnecting to Claude…", and no error card.
 * - When that retry fails too, the card shows; the sign-in renewed outside
 *   Work (another process refreshing it) runs the turn again unasked.
 * - A sign-in whose refresh token expired fails at once.
 */

let app: AppHandle;
const credentials = path.join(
  os.tmpdir(),
  `catamorphic-e2e-sign-in-${randomUUID()}.json`,
);
const DAY = 86_400_000;

/** The agent's sign-in as the CLI keeps it; fake values only. */
function writeSignIn(input: {
  accessExpiresAt: number;
  refreshExpiresAt: number;
}) {
  fs.writeFileSync(
    credentials,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "e2e-access",
        refreshToken: "e2e-refresh",
        expiresAt: input.accessExpiresAt,
        refreshTokenExpiresAt: input.refreshExpiresAt,
      },
    }),
  );
}

beforeAll(async () => {
  // The access token expired minutes ago; the refresh token has days left.
  writeSignIn({
    accessExpiresAt: Date.now() - 6 * 60_000,
    refreshExpiresAt: Date.now() + 4 * DAY,
  });
  app = await launchApp({
    env: { CATAMORPHIC_E2E_AGENT_CREDENTIALS: credentials },
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  fs.rmSync(credentials, { force: true });
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () => {
    const docks = $$('section[data-chat-local-id]').filter((el) =>
      !el.closest('[inert]') && el.getBoundingClientRect().width > 0 &&
      el.querySelector('[data-composer-input]'));
    return docks.find((el) => el.dataset.floatingChat === 'true') ??
      docks.find((el) => el.contains(document.activeElement)) ?? docks[0];
  };
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
  const send = (text) => {
    const ta = visibleDock().querySelector('[data-composer-input]');
    setReactValue(ta, text);
    ta.closest('form').requestSubmit();
  };
  const replied = (text) => $$('[role="log"] article')
    .some((el) => el.textContent.includes(text));
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

/**
 * Record, as it renders, whether the chat ever showed an error card or
 * said it was reconnecting: both can come and go between two polls.
 */
const watchChat = () =>
  run(`
    window.__seen = { card: false, reconnecting: false };
    window.__seenObserver?.disconnect();
    const look = () => {
      if ($('[data-testid="chat-error-card"]')) window.__seen.card = true;
      if ($$('[data-testid="chat-activity"]').some((el) =>
        el.textContent.includes('Reconnecting to Claude')))
        window.__seen.reconnecting = true;
    };
    window.__seenObserver = new MutationObserver(look);
    window.__seenObserver.observe(document.body,
      { childList: true, subtree: true, characterData: true });
    look();
    return true;
  `);
const seen = () =>
  run<{ card: boolean; reconnecting: boolean }>(`return window.__seen;`);

describe("a sign-in that can still refresh", () => {
  it("opens a chat on a local Claude Code agent", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-sign-in');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    await runWait(
      `return !!byText('[role="tab"], button', 'New Tab') &&
              !!$('textarea[placeholder*="Search or ask"]');`,
      { timeoutMs: 60_000, label: "workspace after project creation" },
    );
    await app.eval(`(async () => {
      const created = await window.catamorphicDesktop.agentsCreate({
        name: 'My Claude', harness: 'claude-code', auth: 'local', effort: 'medium' });
      await window.catamorphicDesktop.agentsSetDefault(created.id);
      return created.id;
    })()`);
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, {
      timeoutMs: 30_000,
      label: "chat opens",
    });
  });

  it("retries a turned-away turn once, quietly, while the sign-in can refresh", async () => {
    await watchChat();
    await run(`send('answer after an expired sign-in'); return true;`);
    await runWait(`return replied('Signed in again.');`, {
      timeoutMs: 30_000,
      label: "the quiet retry answered",
    });
    expect(await seen()).toEqual({ card: false, reconnecting: true });
  });

  it("shows the card when the retry fails too, and runs the turn again once the sign-in is renewed elsewhere", async () => {
    await watchChat();
    await run(`send('answer after an expired sign-in x2'); return true;`);
    await runWait(
      `return !!$('[data-testid="chat-error-card"]') &&
        $('[data-testid="chat-error-card"]').textContent.includes('rejected the credentials');`,
      { timeoutMs: 30_000, label: "the auth card after the one retry" },
    );
    expect((await seen()).reconnecting).toBe(true);
    // Another Claude Code refreshes the shared login (or the person runs
    // /login in a terminal): nobody clicks anything in Work.
    writeSignIn({
      accessExpiresAt: Date.now() + 8 * 60 * 60_000,
      refreshExpiresAt: Date.now() + 30 * DAY,
    });
    await runWait(
      `return replied('Signed in again.') &&
        $$('[role="log"] article').filter((el) =>
          el.textContent.includes('Signed in again.')).length >= 2 &&
        !$('[data-testid="chat-error-card"]');`,
      { timeoutMs: 30_000, label: "the renewed sign-in ran the turn again" },
    );
  });

  it("fails at once when the refresh token expired", async () => {
    writeSignIn({
      accessExpiresAt: Date.now() - 60_000,
      refreshExpiresAt: Date.now() - 1_000,
    });
    await watchChat();
    await run(`send('one more expired sign-in please'); return true;`);
    await runWait(`return !!$('[data-testid="chat-error-card"]');`, {
      timeoutMs: 30_000,
      label: "the auth card at once",
    });
    expect((await seen()).reconnecting).toBe(false);
  });
});
