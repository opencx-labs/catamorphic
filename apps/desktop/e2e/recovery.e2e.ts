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
    $$('[role="log"] article, [role="log"] .italic').map((el) =>
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
    await runWait(`return spinnersOn() > 0;`, {
      label: "turn in flight before the kill",
    });
    const { userDataDir } = app;
    await app.kill();

    // Relaunch on the same data dir and reopen the orphaned session.
    app = await launchApp({ userDataDir });
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
      { timeoutMs: 30_000, label: "interrupted message in the timeline" },
    );
    expect(await run<string[]>(`return activityLines();`)).toEqual([]);
    expect(await run<number>(`return spinnersOn();`)).toBe(0);

    // The relaunch killed the harness's in-memory session. Sending again
    // must NOT dead-end on "Session not found" — the host re-anchors with
    // the persisted transcript and the conversation just continues.
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
  });
});
