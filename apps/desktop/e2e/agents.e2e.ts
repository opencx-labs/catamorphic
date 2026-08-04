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
    // The seeded fake agents authenticate with an API key; that shows up
    // as faded detail beside the harness label.
    await openPicker("Change default agent", "Default agent");
    await runWait(
      `return paletteRows().some((el) => el.textContent.includes('API key'));`,
      { label: "account detail on agent rows" },
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
      const ta = visibleDock().querySelector('textarea');
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
});
