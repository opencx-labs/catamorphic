import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Hermes as an agent of the person's own (ADR 0241): the setup wizard finds
 * the person's install (or says how to install it), adds it, and its chats
 * run over ACP. A stand-in `hermes` on PATH runs the ACP adapter tests'
 * agent, so the real adapter, runner and chat run with no model behind
 * them; the scripted fake never answers for Hermes.
 */

let app: AppHandle;
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bin-"));
/** A home without the person's own Hermes in `~/.local/bin`. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
/** PATH without the person's own Hermes, so the wizard starts from missing. */
const pathWithoutHermes = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => dir && !fs.existsSync(path.join(dir, "hermes")))
  .join(path.delimiter);
const shots = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir();
/** Lets a screenshot catch the step, not its fade-in. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

/** Puts the stand-in `hermes` where the wizard looks: on PATH. */
function installHermes() {
  const agent = path.resolve(
    import.meta.dirname,
    "../../../packages/acp/src/__tests__/test-agent.mjs",
  );
  const sessions = path.join(bin, "sessions.json");
  fs.writeFileSync(
    path.join(bin, "hermes"),
    // It answers a load of a session it lost with nothing, as Hermes does.
    `#!/bin/sh\nTEST_AGENT_LOAD=hermes exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} ${JSON.stringify(sessions)}\n`,
  );
  fs.chmodSync(path.join(bin, "hermes"), 0o755);
}

beforeAll(async () => {
  app = await launchApp({
    env: { HOME: home, PATH: `${bin}${path.delimiter}${pathWithoutHermes}` },
  });
});

afterAll(async () => {
  await app?.stop();
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visible = (selector) => $$(selector).find((el) => !el.closest('[inert]'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
  const paletteInput = () => (
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => document.activeElement === el) ??
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => !el.closest('[inert]'))
  );
  const paletteRows = () => {
    const input = paletteInput();
    if (!input) return [];
    return [...input.closest('[role="dialog"]').querySelectorAll('[role="option"]')];
  };
  const pick = (text) => {
    const opt = paletteRows().find((el) => el.textContent.includes(text));
    if (!opt) return false;
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  };
  const hermesDock = () => $$('section[aria-label]').find((el) => !el.inert &&
    el.querySelector('[data-composer-input]') && el.textContent.includes('Hermes'));
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);
const runWaitAsync = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(async () => { ${helpers}\n${body} })()`, opts);

const palette = async (command: string) => {
  await run(
    `if (!paletteInput()) pressKey('p', { metaKey: true }); return true;`,
  );
  await runWait(`return !!paletteInput();`, { label: "palette open" });
  await run(
    `setReactValue(paletteInput(), ${JSON.stringify(command)}); return true;`,
  );
};

describe("Hermes as the person's own agent", () => {
  it("boots into a project workspace", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-hermes');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    await runWait(`return !!$('textarea[placeholder*="Search or ask"]');`, {
      timeoutMs: 60_000,
      label: "workspace",
    });
  });

  it("says how to install Hermes when it is missing, finds it once installed, and adds it", async () => {
    await palette(">set up");
    await runWait(`return pick('Set up a new agent');`, {
      label: "setup-agent command",
    });
    await runWait(`return !!visible('[data-testid="agent-wizard-hermes"]');`, {
      label: "wizard lists Hermes",
    });
    await run(
      `visible('[data-testid="agent-wizard-hermes"]').click(); return true;`,
    );
    await runWait(
      `return !!byText('h2', 'Install Hermes') &&
              !!byText('code', 'hermes-agent.nousresearch.com/install.sh') &&
              !!byText('code', 'hermes setup');`,
      { label: "install step with Hermes' own commands" },
    );
    await settle();
    await app.screenshot(path.join(shots, "hermes-wizard-install.png"));

    installHermes();
    await run(
      `visible('[data-testid="agent-wizard-hermes-recheck"]').click(); return true;`,
    );
    await runWait(
      `const found = visible('[data-testid="agent-wizard-hermes-path"]');
       return !!found && found.textContent.includes(${JSON.stringify(bin)});`,
      { label: "the installed Hermes found on PATH" },
    );
    await settle();
    await app.screenshot(path.join(shots, "hermes-wizard-found.png"));
    await run(
      `visible('[data-testid="agent-wizard-hermes-use"]').click(); return true;`,
    );
    await runWait(`return !visible('[data-testid="agent-wizard"]');`, {
      timeoutMs: 15_000,
      label: "wizard done",
    });
    await runWaitAsync(
      `const { agents } = await window.catamorphicDesktop.agentsList();
       return agents.some((agent) => agent.harness === 'acp' && agent.name === 'Hermes' &&
         agent.acp?.command.join(' ') === 'hermes acp');`,
      { label: "Hermes in the roster, an ACP agent running `hermes acp`" },
    );
  });

  it("chats with Hermes over ACP", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(
      `return !!$$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));`,
      { label: "chat open" },
    );
    await palette("Switch agent for this chat");
    await runWait(`return pick('Switch agent for this chat');`, {
      label: "switch-agent command",
    });
    await runWait(`return pick('Hermes');`, { label: "pick Hermes" });
    await runWait(`return !!hermesDock();`, {
      timeoutMs: 15_000,
      label: "a chat on Hermes",
    });
    await run(`
      const ta = hermesDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'hello hermes');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return [...hermesDock().querySelectorAll('[role="log"] article')]
        .some((el) => el.textContent.includes('Echo: hello hermes'));`,
      { timeoutMs: 30_000, label: "Hermes' reply" },
    );
    await runWait(
      `return !!hermesDock().querySelector('[data-harness-icon="hermes"]');`,
      { label: "the chat marked as Hermes'" },
    );
    await settle();
    await app.screenshot(path.join(shots, "hermes-chat.png"));
  });

  it("goes on in a new session, handed the conversation, when Hermes lost its own (ADR 0245)", async () => {
    // Hermes' own sessions are gone (deleted, pruned): it can't reopen the
    // chat's. Work runs the turn on a new one and hands it what was said.
    fs.rmSync(path.join(bin, "sessions.json"), { force: true });
    await run(`
      const ta = hermesDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'what did I say');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return hermesDock().textContent.includes("couldn't reopen its earlier session");`,
      { timeoutMs: 30_000, label: "the notice saying why it starts over" },
    );
    await runWait(
      `return [...hermesDock().querySelectorAll('[role="log"] article')]
        .some((el) => el.textContent.includes('Echo:') &&
          el.textContent.includes('hello hermes') &&
          el.textContent.includes('what did I say'));`,
      {
        timeoutMs: 30_000,
        label: "Hermes' reply, the conversation handed over",
      },
    );
    await settle();
    await app.screenshot(path.join(shots, "hermes-thread-lost.png"));
  });

  it("its settings say where its model and sign-in live", async () => {
    await run(`byText('button', 'Settings').click(); return true;`);
    await runWait(`return !!$('[aria-label="Edit Hermes"]');`, {
      timeoutMs: 30_000,
      label: "Hermes in Settings",
    });
    // The agents list names what it runs and where its model lives.
    await runWait(
      `return !!byText('div', 'hermes acp') && !!byText('span', 'its own model and sign-in');`,
      { label: "Hermes' row: its command and its own model and sign-in" },
    );
    await settle();
    await app.screenshot(path.join(shots, "hermes-settings-list.png"));
    await run(`$('[aria-label="Edit Hermes"]').click(); return true;`);
    await runWait(
      `return !!byText('[data-testid="agent-acp-model"] code', 'hermes model') &&
              !$('[data-testid="agent-effort"]') &&
              !$('[data-testid="agent-sync-sessions"]');`,
      { timeoutMs: 15_000, label: "Hermes' model note, no effort or sync" },
    );
    await settle();
    await app.screenshot(path.join(shots, "hermes-settings.png"));
    await run(`$('[data-testid="agent-tab-auth"]').click(); return true;`);
    await runWait(
      `return !!byText('[data-testid="agent-acp-auth"] code', 'hermes setup');`,
      {
        label: "Hermes signs in on its own",
      },
    );
  });
});
