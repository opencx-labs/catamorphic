import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * End-to-end flows against the real Electron app: isolated userData dir,
 * embedded server with the deterministic fake agent (no API key, no real
 * sandbox). One app instance for the whole file; tests build on each other
 * in order (project → tabs → chats), matching how a user session flows.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
});

afterAll(async () => {
  await app?.stop();
});

/** DOM helpers injected into every eval — keep selectors in one place. */
const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('textarea'));
  // Only the floating variant — a chat expanded into a tab is also a
  // visible dock, but full-bleed (max-w-full).
  const floatingDock = () =>
    $$('section[aria-label]').find((el) =>
      !el.inert && el.querySelector('textarea') && !el.className.includes('max-w-full'));
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  const timelineMessages = () =>
    $$('[role="log"] article').map((el) => ({
      role: el.querySelector('div')?.textContent.trim(),
      text: el.textContent.trim(),
    }));
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
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

describe("first launch", () => {
  it("boots to the empty state with no projects", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      label: "empty-state New project button",
    });
  });

  it("creates a project and lands on a palette New Tab", async () => {
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    // Point the location at a temp folder (bypasses the native folder picker).
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-project');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    // First workspace tab is the palette "New Tab" (same as Cmd+T).
    await runWait(
      `return !!byText('[role="tab"], button', 'New Tab') &&
              !!$('textarea[placeholder*="Search or ask"]');`,
      { timeoutMs: 60_000, label: "palette New Tab after project creation" },
    );
  });
});

describe("browser tabs", () => {
  it("opens a browser tab with the new-browser-tab shortcut", async () => {
    await run(`pressKey('t', { metaKey: true, shiftKey: true }); return true;`);
    await runWait(`return !!$('input[aria-label="Address and search bar"]');`, {
      timeoutMs: 30_000,
      label: "browser address bar",
    });
  });

  it("navigates the address bar to a data: page", async () => {
    // data: URL keeps the test offline and deterministic.
    await run(`
      const input = $('input[aria-label="Address and search bar"]');
      input.focus();
      setReactValue(input, 'data:text/html,<title>E2E Page</title><h1>hello e2e</h1>');
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    // The tab label follows the page <title> via webview events.
    await runWait(`return !!byText('button', 'E2E Page');`, {
      timeoutMs: 30_000,
      label: "browser tab titled from page",
    });
  });

  it("closes the browser tab with the close-tab shortcut", async () => {
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return !$('input[aria-label="Address and search bar"]');`, {
      label: "browser tab closed",
    });
  });
});

describe("terminal tabs", () => {
  it("opens a terminal with the new-terminal-tab shortcut", async () => {
    await run(`pressKey('\\u0060', { ctrlKey: true }); return true;`);
    // The emulator (ghostty-web) mounts a canvas once its WASM module
    // loads and the PTY session is live.
    await runWait(`return !!byText('button', 'Terminal') && !!$('canvas');`, {
      timeoutMs: 30_000,
      label: "terminal tab with canvas",
    });
  });

  it("hides the input textarea's caret (no phantom top-left cursor)", async () => {
    // Chromium paints a focused textarea's caret even at opacity 0; the
    // terminal must neutralize it or a phantom caret blinks at (0,0).
    await runWait(
      `const ta = $('textarea[aria-label="Terminal input"]');
       return !!ta && getComputedStyle(ta).caretColor === 'rgba(0, 0, 0, 0)';`,
      { label: "terminal caret-color transparent" },
    );
  });

  it("passes app shortcuts through the focused terminal (Cmd+W closes)", async () => {
    // Dispatched on the terminal's own textarea, not the window: ghostty's
    // key handler must let bound shortcuts bubble instead of eating them.
    await run(`
      const ta = $('textarea[aria-label="Terminal input"]');
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'w', code: 'KeyW', metaKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !$('canvas');`, { label: "terminal tab closed" });
  });
});

describe("editor tabs", () => {
  it("opens an editor tab from the palette and quick-opens a file", async () => {
    await run(`pressKey('p', { metaKey: true }); return true;`);
    await runWait(`return !!$('textarea[placeholder*="Search or ask"]');`, {
      label: "palette overlay",
    });
    await run(`
      const input = $('textarea[placeholder*="Search or ask"]');
      setReactValue(input, 'new editor');
      return true;
    `);
    await runWait(
      `const input = $('textarea[placeholder*="Search or ask"]');
       if (!byText('button', 'New editor')) return false;
       input.dispatchEvent(new KeyboardEvent('keydown',
         { key: 'Enter', bubbles: true, cancelable: true }));
       return true;`,
      { label: "run New editor action" },
    );
    await runWait(`return !!$('input[placeholder*="Open a file"]');`, {
      label: "editor quick-open",
    });
    // The project template seeds files; pick the root package.json.
    await runWait(
      `const row = byText('button', 'package.json');
       if (!row) return false; row.click(); return true;`,
      { label: "package.json in quick-open" },
    );
    await runWait(
      `return !!$('.monaco-editor') && !!byText('button', 'package.json');`,
      { timeoutMs: 60_000, label: "Monaco open on package.json" },
    );
  });

  it("closes the editor tab with the close-tab shortcut", async () => {
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return !$('.monaco-editor');`, {
      label: "editor tab closed",
    });
  });
});

describe("chat flows", () => {
  it("Cmd+N opens a floating chat; repeated Cmd+N does not stack empties", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "floating chat open" });
    await run(`
      pressKey('n', { metaKey: true });
      pressKey('n', { metaKey: true });
      return true;
    `);
    const dockCount = await run<number>(
      `return $$('section[aria-label]').filter((el) => el.querySelector('textarea')).length;`,
    );
    expect(dockCount).toBe(1);
  });

  it("sends a message and renders the fake agent's reply", async () => {
    await run(`
      const dock = visibleDock();
      const ta = dock.querySelector('textarea');
      setReactValue(ta, 'hello agent');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return timelineMessages().some((m) => m.text.includes('You said: hello agent'));`,
      { timeoutMs: 30_000, label: "agent reply in timeline" },
    );
    // set_title flowed through: the session shows up renamed in the sidebar.
    await runWait(`return !!byText('button', 'Quick chat');`, {
      timeoutMs: 30_000,
      label: "session title in sidebar",
    });
  });

  it("streams preambles as separate completed messages", async () => {
    await run(
      `byText('button', 'New chat')?.click() ?? pressKey('n', { metaKey: true }); return true;`,
    );
    await runWait(`return !!visibleDock();`);
    await run(`
      const ta = visibleDock().querySelector('textarea');
      setReactValue(ta, 'do the preamble dance');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return timelineMessages().some((m) => m.text.includes('two preambles, one summary'));`,
      { timeoutMs: 30_000, label: "final summary message" },
    );
    const agentTexts = await run<string[]>(`
      return timelineMessages()
        .filter((m) => m.role === 'Agent')
        .map((m) => m.text);
    `);
    // Three separate agent messages, in emission order — not one merged blob.
    expect(
      agentTexts.filter((text) =>
        /look at the project|writing some notes|two preambles/.test(text),
      ),
    ).toHaveLength(3);
    // The file the fake agent wrote synced back as a changed-file chip.
    await runWait(
      `return !!byText('[role="log"] button, [role="log"] code', 'NOTES.md');`,
      {
        label: "changed-file chip",
      },
    );
  });
});

describe("palette intent", () => {
  // Prefer the focused palette input (Cmd+P focuses the overlay's); fall
  // back to any non-inert one. Blind Cmd+P would TOGGLE an already-open
  // overlay closed, so ensurePalette checks before pressing.
  const paletteInput = `(
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => document.activeElement === el) ??
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => !el.closest('[inert]'))
  )`;
  const ensurePalette = async () => {
    await run(
      `if (!(${paletteInput})) pressKey('p', { metaKey: true }); return true;`,
    );
    await runWait(`return !!(${paletteInput});`, { label: "palette open" });
  };
  const paletteKey = (key: string, mods = "{}") => `
    const input = ${paletteInput};
    input.dispatchEvent(new KeyboardEvent('keydown',
      { key: '${key}', bubbles: true, cancelable: true, ...${mods} }));
    return true;
  `;

  it("opens the palette", async () => {
    await ensurePalette();
  });

  // All lookups scoped to the input's own dialog — the New Tab palette
  // and the overlay can both be mounted.
  const inDialog = (selector: string) =>
    `[...(${paletteInput}).closest('[role="dialog"]').querySelectorAll('${selector}')]`;

  it("puts Open <url> first for URL-shaped input", async () => {
    await run(
      `setReactValue(${paletteInput}, 'example.com/docs'); return true;`,
    );
    await runWait(
      `return ${inDialog('[role="option"]')}[0]?.textContent.includes('Open example.com/docs');`,
      { label: "open-url row first" },
    );
  });

  it("lists modes on @ and commits a chip with Tab", async () => {
    await run(`setReactValue(${paletteInput}, '@'); return true;`);
    await runWait(
      `const options = ${inDialog('[role="option"]')};
       return options.some((el) => el.textContent.includes('Ask the agent')) &&
              options.some((el) => el.textContent.includes('Search the web'));`,
      { label: "@ zero-state mode rows" },
    );
    await run(`setReactValue(${paletteInput}, '@agent'); return true;`);
    await run(paletteKey("Tab"));
    await runWait(
      `const chip = ${inDialog('[data-testid="palette-mode-chip"]')}[0];
       return !!chip && chip.textContent.includes('Ask agent') &&
              (${paletteInput}).value === '';`,
      { label: "agent chip committed, input cleared" },
    );
  });

  it("in agent mode, Enter sends the message to a new chat", async () => {
    await run(
      `setReactValue(${paletteInput}, 'hello from palette mode'); return true;`,
    );
    await runWait(
      `return ${inDialog('[role="option"]')}[0]?.textContent.includes('Ask agent: hello from palette mode');`,
      { label: "agent mode row reflects input" },
    );
    await run(paletteKey("Enter"));
    await runWait(
      `return timelineMessages().some((m) => m.text.includes('You said: hello from palette mode'));`,
      { timeoutMs: 30_000, label: "palette message reached the agent" },
    );
  });

  it("Backspace on empty input pops the mode chip", async () => {
    await ensurePalette();
    await run(`setReactValue(${paletteInput}, '@web'); return true;`);
    await run(paletteKey("Tab"));
    await runWait(
      `return ${inDialog('[data-testid="palette-mode-chip"]')}.length === 1;`,
      { label: "web chip committed" },
    );
    await run(paletteKey("Backspace"));
    await runWait(
      `return ${inDialog('[data-testid="palette-mode-chip"]')}.length === 0;`,
      { label: "chip popped" },
    );
  });

  it("> filters to command rows only, and the footer shows hints", async () => {
    await ensurePalette();
    await run(`setReactValue(${paletteInput}, '>'); return true;`);
    await runWait(
      `const options = ${inDialog('[role="option"]')};
       return options.length > 0 &&
              options.some((el) => el.textContent.includes('Toggle sidebar')) &&
              !options.some((el) => el.textContent.includes('Settings'));`,
      { label: "> shows commands, hides navigate rows" },
    );
    const footer = await run<boolean>(
      `const footer = ${inDialog('[data-testid="palette-footer"]')}[0];
       return !!footer && footer.textContent.includes('modes') &&
              footer.textContent.includes('commands');`,
    );
    expect(footer).toBe(true);
    await run(`pressKey('Escape'); return true;`);
  });
});

describe("chat tab activity indicators", () => {
  // The tab strip is the only .app-no-drag flex row with items-end.
  const tabStrip = `document.querySelector('.app-no-drag.items-end')`;
  const tabSpinnerOn = `[...${tabStrip}.querySelectorAll('svg.animate-spin')]
    .some((el) => getComputedStyle(el).opacity === '1')`;
  const tabDotOn = `[...${tabStrip}.querySelectorAll('span.bg-accent')]
    .some((el) => getComputedStyle(el).opacity === '1')`;

  it("the tab icon cross-fades to a spinner while the agent works", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`);
    // Make sure the chat is a workspace tab. With no other tabs open Cmd+N
    // already lands as a tab (no promote button); otherwise promote it.
    await run(`
      $$('button[aria-label="Open as tab"]')
        .find((el) => !el.closest('[inert]'))?.click();
      return true;
    `);
    await runWait(`return !!byText('button', 'New chat');`, {
      label: "chat tab in the strip",
    });
    await run(`
      const ta = visibleDock().querySelector('textarea');
      setReactValue(ta, 'work slowly please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(`return ${tabSpinnerOn};`, {
      label: "tab icon spinner during the turn",
    });
  });

  it("finishing while the tab is hidden lands an unread dot; opening clears it", async () => {
    // Hide the chat tab behind a fresh palette tab mid-turn.
    await run(`pressKey('t', { metaKey: true }); return true;`);
    await runWait(`return ${tabDotOn};`, {
      timeoutMs: 30_000,
      label: "unread dot on the hidden chat tab",
    });
    await run(`return ${tabSpinnerOn};`).then((spinning) =>
      expect(spinning).toBe(false),
    );
    // Selecting the chat tab marks it read (the tab is renamed to the
    // session title once the sessions list refetches).
    await runWait(
      `const tab = byText('button', 'Slow burn');
       if (!tab) return false; tab.click(); return true;`,
      { label: "chat tab selectable by its title" },
    );
    await runWait(`return !(${tabDotOn});`, { label: "dot cleared on open" });
    // Leave a clean slate: close the chat tab and the extra palette tab.
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await run(`pressKey('w', { metaKey: true }); return true;`);
  });

  it("closing a chat mid-turn clears its activity", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "floating chat open" });
    await run(`
      const ta = visibleDock().querySelector('textarea');
      setReactValue(ta, 'work slowly please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(`return spinnersOn() > 0;`, {
      label: "spinner during the turn",
    });
    // Close the chat while the agent is still working: no orphaned
    // activity indicator may stay behind anywhere.
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return spinnersOn() === 0;`, {
      timeoutMs: 2_000,
      label: "no visible spinners after the close",
    });
  });
});

describe("question flow", () => {
  it("an interview prompt raises the question panel", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`);
    await run(`
      const ta = visibleDock().querySelector('textarea');
      setReactValue(ta, 'ask me a bunch of questions about myself');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return !!$('section[aria-label="The agent has a question"]');`,
      { timeoutMs: 30_000, label: "question panel visible" },
    );
    // The preamble the agent sent before asking is already in the timeline.
    await runWait(
      `return timelineMessages().some((m) => m.text.includes('quick questions first'));`,
      { label: "question preamble message" },
    );
  });

  it("answers the questions and the agent acknowledges", async () => {
    await run(`
      const panel = $('section[aria-label="The agent has a question"]');
      byText('section[aria-label="The agent has a question"] button', 'Orange').click();
      return true;
    `);
    // Single-select auto-advances to question 2 after its 220ms glide.
    await runWait(
      `const panel = $('section[aria-label="The agent has a question"]');
       const cats = byText('section[aria-label="The agent has a question"] button', 'Cats');
       if (!cats || cats.closest('[inert]')) return false;
       cats.click(); return true;`,
      { label: "second question selectable" },
    );
    await runWait(
      `const submit = byText('section[aria-label="The agent has a question"] button', 'Submit');
       if (!submit || submit.disabled) return false;
       submit.click(); return true;`,
      { label: "submit answers" },
    );
    await runWait(
      `return timelineMessages().some((m) => m.text.includes('Got it — noted'))
           && !$('section[aria-label="The agent has a question"]');`,
      { timeoutMs: 30_000, label: "agent acknowledgment, panel gone" },
    );
  });
});

describe("chat surface shortcuts", () => {
  it("Cmd+M minimizes the floating chat; Cmd+M again restores it", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!floatingDock();`, { label: "floating chat open" });
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !floatingDock();`, { label: "chat minimized" });
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !!floatingDock();`, { label: "chat restored" });
  });

  it("Cmd+Shift+M expands the chat into a workspace tab", async () => {
    await run(`pressKey('M', { metaKey: true, shiftKey: true }); return true;`);
    // Tab mode: the dock sheds its floating footprint and fills the tab.
    await runWait(
      `return !floatingDock() && !!visibleDock() &&
              visibleDock().className.includes('max-w-full');`,
      { label: "chat dock in tab mode" },
    );
  });

  it("Cmd+W plays the exit collapse before removing the floating chat", async () => {
    // Escape steps the tab back down to a floating dock first.
    await run(`pressKey('Escape'); return true;`);
    await runWait(`return !!floatingDock();`, {
      label: "back to floating dock",
    });
    // Count docks (mounted sections), not just the visible one — minimized
    // bubbles from earlier tests keep their sections mounted too.
    const docks = `$$('section[aria-label]').filter((el) => el.querySelector('form textarea')).length`;
    const before = await run<number>(`return ${docks};`);
    await run(`pressKey('w', { metaKey: true }); return true;`);
    // Immediately after Cmd+W the dock must still be mounted: the same
    // 250ms collapse Escape plays, then the unmount.
    const during = await run<number>(`return ${docks};`);
    expect(during).toBe(before);
    await runWait(`return ${docks} === ${before - 1};`, {
      label: "dock unmounted after collapse",
    });
  });
});

describe("navigation shortcuts", () => {
  it("Cmd+. / Cmd+, cycle the floating dock through chats", async () => {
    // Fresh empty chat ("New chat") joins the titled chats from earlier
    // groups — cycling must swap which chat the dock shows.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!floatingDock();`, { label: "dock open" });
    const first = await run<string>(
      `return floatingDock().getAttribute('aria-label');`,
    );
    await run(`pressKey('.', { metaKey: true }); return true;`);
    await runWait(
      `return !!floatingDock() &&
              floatingDock().getAttribute('aria-label') !== ${JSON.stringify(first)};`,
      { label: "next chat in the dock" },
    );
    await run(`pressKey(',', { metaKey: true }); return true;`);
    await runWait(
      `return !!floatingDock() &&
              floatingDock().getAttribute('aria-label') === ${JSON.stringify(first)};`,
      { label: "back to the first chat" },
    );
  });

  it("Cmd+[ / Cmd+] cycle workspace tabs", async () => {
    // A second tab to cycle against the palette New Tab.
    await run(`pressKey('\\u0060', { ctrlKey: true }); return true;`);
    await runWait(
      `return !!$('canvas') && !$('canvas').closest('div.hidden');`,
      {
        timeoutMs: 30_000,
        label: "terminal tab active",
      },
    );
    await run(`pressKey('[', { metaKey: true }); return true;`);
    await runWait(`return !!$('canvas').closest('div.hidden');`, {
      label: "previous tab active (terminal pane hidden)",
    });
    await run(`pressKey(']', { metaKey: true }); return true;`);
    await runWait(`return !$('canvas').closest('div.hidden');`, {
      label: "next tab active (terminal pane visible)",
    });
  });
});

describe("tiling and chat surfaces", () => {
  it("attaches agent-linked pages and rail terminals to the chat", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!floatingDock();`, { label: "chat open" });
    // The fake agent echoes the message — markdown link included.
    await run(`
      const ta = floatingDock().querySelector('textarea');
      setReactValue(ta, 'see [example](https://example.com/) ok');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return !!floatingDock()?.querySelector('.cat-markdown a');`,
      {
        timeoutMs: 30_000,
        label: "agent reply renders the link",
      },
    );
    // Clicking the agent's link opens an ATTACHED browser tab (the page
    // itself may not load offline — the tab and rail chip still appear).
    await run(
      `floatingDock().querySelector('.cat-markdown a').click(); return true;`,
    );
    await runWait(`return !!$('input[aria-label="Address and search bar"]');`, {
      timeoutMs: 30_000,
      label: "attached browser tab",
    });
    await runWait(
      `return [...(floatingDock()?.querySelectorAll('button') ?? [])]
         .some((el) => el.title?.startsWith('Open '));`,
      { label: "browser chip on the surfaces rail" },
    );
    // "+ Terminal" opens a terminal attached to this chat.
    await run(
      `[...floatingDock().querySelectorAll('button')]
         .find((el) => el.title === 'Open a terminal attached to this chat')
         .click();
       return true;`,
    );
    await runWait(`return !!$('canvas');`, {
      timeoutMs: 30_000,
      label: "attached terminal",
    });
  });

  it("opens a surface to the right as a split; Cmd+\\ toggles it", async () => {
    // Terminal is the active tab; split-open the browser chip beside it.
    await run(
      `[...floatingDock().querySelectorAll('button')]
         .find((el) => el.getAttribute('aria-label')?.endsWith('to the right'))
         .click();
       return true;`,
    );
    await runWait(
      `return !!$('div[class*="right-1/2"]') &&
              $$('canvas').some((el) => !el.closest('div.hidden'));`,
      { label: "split view: terminal + browser" },
    );
    await run(`pressKey('\\\\', { metaKey: true }); return true;`);
    await runWait(`return !$('div[class*="right-1/2"]');`, {
      label: "unsplit to the focused tab",
    });
    await run(`pressKey('\\\\', { metaKey: true }); return true;`);
    await runWait(`return !!$('div[class*="right-1/2"]');`, {
      label: "re-split with the previous tab",
    });
  });

  it("closing the focused pane collapses the split to its partner", async () => {
    // Park the chat so Cmd+W targets the focused pane (retry-safe).
    await run(
      `if (floatingDock()) pressKey('m', { metaKey: true }); return true;`,
    );
    await runWait(`return !floatingDock();`, { label: "chat parked" });
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(
      `return !$('div[class*="right-1/2"]') &&
              $$('canvas').some((el) => !el.closest('div.hidden'));`,
      { label: "split collapsed to the terminal" },
    );
  });
});
