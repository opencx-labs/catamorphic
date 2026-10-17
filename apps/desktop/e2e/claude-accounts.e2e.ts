import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Claude accounts take turns (ADR 0243). The fake agent answers as a local
 * Claude Code agent; the roster's Claude Code is the e2e one, so a sign-in
 * takes the next email this test lists and `/usage` answers what it writes.
 * The machine's own login is the e2e credentials seam. Nothing here signs
 * in to a real account.
 *
 * - Settings, Agents, Claude accounts lists this Mac's login with its usage;
 *   signing in from the card and from the palette adds accounts.
 * - A chat moves to the next account when the one in use reaches 85%, and
 *   when a turn on it is rate limited, and says so.
 * - An agent asked for another account signs it in with claude_accounts.
 * - Signing out removes an account.
 */

let app: AppHandle;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-e2e-"));
const credentials = path.join(scratch, `sign-in-${randomUUID()}.json`);
const roster = path.join(scratch, "accounts.json");
const usage: Record<string, { fiveHour?: number; weekly?: number }> = {
  "me@example.com": { fiveHour: 40, weekly: 20 },
  "work@example.com": { fiveHour: 12, weekly: 30 },
  "side@example.com": { fiveHour: 5, weekly: 8 },
  "third@example.com": { fiveHour: 0, weekly: 0 },
};
const writeRoster = () =>
  fs.writeFileSync(
    roster,
    JSON.stringify({
      machine: "me@example.com",
      signIns: ["work@example.com", "side@example.com", "third@example.com"],
      usage,
    }),
  );

beforeAll(async () => {
  fs.writeFileSync(
    credentials,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "e2e-access",
        refreshToken: "e2e-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
        refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
      },
    }),
  );
  writeRoster();
  app = await launchApp({
    env: {
      CATAMORPHIC_E2E_AGENT_CREDENTIALS: credentials,
      CATAMORPHIC_E2E_CLAUDE_ACCOUNTS: roster,
    },
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
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
  const replies = (text) => $$('[role="log"] article')
    .filter((el) => el.textContent.includes(text)).length;
  const card = () => $('[data-setting-id="claude-accounts"]');
  const row = (label) => card()?.querySelector('[data-claude-account="' + label + '"]');
  const inUse = () => card()?.querySelector('[data-testid="claude-account-in-use"]')
    ?.closest('[data-claude-account]')?.dataset.claudeAccount ?? null;
  const palette = () => [...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')]
    .find((el) => !el.closest('[inert]') && el.getBoundingClientRect().width > 0);
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

const openSettings = async () => {
  await run(
    `$('[data-workspace-visible="true"] [aria-label="Settings"]').click(); return true;`,
  );
  await runWait(`return !!card();`, { label: "Claude accounts card" });
};
const openChat = async () => {
  await run(`pressKey('n', { metaKey: true }); return true;`);
  await runWait(`return !!visibleDock();`, {
    timeoutMs: 30_000,
    label: "chat opens",
  });
};

/** Record whether the chat ever said it changed accounts. */
const watchActivity = () =>
  run(`
    window.__activity = [];
    window.__activityObserver?.disconnect();
    const look = () => {
      for (const el of $$('[data-testid="chat-activity"]')) {
        const text = el.textContent.trim();
        if (text.startsWith('Using ') && !window.__activity.includes(text))
          window.__activity.push(text);
      }
    };
    window.__activityObserver = new MutationObserver(look);
    window.__activityObserver.observe(document.body,
      { childList: true, subtree: true, characterData: true });
    look();
    return true;
  `);

describe("Claude accounts", () => {
  it("opens a project with a local Claude Code agent", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-claude-accounts');
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
  });

  it("lists this Mac's login with its usage, and signs another account in from Settings", async () => {
    await openSettings();
    await runWait(
      `const mine = row('me@example.com');
       return !!mine && mine.textContent.includes("This Mac's login") &&
         mine.textContent.includes('Claude Max') &&
         mine.textContent.includes('40%') && mine.textContent.includes('20%');`,
      { label: "the machine's login with its usage" },
    );
    // One account takes every turn: nothing to mark.
    expect(await run(`return inUse();`)).toBeNull();
    await app.screenshot(path.join(scratch, "claude-accounts-machine.png"));

    await run(
      `$('[data-testid="claude-accounts-sign-in"]').click(); return true;`,
    );
    await runWait(
      `return $('[data-testid="claude-accounts-sign-in"]').textContent
         .includes('Finish signing in in the browser tab');`,
      { label: "the sign-in waits for the person" },
    );
    await runWait(`return !!row('work@example.com');`, {
      timeoutMs: 15_000,
      label: "the signed-in account joins the roster",
    });
    expect(await run(`return inUse();`)).toBe("me@example.com");
    expect(await run(`return row('work@example.com').textContent;`)).toContain(
      "Signed in from Work",
    );
  });

  it("signs an account in from the palette and shows it in Settings", async () => {
    await runWait(`return !palette();`);
    await run(`pressKey('p', { metaKey: true }); return true;`);
    await runWait(`return document.activeElement === palette();`, {
      label: "palette open",
    });
    await run(
      `setReactValue(palette(), 'Sign in to a Claude account'); return true;`,
    );
    await runWait(
      `return [...palette().closest('[role="dialog"]').querySelectorAll('[role="option"]')][0]
         ?.textContent.includes('Sign in to a Claude account');`,
      { label: "the palette offers the sign-in" },
    );
    await run(
      `palette().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;`,
    );
    await runWait(
      `return !!row('side@example.com') &&
         card().dataset.settingsTarget === 'true';`,
      { timeoutMs: 15_000, label: "Settings shows the new account" },
    );
    expect(
      await run(
        `return [...card().querySelectorAll('[data-claude-account]')].map((el) => el.dataset.claudeAccount);`,
      ),
    ).toEqual(["me@example.com", "work@example.com", "side@example.com"]);
    // The card opens on signing in another (or on itself while that is
    // still busy), never on a row's sign-out.
    expect(
      await run(`
        const focused = document.activeElement;
        return {
          inCard: card().contains(focused),
          signOut: !!focused?.closest('[aria-label^="Sign out"]'),
        };
      `),
    ).toEqual({ inCard: true, signOut: false });
  });

  it("runs a chat on the account in use, and moves to the next at 85%", async () => {
    await openChat();
    await run(`send('which claude account'); return true;`);
    await runWait(`return replies("Claude account: this Mac's login") === 1;`, {
      timeoutMs: 30_000,
      label: "the first turn ran on this Mac's login",
    });

    // Usage climbs while it works: the turn runs on the reading Work had,
    // and the reading after it finds the account past 85%.
    usage["me@example.com"] = { fiveHour: 90, weekly: 20 };
    writeRoster();
    await run(`send('which claude account again'); return true;`);
    await runWait(`return replies("Claude account: this Mac's login") === 2;`, {
      timeoutMs: 30_000,
      label: "the turn ran on the reading Work had",
    });
    await openSettings();
    await runWait(`return row('me@example.com').textContent.includes('90%');`, {
      label: "Settings shows the reading after the turn",
    });
    await app.screenshot(path.join(scratch, "claude-accounts-past-85.png"));

    await openChat();
    await watchActivity();
    await run(`send('which claude account now'); return true;`);
    await runWait(`return replies('Claude account: work@example.com') === 1;`, {
      timeoutMs: 30_000,
      label: "the next turn ran on the next account",
    });
    expect(await run(`return window.__activity;`)).toContain(
      "Using work@example.com: me@example.com is at 90% of its 5-hour limit",
    );
    await openSettings();
    await runWait(`return inUse() === 'work@example.com';`, {
      label: "Settings marks the account in use",
    });
    expect(
      await run(
        `return $('[data-testid="claude-account-last-switch"]').textContent;`,
      ),
    ).toMatch(
      /Switched to work@example\.com at .+: me@example\.com is at 90% of its 5-hour limit\./,
    );
    await app.screenshot(path.join(scratch, "claude-accounts-switched.png"));
  });

  it("moves a rate-limited turn's retry to the next account", async () => {
    await openChat();
    await run(`send('please hit a rate limit'); return true;`);
    await runWait(`return replies('Recovered after the rate limit.') === 1;`, {
      timeoutMs: 45_000,
      label: "the automatic retry recovered",
    });
    await openSettings();
    await runWait(
      `return inUse() === 'side@example.com' &&
         row('work@example.com').textContent.includes('Rate limited, back in 5 min');`,
      { label: "the rate-limited account rests" },
    );
    expect(
      await run(
        `return $('[data-testid="claude-account-last-switch"]').textContent;`,
      ),
    ).toContain("work@example.com was rate limited.");
    await openChat();
    await run(`send('which claude account after the limit'); return true;`);
    await runWait(`return replies('Claude account: side@example.com') === 1;`, {
      timeoutMs: 30_000,
      label: "the next turn stays on the account it moved to",
    });
  });

  it("signs an account in when the person asks the agent for one", async () => {
    await run(`send('add a claude account for me'); return true;`);
    await runWait(
      `return replies('Signed in third@example.com. Claude accounts: me@example.com, work@example.com, side@example.com, third@example.com.') === 1;`,
      { timeoutMs: 30_000, label: "the agent signed the account in" },
    );
  });

  it("signs an account out", async () => {
    await openSettings();
    await runWait(`return !!row('third@example.com');`);
    await run(
      `row('third@example.com').querySelector('[aria-label="Sign out of third@example.com"]').click(); return true;`,
    );
    await runWait(`return !row('third@example.com');`, {
      label: "the account left the roster",
    });
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(app.userDataDir, "claude-accounts.json"),
        "utf8",
      ),
    ) as { accounts: Array<{ id: string; email: string }> };
    expect(saved.accounts.map((account) => account.email)).toEqual([
      "work@example.com",
      "side@example.com",
    ]);
    // Who signed in, never a credential; each account a home of its own.
    expect(JSON.stringify(saved)).not.toMatch(/token|secret|refresh/i);
    expect(
      fs.readdirSync(path.join(app.userDataDir, "agent-homes")).sort(),
    ).toEqual(saved.accounts.map((account) => account.id).sort());
  });
});
