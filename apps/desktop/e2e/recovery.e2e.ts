import { afterAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Recovery flows: the app dies mid-agent-turn (crash, quit, dev restart)
 * and must not leave the conversation spinning forever. The server settles
 * orphaned in-progress turns as failed on the next read, so a relaunched
 * app shows a finished (interrupted) message instead of an eternal
 * activity indicator.
 */

let app: AppHandle | undefined;

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  // Includes non-article rows: interrupted turns render as centered notes.
  const timelineMessages = () =>
    $$('[role="log"] article, [role="log"] .italic, [data-testid="chat-error-card"]').map((el) =>
      el.textContent.trim(),
    );
  const activityLines = () =>
    $$('[role="log"] .animate-pulse').map((el) => el.textContent.trim());
  const spinnersOn = () => $$('svg.animate-spin').filter((el) => {
    let node = el, opacity = 1;
    while (node && node !== document.body) {
      opacity *= parseFloat(getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return opacity > 0.5;
  }).length;
`;

const run = <T>(body: string) =>
  (app as AppHandle).eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => (app as AppHandle).waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

// A visible window may collapse its dock when focus leaves during recovery.
// Reopen it through the sidebar before interacting with its composer.
async function openRecoveredChat(): Promise<void> {
  await run(`
    if (!visibleDock()) {
      const chat = $$('button').find((el) => /^Chat /.test(el.textContent.trim()));
      chat?.click();
    }
    return true;
  `);
  await runWait(`return !!visibleDock();`, { label: "recovered chat open" });
}

describe("interrupted turn recovery", () => {
  it("a turn killed mid-flight settles as interrupted on relaunch", async () => {
    app = await launchApp();
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-recovery');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    await runWait(`return !!byText('[role="tab"], button', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });

    // Start a slow turn and kill the app while the agent is mid-flight.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`);
    await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'work slowly and wait for interruption');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return window.catamorphicDesktop.getServerState().then(async ({ url }) => {
        if (!url) return false;
        const projects = await fetch(url + '/api/projects').then((response) => response.json());
        const project = projects.items.find((item) => item.name === 'e2e-recovery');
        if (!project) return false;
        const sessions = await fetch(
          url + '/api/projects/' + project.id + '/agent/sessions',
        ).then((response) => response.json());
        return sessions.items.some((session) => session.running);
      });`,
      { timeoutMs: 30_000, label: "persisted running turn before the kill" },
    );
    const { userDataDir } = app;
    await app.kill();

    // Relaunch on the same data dir and reopen the orphaned session.
    app = await launchApp({
      userDataDir,
      ...(process.env.CATAMORPHIC_RELIABILITY_SCREENSHOT
        ? { env: { CATAMORPHIC_E2E_WINDOW_MODE: "visible" } }
        : {}),
    });
    await runWait(
      `return window.catamorphicDesktop &&
              window.catamorphicDesktop.getServerState().then((s) => !!s.url);`,
      { timeoutMs: 60_000, label: "embedded server ready after relaunch" },
    );
    await runWait(
      `const chat = $$('button').find((el) => /^Chat /.test(el.textContent.trim()));
       if (!chat) return false; chat.click(); return true;`,
      { timeoutMs: 30_000, label: "orphaned session in the sidebar" },
    );

    // The dead turn reads as a finished, interrupted message — not an
    // eternal "Thinking..." spinner.
    await runWait(
      `return timelineMessages().some((m) => m.includes('interrupted before it finished'));`,
      {
        timeoutMs: 75_000,
        label: "interrupted message after the old execution lease expires",
      },
    );
    expect(await run<string[]>(`return activityLines();`)).toEqual([]);
    await runWait(`return spinnersOn() === 0;`, {
      timeoutMs: 3_000,
      label: "settled activity indicators",
    });

    // The relaunch killed the harness's in-memory session. Sending again
    // must NOT dead-end on "Session not found" — the host re-anchors with
    // the persisted transcript and the conversation just continues.
    await openRecoveredChat();
    await run(`
      const dock = $$('section[aria-label]')
        .find((el) => !el.inert && el.querySelector('[data-composer-input]'));
      const ta = dock.querySelector('[data-composer-input]');
      setReactValue(ta, 'hello after the relaunch');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return timelineMessages()
        .some((m) => m.includes('You said: hello after the relaunch'));`,
      { timeoutMs: 30_000, label: "resurrected session answers" },
    );
  }, 180_000);

  it("shows uncertain progress during a lost host connection and recovers without resending", async () => {
    await openRecoveredChat();
    await run(`
      const input = visibleDock().querySelector('[data-composer-input]');
      setReactValue(input, 'work slowly while connectivity is interrupted');
      input.closest('form').requestSubmit();
      return true;
    `);
    await runWait(`return activityLines().length > 0;`, {
      label: "active turn before disconnect",
    });
    await app?.blockRequests(["*/agent/sessions/*"]);
    try {
      await runWait(
        `return document.body.innerText.includes('Reconnecting to check your agent');`,
        { timeoutMs: 20_000, label: "connection feedback" },
      );
      expect(await run<string[]>(`return activityLines();`)).toEqual([]);
      if (process.env.CATAMORPHIC_RELIABILITY_SCREENSHOT)
        await app?.screenshot(process.env.CATAMORPHIC_RELIABILITY_SCREENSHOT);
    } finally {
      await app?.blockRequests([]);
    }
    await runWait(
      `return !document.body.innerText.includes('Reconnecting to check your agent') && document.body.innerText.includes('Done after a long think.');`,
      { timeoutMs: 20_000, label: "reconciled server result" },
    );
  });
});
