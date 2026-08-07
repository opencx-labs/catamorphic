import { afterAll, beforeAll, describe, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Agent commands and profile switching, on their own app instance: these
 * flows mutate global state (the default agent, the profile roster), so
 * they start from a pristine userData dir instead of inheriting app.e2e's
 * accumulated workspace. In e2e mode the default profile is seeded with
 * two fake-backed agents ("Fake Agent" the default, "Other Fake").
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
});

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('textarea'));
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  const paletteInput = () => (
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => document.activeElement === el) ??
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => !el.closest('[inert]'))
  );
  const wizardVisible = () => {
    const wizard = $$('[data-testid="agent-wizard"]')
      .find((el) => !el.closest('[inert]'));
    return !!wizard;
  };
  const paletteRows = () => {
    const input = paletteInput();
    if (!input) return [];
    return [...input.closest('[role="dialog"]').querySelectorAll('[role="option"]')];
  };
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

const ensurePalette = async () => {
  await run(
    `if (!paletteInput()) pressKey('p', { metaKey: true }); return true;`,
  );
  await runWait(`return !!paletteInput();`, { label: "palette open" });
};

// Backspace on an empty input pops any stale chip (mode or picker).
const resetPalette = async () => {
  await run(`
    setReactValue(paletteInput(), '');
    paletteInput().dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Backspace', bubbles: true, cancelable: true }));
    return true;
  `);
};

// Options commit on mousedown (so the input's focus never flickers).
const pickOption = (text: string) => `
  const opt = paletteRows().find((el) => el.textContent.includes('${text}'));
  if (!opt) return false;
  opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return true;
`;

const openPicker = async (command: string, chip: string) => {
  await ensurePalette();
  await resetPalette();
  await run(`setReactValue(paletteInput(), '${command}'); return true;`);
  await runWait(pickOption(command), { label: `${command} row` });
  await runWait(
    `const c = $('[data-testid="palette-mode-chip"]');
     return !!c && c.textContent.includes('${chip}');`,
    { label: `${chip} chip active` },
  );
};

// Escape is handled by the overlay's capture-phase window listener.
const paletteEscape = `
  window.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  return true;
`;

describe("agents and profiles", () => {
  it("boots into a project workspace", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-agents');
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
      { timeoutMs: 60_000, label: "palette New Tab after project creation" },
    );
  });

  it("changes the default agent through the palette picker", async () => {
    await openPicker("Change default agent", "Default agent");
    await runWait(
      `const rows = paletteRows();
       return rows.some((el) => el.textContent.includes('Fake Agent') &&
                                el.textContent.includes('· default')) &&
              rows.some((el) => el.textContent.includes('Other Fake'));`,
      { label: "agent rows with default marker" },
    );
    await run(pickOption("Other Fake"));
    await openPicker("Change default agent", "Default agent");
    await runWait(
      `return paletteRows()
        .some((el) => el.textContent.includes('Other Fake') &&
                      el.textContent.includes('· default'));`,
      { label: "default moved to Other Fake" },
    );
    await run(paletteEscape);
  });

  it("offers switch-agent only while a chat is focused", async () => {
    // No chat focused yet: the session-scoped command is absent.
    await ensurePalette();
    await resetPalette();
    await run(`setReactValue(paletteInput(), '>switch agent'); return true;`);
    await runWait(
      `return paletteInput()?.value === '>switch agent' &&
              !paletteRows()
                .some((el) => el.textContent.includes('Switch agent for this chat'));`,
      { label: "no switch-agent row without a chat" },
    );
    await run(paletteEscape);

    // Focus a chat; the command appears.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "chat focused" });
    await ensurePalette();
    await resetPalette();
    await run(`setReactValue(paletteInput(), '>switch agent'); return true;`);
    await runWait(
      `return paletteRows()
        .some((el) => el.textContent.includes('Switch agent for this chat'));`,
      { label: "switch-agent row while chat focused" },
    );
    // Enter the picker and move the chat to the other agent.
    await runWait(pickOption("Switch agent for this chat"), {
      label: "switch-agent picker",
    });
    await runWait(
      `const c = $('[data-testid="palette-mode-chip"]');
       return !!c && c.textContent.includes('Chat agent');`,
      { label: "chat-agent chip" },
    );
    await run(pickOption("Fake Agent"));
    // Dismiss the chat; the command disappears with it.
    await run(`pressKey('Escape'); return true;`);
    await runWait(`return !visibleDock();`, { label: "chat dismissed" });
    await ensurePalette();
    await resetPalette();
    await run(`setReactValue(paletteInput(), '>switch agent'); return true;`);
    // The dismissal is an animated close — the chat leaves the workspace
    // when its exit tween ends, so the row disappears shortly after.
    await runWait(
      `return paletteInput()?.value === '>switch agent' &&
              !paletteRows()
                .some((el) => el.textContent.includes('Switch agent for this chat'));`,
      { label: "switch-agent row gone after dismissal" },
    );
    await run(paletteEscape);
  });

  it("changes the default agent's effort through the effort picker", async () => {
    await openPicker("Change model effort", "Effort");
    await runWait(
      `const rows = paletteRows();
       return rows.some((el) => el.textContent.includes('Medium effort') &&
                                el.textContent.includes('· current')) &&
              rows.some((el) => el.textContent.includes('High effort'));`,
      { label: "effort rows with current marker" },
    );
    await run(pickOption("High effort"));
    await openPicker("Change model effort", "Effort");
    await runWait(
      `return paletteRows()
        .some((el) => el.textContent.includes('High effort') &&
                      el.textContent.includes('· current'));`,
      { label: "current effort moved to high" },
    );
    await run(paletteEscape);
  });

  it("changes the current agent's model through the model picker", async () => {
    // No chat focused → the target is the profile's default agent
    // (ai-sdk/anthropic here, so the typed-id row is the path).
    await openPicker("Change model", "Model");
    // Supported values arrive from the harness (stubbed in e2e) — listed,
    // not hardcoded.
    await runWait(
      `return paletteRows().some((el) => el.textContent.includes('Fake Model A')) &&
              paletteRows().some((el) => el.textContent.includes('Fake Model B'));`,
      { label: "harness-supplied model rows" },
    );
    // Aliased ids surface their resolved, versioned id in the faded detail.
    await runWait(
      `return paletteRows().some((el) => el.textContent.includes('fake-model-a-2.1'));`,
      { label: "resolved id in the model row detail" },
    );
    await run(`setReactValue(paletteInput(), 'my-custom-model'); return true;`);
    await runWait(pickOption('Use "my-custom-model"'), {
      label: "typed model row",
    });
    await runWait(
      `return window.catamorphicDesktop.agentsList().then((data) =>
        data.agents.find((agent) => agent.id === data.defaultAgentId)
          ?.model === 'my-custom-model');`,
      { label: "default agent's model updated" },
    );
    // Re-entering the picker shows the pick as current.
    await openPicker("Change model", "Model");
    await runWait(
      `return paletteRows().some((el) =>
        el.textContent.includes('my-custom-model') &&
        el.textContent.includes('current'));`,
      { label: "current marker on the new model" },
    );
    await run(paletteEscape);
  });

  it("commits the Ask agent chip from the chat alias", async () => {
    await ensurePalette();
    await resetPalette();
    await run(`setReactValue(paletteInput(), 'chat'); return true;`);
    await run(`
      paletteInput().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Tab', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `const chip = $('[data-testid="palette-mode-chip"]');
       return !!chip && chip.textContent.includes('Ask agent') &&
              paletteInput().value === '';`,
      { label: "agent chip committed from 'chat'" },
    );
    await resetPalette();
    await runWait(`return !$('[data-testid="palette-mode-chip"]');`, {
      label: "chip popped",
    });
    await run(paletteEscape);
  });

  it("shows the agent's account in the picker row detail", async () => {
    // The seeded fake agents are built-in/Anthropic on an API key: the
    // detail names the provider and the auth, not the harness.
    // as faded detail beside the harness label.
    await openPicker("Change default agent", "Default agent");
    await runWait(
      `return paletteRows().some((el) =>
        el.textContent.includes('Anthropic') &&
        el.textContent.includes('API key'));`,
      { label: "provider and auth detail on agent rows" },
    );
    await run(paletteEscape);
  });

  it("switches profile in place under the veil when only New Tabs are open", async () => {
    // The workspace holds only the seeded palette New Tab — that counts
    // as empty, so switching runs in place. The 200ms veil fades can slip
    // between 200ms polls; observe the DOM from inside the page instead.
    await run(`
      window.__veilSeen = false;
      const check = () => {
        if (document.querySelector('[class*="animate-profile-veil"]')) {
          window.__veilSeen = true;
        }
      };
      new MutationObserver(check).observe(document.body,
        { childList: true, subtree: true });
      check();
      return true;
    `);

    await run(
      `byText('button[aria-haspopup="menu"]', 'Default Profile').click(); return true;`,
    );
    await runWait(`return !!byText('button', 'New profile');`, {
      label: "profile menu open",
    });
    await run(`byText('button', 'New profile').click(); return true;`);
    await runWait(`return !!$('input[placeholder="Profile name"]');`, {
      label: "profile name input",
    });
    await run(`
      const input = $('input[placeholder="Profile name"]');
      setReactValue(input, 'Work');
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return window.__veilSeen === true &&
              !$('[class*="animate-profile-veil"]') &&
              !!byText('button[aria-haspopup="menu"]', 'Work');`,
      { timeoutMs: 15_000, label: "veil played and settled on Work" },
    );

    // Switch back the same way (the fresh profile has no projects, which
    // must still count as an empty workspace).
    await run(
      `byText('button[aria-haspopup="menu"]', 'Work').click(); return true;`,
    );
    await runWait(`return !!byText('button', 'Default Profile');`, {
      label: "profile menu lists Default Profile",
    });
    await run(`byText('button', 'Default Profile').click(); return true;`);
    await runWait(
      `return !$('[class*="animate-profile-veil"]') &&
              !!byText('button[aria-haspopup="menu"]', 'Default Profile') &&
              !!byText('[role="tab"], button', 'New Tab');`,
      { timeoutMs: 15_000, label: "back on the default profile workspace" },
    );
  });

  it("highlights the surface a scoped command targets", async () => {
    // Force the OVERLAY palette: a palette tab keeps its selection (and
    // thus its highlight) after Escape, so the clear-on-close behavior
    // belongs to the overlay only.
    const overlayInput = `(
      $$('textarea[aria-label="Search commands, pages, and more"]')
        .find((el) => el.closest('.fixed') && !el.closest('[inert]'))
    )`;
    const ensureOverlay = async () => {
      await run(
        `if (!(${overlayInput})) pressKey('p', { metaKey: true }); return true;`,
      );
      await runWait(`return !!(${overlayInput});`, { label: "overlay open" });
    };

    // "Close tab" with no floating chat targets the active tab: the tab
    // gets the accent border while the row is highlighted.
    await ensureOverlay();
    await run(`setReactValue(${overlayInput}, '>close tab'); return true;`);
    try {
      await runWait(
        `const target = $('[data-palette-target]');
         return !!target && target.textContent.includes('New Tab');`,
        { label: "active tab highlighted for close-tab" },
      );
    } catch (error) {
      const debug = await run<unknown>(`
        return {
          targets: $$('[data-palette-target]').map((el) => el.textContent.trim().slice(0, 40)),
          overlay: !!(${overlayInput}),
          value: (${overlayInput})?.value,
          rows: (${overlayInput})
            ? [...(${overlayInput}).closest('[role="dialog"]').querySelectorAll('[role="option"]')]
                .map((el) => el.textContent.trim().slice(0, 40))
            : null,
          tabs: $$('[role="tab"]').map((el) => el.textContent.trim()),
        };
      `);
      console.log("highlight-debug:", JSON.stringify(debug));
      throw error;
    }
    await run(paletteEscape);
    await runWait(`return !$('[data-palette-target]');`, {
      label: "highlight cleared when the palette closes",
    });

    // With a floating chat focused, session-scoped commands target it:
    // the dock's border goes accent while the row is highlighted.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "chat focused" });
    await ensureOverlay();
    await run(`setReactValue(${overlayInput}, '>switch agent'); return true;`);
    await runWait(
      `const dock = visibleDock();
       return !!dock && dock.hasAttribute('data-palette-target');`,
      { label: "floating dock highlighted for switch-agent" },
    );
    // The highlight survives into the picker (still the same target).
    await runWait(
      `const dlg = (${overlayInput}).closest('[role="dialog"]');
       const opt = [...dlg.querySelectorAll('[role="option"]')]
         .find((el) => el.textContent.includes('Switch agent for this chat'));
       if (!opt) return false;
       opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
       return true;`,
      { label: "enter switch-agent picker" },
    );
    await runWait(
      `const dock = visibleDock();
       return !!dock && dock.hasAttribute('data-palette-target');`,
      { label: "dock stays highlighted inside the picker" },
    );
    await run(paletteEscape);
    await runWait(`return !$('[data-palette-target]');`, {
      label: "highlight cleared after closing",
    });
    await run(`pressKey('Escape'); return true;`);
    await runWait(`return !visibleDock();`, { label: "chat dismissed" });
  });

  it("opens the agent wizard from the palette command", async () => {
    await ensurePalette();
    await resetPalette();
    await run(`setReactValue(paletteInput(), '>set up'); return true;`);
    await runWait(pickOption("Set up a new agent"), {
      label: "setup-agent command",
    });
    await runWait(`return wizardVisible();`, {
      label: "wizard modal open",
    });
    await run(paletteEscape);
    await runWait(`return !wizardVisible();`, {
      label: "wizard modal closed",
    });
  });

  it("onboards an agent-less profile through the wizard", async () => {
    // Wait out any closing chat dock from earlier tests.
    await runWait(
      `return $$('section[aria-label]')
        .filter((el) => el.querySelector('textarea')).length === 0;`,
      { label: "no chat docks mounted" },
    );

    // Empty the roster: the setup wizard auto-opens as a closable tab.
    await run(`
      return window.catamorphicDesktop.agentsList().then((data) =>
        Promise.all(data.agents.map((agent) =>
          window.catamorphicDesktop.agentsRemove(agent.id))));
    `);
    await runWait(
      `const visibleFree = $$('[data-testid="agent-wizard-free"]')
         .filter((el) => !el.closest('[inert]'));
       return wizardVisible() &&
              !!byText('[role="tab"], button', 'Set up agent') &&
              visibleFree.length === 1;`,
      {
        timeoutMs: 15_000,
        label: "setup tab auto-opened, free option present",
      },
    );

    // Closing the tab skips setup entirely…
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return !wizardVisible();`, {
      label: "setup tab closed (skipped)",
    });

    // …but starting a chat brings the same wizard back as a modal, and no
    // chat opens.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return wizardVisible();`, {
      label: "wizard modal gates the chat",
    });
    const dockCount = await run<number>(
      `return $$('section[aria-label]')
        .filter((el) => !el.inert && el.querySelector('textarea')).length;`,
    );
    if (dockCount !== 0) throw new Error("chat opened despite no agents");

    // The free path creates an OpenRouter agent (the e2e login shortcut
    // stamps its credential) and the wizard dismisses itself.
    await run(`
      $$('[data-testid="agent-wizard-free"]')
        .find((el) => !el.closest('[inert]'))
        .click();
      return true;
    `);
    await runWait(`return !wizardVisible();`, {
      timeoutMs: 15_000,
      label: "wizard done and closed",
    });
    await runWait(
      `return window.catamorphicDesktop.agentsList().then((data) =>
        data.agents.length === 1 &&
        data.agents[0].name === 'Free models' &&
        data.agents[0].provider === 'openrouter' &&
        data.agents[0].hasApiKey);`,
      { label: "OpenRouter agent created with a stamped credential" },
    );

    // Chats flow again on the onboarded agent.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "chat opens" });
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'hello free agent');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: hello free agent'));`,
      { timeoutMs: 30_000, label: "reply from the onboarded agent" },
    );
  });

  it("rewrites provider credential rejections into an actionable error", async () => {
    // A dead key must not surface as the provider's bare 401 body
    // ("User not found." — OpenRouter's) with no way forward. The fake
    // fails the turn with that exact text; the chat must show the rewrite
    // naming the agent and pointing at Settings, original preserved.
    await runWait(`return !!visibleDock();`, { label: "chat still open" });
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'please fail with an auth error');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article').some((el) =>
        el.textContent.includes(
          'OpenRouter rejected the credentials of the "Free models" agent') &&
        el.textContent.includes('User not found.') &&
        el.textContent.includes('Settings'));`,
      { timeoutMs: 30_000, label: "friendly auth error in the chat" },
    );
    // The raw body alone must never be the whole message.
    const bare = await run<boolean>(`
      return $$('[role="log"] article')
        .some((el) => el.textContent.trim() === 'User not found.');
    `);
    if (bare) throw new Error("raw provider 401 body leaked into the chat");

    // The card offers Retry: the turn re-runs IN PLACE (no new user
    // message) and the recovered reply replaces the failure.
    await runWait(
      `const btn = $('[data-testid="chat-retry"]');
       if (!btn) return false; btn.click(); return true;`,
      { label: "retry button on the error card" },
    );
    await runWait(
      `return $$('[role="log"] article, [role="log"] div')
        .some((el) => el.textContent.includes('Recovered after reconnecting.'));`,
      { timeoutMs: 30_000, label: "retried turn recovered" },
    );
    const userEchoes = await run<number>(`
      return $$('[role="log"] *').filter((el) =>
        el.childElementCount === 0 &&
        el.textContent.trim() === 'please fail with an auth error').length;
    `);
    if (userEchoes > 1) {
      throw new Error("retry duplicated the user message in the timeline");
    }
  });

  it("a successful reconnect retries the failed turn on its own", async () => {
    await runWait(`return !!visibleDock();`, { label: "chat open" });
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'one more auth error please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    // Account-auth OpenRouter agent → the card offers a one-click
    // reconnect beside Retry.
    await runWait(
      `return !!$('[data-testid="chat-error-card"]') &&
              !!$('[data-testid="chat-reauth"]');`,
      { timeoutMs: 30_000, label: "reconnect button on the auth card" },
    );
    await run(`$('[data-testid="chat-reauth"]').click(); return true;`);
    // The e2e login stub completes ~immediately; the successful reconnect
    // must retry the failed turn WITHOUT another click or message.
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('Recovered after reconnecting.'));`,
      { timeoutMs: 30_000, label: "reconnect auto-retried the turn" },
    );
  });

  it("auto-retries rate-limited turns with a visible countdown", async () => {
    await runWait(`return !!visibleDock();`, { label: "chat open" });
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'please hit a rate limit');
      ta.closest('form').requestSubmit();
      return true;
    `);
    // The failure surfaces as a friendly card WITH the auto-retry ticker…
    await runWait(
      `return !!$('[data-testid="chat-error-card"]') &&
              !!$('[data-testid="chat-auto-retry"]');`,
      { timeoutMs: 30_000, label: "rate-limit card with auto-retry ticker" },
    );
    // …and the scheduled retry (5s backoff) recovers without user action.
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('Recovered after the rate limit.'));`,
      { timeoutMs: 30_000, label: "auto-retry recovered on its own" },
    );
  });

  it("queues messages during a turn; edits hold their place until done", async () => {
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'respond slowly please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    // Queue two while the slow turn runs: one to edit, one to delete.
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'wrong words');
      ta.closest('form').requestSubmit();
      setReactValue(ta, 'delete me');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[data-testid="chat-queued-message"]').length === 2;`,
      { label: "two queued ghost bubbles" },
    );
    // Delete the second straight away.
    await run(`
      const items = $$('[data-testid="chat-queued-message"]');
      items[1].querySelector('[data-testid="chat-queued-delete"]').click();
      return true;
    `);
    await runWait(
      `return $$('[data-testid="chat-queued-message"]').length === 1;`,
      { label: "queued message deleted (animated out)" },
    );
    // Start editing the head; its dispatch must WAIT for the edit even
    // after the slow turn finishes.
    await run(`
      $('[data-testid="chat-queued-message"]')
        .querySelector('[aria-label="Edit queued message"]').click();
      return true;
    `);
    await runWait(`return !!$('[data-testid="chat-queued-edit"]');`, {
      label: "inline queue editor",
    });
    await run(`
      setReactValue($('[data-testid="chat-queued-edit"]'), 'actually right words');
      return true;
    `);
    // Slow turn (4s) settles while the edit is open — nothing dispatches.
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('Done after a long think.'));`,
      { timeoutMs: 30_000, label: "slow turn finished during the edit" },
    );
    const dispatchedEarly = await run<boolean>(`
      return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: wrong words') ||
                      el.textContent.includes('You said: actually right words'));
    `);
    if (dispatchedEarly) {
      throw new Error("queued message dispatched while it was being edited");
    }
    // Committing the edit (Enter) releases it; the edited text sends.
    await run(`
      const editor = $('[data-testid="chat-queued-edit"]');
      editor.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: actually right words'));`,
      { timeoutMs: 30_000, label: "edited queued message sent after commit" },
    );
  });

  it("send-now and Cmd+Enter interrupt the running turn", async () => {
    // Queue behind a slow turn, then promote via the bubble's send-now.
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'respond slowly please');
      ta.closest('form').requestSubmit();
      setReactValue(ta, 'urgent now');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[data-testid="chat-queued-message"]').length === 1;`,
      { label: "queued behind the slow turn" },
    );
    await run(`
      $('[data-testid="chat-queued-send-now"]').click();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: urgent now'));`,
      { timeoutMs: 30_000, label: "promoted message answered" },
    );
    try {
      await runWait(
        `return $$('[role="log"] div')
          .some((el) => el.textContent.trim() === 'Interrupted');`,
        { label: "interrupted note for the aborted turn" },
      );
    } catch (error) {
      console.log(
        "interrupt-debug:",
        JSON.stringify(
          await run<unknown>(`
            return $$('[role="log"] article, [role="log"] .italic')
              .map((el) => el.textContent.trim().slice(0, 60)).slice(-8);
          `),
        ),
      );
      console.log(
        "app-tail:",
        app
          .getOutput()
          .split("\n")
          .filter(
            (line) => line.includes("[fake]") || line.includes("interrupt"),
          )
          .slice(-10)
          .join("\n"),
      );
      throw error;
    }

    // Cmd+Enter from the composer takes the same fast path.
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'respond slowly please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] div, [role="log"] span')
        .some((el) => el.textContent.includes('Working on it'));`,
      { timeoutMs: 30_000, label: "second slow turn running" },
    );
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'jump the line');
      ta.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: jump the line'));`,
      { timeoutMs: 30_000, label: "Cmd+Enter message answered immediately" },
    );
  });

  it("pastes an image as an attachment and sends it", async () => {
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        'pixel.png', { type: 'image/png' }));
      ta.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !!$('[data-testid="composer-attachments"] img');`, {
      label: "pasted image chip in the composer",
    });
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'here is a screenshot');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('Received 1 attachment: pixel.png'));`,
      { timeoutMs: 30_000, label: "agent saw the attachment" },
    );
    // The sent message renders the image thumbnail in the timeline.
    await runWait(`return $$('[role="log"] article img').length > 0;`, {
      label: "image thumbnail on the sent message",
    });
  });

  it("terminal chips appear, spin only while the command runs, and survive tab open/close", async () => {
    await runWait(`return !!visibleDock();`, { label: "chat open" });
    // A slow-ish command: the chip must spin DURING it and stop AFTER.
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'terminal: sleep 3 && echo chip-done');
      ta.closest('form').requestSubmit();
      return true;
    `);
    try {
      await runWait(
        `return !!$('[data-testid="surface-chip"][data-active]');`,
        {
          timeoutMs: 30_000,
          label: "chip spinning while the command runs",
        },
      );
    } catch (error) {
      console.log(
        "chip-debug:",
        JSON.stringify(
          await run<unknown>(`
            return {
              chips: $$('[data-testid="surface-chip"]').map((el) => ({
                active: el.hasAttribute('data-active'),
                text: el.textContent.trim().slice(0, 30),
              })),
              lastArticles: $$('[role="log"] article')
                .map((el) => el.textContent.trim().slice(0, 120)).slice(-3),
            };
          `),
        ),
      );
      throw error;
    }
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('chip-done'));`,
      { timeoutMs: 30_000, label: "command output returned to the agent" },
    );
    // Command over, shell still alive: the spinner must be OFF.
    await runWait(
      `return !!$('[data-testid="surface-chip"]') &&
              !$('[data-testid="surface-chip"][data-active]');`,
      { timeoutMs: 15_000, label: "chip idle once the command finished" },
    );

    // Open the chip as a tab, close the tab — later chats must still get
    // their chips (regression: this used to strand future attachments).
    await run(`
      $('[data-testid="surface-chip"] button').click();
      return true;
    `);
    await runWait(
      `return $$('[role="tab"], button').some((el) =>
        /Close .*[Tt]erminal/.test(el.getAttribute('aria-label') ?? ''));`,
      { label: "terminal open as a tab" },
    );
    await run(`
      $$('button').find((el) =>
        /Close .*[Tt]erminal/.test(el.getAttribute('aria-label') ?? '')).click();
      return true;
    `);
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "fresh chat open" });
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'terminal: echo chip-two');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('chip-two'));`,
      { timeoutMs: 30_000, label: "second run returned output" },
    );
    await runWait(
      `return !!visibleDock().querySelector('[data-testid="surface-chip"]');`,
      { timeoutMs: 15_000, label: "new chat still gets its terminal chip" },
    );
  });

  it("agents can target an existing terminal by id", async () => {
    // Reuse the terminal from the previous message instead of opening
    // another tab: extract its id from the tool result in the timeline.
    const terminalId = await run<string | null>(`
      const texts = $$('[role="log"] article').map((el) => el.textContent);
      for (const text of texts.reverse()) {
        const match = /"terminalId":"([0-9a-f-]+)"/.exec(text);
        if (match) return match[1];
      }
      return null;
    `);
    if (!terminalId) throw new Error("no terminalId in prior tool results");
    const tabsBefore = await run<number>(
      `return $$('[data-testid="surface-chip"]').length;`,
    );
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'terminal @${terminalId}: echo targeted-run');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('targeted-run') &&
                      el.textContent.includes('terminal result'));`,
      { timeoutMs: 30_000, label: "targeted run returned output" },
    );
    const tabsAfter = await run<number>(
      `return $$('[data-testid="surface-chip"]').length;`,
    );
    if (tabsAfter > tabsBefore) {
      throw new Error("targeting an existing terminal opened a new one");
    }
  });

  it("marks agent switches in the transcript", async () => {
    // A second agent to switch to (e2e mode: everything maps to the fake).
    await run(`
      return window.catamorphicDesktop.agentsCreate(
        { name: 'Second Fake', harness: 'ai-sdk' });
    `);
    await ensurePalette();
    await resetPalette();
    await run(`setReactValue(paletteInput(), '>switch agent'); return true;`);
    await runWait(pickOption("Switch agent for this chat"), {
      label: "switch-agent picker",
    });
    await runWait(pickOption("Second Fake"), { label: "pick Second Fake" });
    await runWait(
      `return $$('[role="log"] div')
        .some((el) => el.textContent.trim() === 'Switched to Second Fake');`,
      { timeoutMs: 15_000, label: "agent-change marker in the timeline" },
    );
  });
});
