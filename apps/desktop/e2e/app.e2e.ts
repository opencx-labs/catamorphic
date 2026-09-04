import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

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
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  // Only the floating variant — a chat expanded into a tab is also a
  // visible dock, but full-bleed (max-w-full).
  const floatingDock = () =>
    $$('section[aria-label]').find((el) =>
      !el.inert && el.querySelector('[data-composer-input]') && !el.className.includes('max-w-full'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  const timelineMessages = () =>
    $$('[role="log"] article').map((el) => ({
      // No name tags in the timeline — side placement is the role: user
      // bubbles hug the right (ml-auto), agent prose the left.
      role: el.className.includes('ml-auto') ? 'You' : 'Agent',
      text: el.textContent.trim(),
    }));
  const spinnersOn = (includeExiting = true) => $$('svg.animate-spin').filter((el) => {
    // Hidden Chromium can pause opacity transitions on mounted alternatives
    // such as the inactive aggregate bubble. Inert/aria-hidden UI is not a
    // live activity surface, regardless of the transition frame it retains.
    if (!includeExiting && el.closest('[inert], [aria-hidden="true"]')) return false;
    if (!includeExiting && el.closest('.animate-bubble-out')) return false;
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

const holdAnimationFrames = () =>
  run(`
    if (window.__e2eAnimationFrameHold) {
      throw new Error('animation frames are already held');
    }
    const callbacks = new Map();
    const originalRequest = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    let nextId = 2_000_000_000;
    window.__e2eAnimationFrameHold = {
      callbacks,
      originalRequest,
      originalCancel,
    };
    window.requestAnimationFrame = (callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!callbacks.delete(id)) originalCancel(id);
    };
    return true;
  `);

const releaseAnimationFrames = () =>
  run<number>(`
    const hold = window.__e2eAnimationFrameHold;
    if (!hold) return 0;
    const callbacks = [...hold.callbacks.values()];
    try {
      window.requestAnimationFrame = hold.originalRequest;
      window.cancelAnimationFrame = hold.originalCancel;
      delete window.__e2eAnimationFrameHold;
      callbacks.forEach((callback) => callback(performance.now()));
      return callbacks.length;
    } finally {
      window.requestAnimationFrame = hold.originalRequest;
      window.cancelAnimationFrame = hold.originalCancel;
      delete window.__e2eAnimationFrameHold;
    }
  `);

const restoreAnimationFrames = () =>
  run(`
    const hold = window.__e2eAnimationFrameHold;
    if (!hold) return false;
    window.requestAnimationFrame = hold.originalRequest;
    window.cancelAnimationFrame = hold.originalCancel;
    delete window.__e2eAnimationFrameHold;
    return true;
  `);

const waitForHeldAnimationFrame = () =>
  runWait(`return (window.__e2eAnimationFrameHold?.callbacks.size ?? 0) > 0;`, {
    label: "deferred autofocus frame held",
  });

const settleAnimationFrame = () =>
  run(`
    return new Promise((resolve) =>
      requestAnimationFrame(() => resolve(true))
    );
  `);

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

  it("does not load editor or terminal runtimes before first use", async () => {
    const resources = await run<string[]>(`
      return performance.getEntriesByType('resource').map((entry) => entry.name);
    `);
    expect(
      resources.some((url) => /monaco|editor\.api|ts\.worker/.test(url)),
    ).toBe(false);
    expect(resources.some((url) => /terminal-screen/.test(url))).toBe(false);
  });
});

describe("browser tabs", () => {
  it("opens a browser tab with the new-browser-tab shortcut", async () => {
    await run(`pressKey('t', { metaKey: true, altKey: true }); return true;`);
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

  it("navigates browser history with Cmd+Left and Cmd+Right", async () => {
    await run(`
      const input = $('input[aria-label="Address and search bar"]');
      input.focus();
      setReactValue(input, 'data:text/html,<title>Second E2E Page</title><h1>second</h1>');
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !!byText('button', 'Second E2E Page');`, {
      timeoutMs: 30_000,
      label: "second browser history entry",
    });

    await run(`pressKey('ArrowLeft', { metaKey: true }); return true;`);
    await runWait(`return !!byText('button', 'E2E Page');`, {
      timeoutMs: 30_000,
      label: "browser history moved back",
    });
    await run(`pressKey('ArrowRight', { metaKey: true }); return true;`);
    await runWait(`return !!byText('button', 'Second E2E Page');`, {
      timeoutMs: 30_000,
      label: "browser history moved forward",
    });

    const isMac = await run<boolean>(
      `return navigator.platform.toLowerCase().startsWith('mac');`,
    );
    if (isMac) {
      await run(`
        void $('webview').executeJavaScript(
          "window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true }))",
        );
        return true;
      `);
      await runWait(`return !!byText('button', 'E2E Page');`, {
        timeoutMs: 30_000,
        label: "browser mouse button moved back",
      });
      await run(`
        void $('webview').executeJavaScript(
          "window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true }))",
        );
        return true;
      `);
      await runWait(`return !!byText('button', 'Second E2E Page');`, {
        timeoutMs: 30_000,
        label: "browser mouse button moved forward",
      });
    }
  });

  it("coalesces duplicate Cmd+W dispatches into one closed tab", async () => {
    await run(`pressKey('t', { metaKey: true, altKey: true }); return true;`);
    await runWait(
      `return $$('input[aria-label="Address and search bar"]').length === 2;`,
      { label: "second browser tab" },
    );
    await run(`
      const input = $$('input[aria-label="Address and search bar"]').at(-1);
      input.focus();
      setReactValue(input, 'data:text/html,<title>Close Target</title><h1>close me</h1>');
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !!byText('button', 'Close Target');`, {
      timeoutMs: 30_000,
      label: "second browser tab navigated",
    });
    await run(`
      pressKey('w', { metaKey: true });
      pressKey('w', { metaKey: true });
      return true;
    `);
    // Occluded Chromium can pause CSS animations and omit animationend.
    // Freeze this exit deliberately: the clock fallback must still clear
    // exactly the one closed tab from the rendered strip.
    await runWait(
      `const exiting = $('.animate-tab-out');
       if (!exiting) return false;
       exiting.getAnimations().forEach((animation) => animation.pause());
       return true;`,
      { label: "outgoing browser tab staged" },
    );
    const afterClose = await run<{
      webviews: number;
      tabLabels: string[];
    }>(`
      return new Promise((resolve) => setTimeout(() => resolve({
        webviews: $$('webview').length,
        tabLabels: $$('[data-point-key] button').map((button) =>
          button.textContent.trim()),
      }), 800));
    `);
    expect(afterClose.webviews).toBe(1);
    expect(afterClose.tabLabels.join(" ")).not.toContain("Close Target");
  });

  it("closes the browser tab with the close-tab shortcut", async () => {
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return !$('input[aria-label="Address and search bar"]');`, {
      label: "browser tab closed",
    });
  });

  it("Cmd+Shift+T reopens the closed browser tab at its URL", async () => {
    await run(`pressKey('T', { metaKey: true, shiftKey: true }); return true;`);
    const restored = await run<{
      inputCount: number;
      tabLabels: string[];
    }>(`
      return new Promise((resolve) => setTimeout(() => resolve({
        inputCount: $$('input[aria-label="Address and search bar"]').length,
        tabLabels: $$('[data-point-key] button').map((button) =>
          button.textContent.trim()),
      }), 2000));
    `);
    expect(restored.inputCount).toBe(1);
    expect(restored.tabLabels.join(" ")).toContain("E2E Page");
    // Close it again so later groups start from the same slate as before.
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return !$('input[aria-label="Address and search bar"]');`, {
      label: "restored tab closed again",
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
    // Project creation seeds skill files; pick a seeded package.json.
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
      `return $$('section[aria-label]').filter((el) => el.querySelector('[data-composer-input]')).length;`,
    );
    expect(dockCount).toBe(1);
  });

  it("sends a message and renders the fake agent's reply", async () => {
    await run(`
      const dock = visibleDock();
      const ta = dock.querySelector('[data-composer-input]');
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

  it("previews a chat's agent, environment, and current state", async () => {
    await run(`
      const chat = byText('button', 'Quick chat');
      chat.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    `);

    await runWait(
      `const preview = $('[data-testid="sidebar-preview"]');
       return !!preview && parseFloat(getComputedStyle(preview).opacity) > 0.9;`,
      {
        label: "chat metadata hover preview",
      },
    );
    const previewText = await run<string>(
      `return $('[data-testid="sidebar-preview"]').textContent;`,
    );
    expect(previewText).toContain("Fake Agent");
    expect(previewText).toContain("Environment");
    expect(previewText).toContain("local");
    expect(previewText).toContain("Status");
    expect(previewText).toContain("Ready");
  });

  it("shows an agent-managed todo progress popover", async () => {
    await run(`
      const dock = visibleDock();
      const input = dock.querySelector('[data-composer-input]');
      setReactValue(input, 'make a todo list for this task');
      input.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `const trigger = visibleDock()?.querySelector('[data-testid="todo-progress-trigger"]');
       return trigger?.textContent.trim() === '1/2';`,
      { timeoutMs: 30_000, label: "todo progress indicator" },
    );
    await run(`
      visibleDock().querySelector('[data-testid="todo-progress-trigger"]').click();
      return true;
    `);
    await runWait(
      `const panel = visibleDock()?.querySelector('[data-testid="todo-progress-popover"]');
       return !!panel && panel.textContent.includes('Verify the result');`,
      { label: "todo popover" },
    );
    const collapsed = await run<boolean>(`
      const panel = visibleDock().querySelector('[data-testid="todo-progress-popover"]');
      const item = [...panel.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Verify the result'));
      return item?.getAttribute('aria-expanded') === 'false' &&
        item?.nextElementSibling?.getAttribute('aria-hidden') === 'true';
    `);
    expect(collapsed).toBe(true);
    await run(`
      const panel = visibleDock().querySelector('[data-testid="todo-progress-popover"]');
      [...panel.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Verify the result')).click();
      return true;
    `);
    await runWait(
      `const panel = visibleDock()?.querySelector('[data-testid="todo-progress-popover"]');
       const item = [...panel.querySelectorAll('button')]
         .find((button) => button.textContent.includes('Verify the result'));
       return item?.getAttribute('aria-expanded') === 'true' &&
         panel.textContent.includes('Run the focused tests') &&
         parseFloat(getComputedStyle(panel).opacity) > 0.9;`,
      { label: "expanded todo description" },
    );

    await runWait(
      `const toggle = $$('[data-testid="chat-turn-steps-toggle"]').at(-1);
       if (!toggle) return false;
       if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
       const step = [...visibleDock().querySelectorAll('[data-testid="chat-step"] button')]
         .find((button) => button.textContent.includes('Updated the todo list'));
       if (!step) return false;
       if (step.getAttribute('aria-expanded') !== 'true') step.click();
       const detail = step.parentElement.querySelector('[data-testid="chat-step-detail"]');
       return detail?.textContent.includes('✓ Inspect the project') &&
         detail.textContent.includes('● Verify the result') &&
         !detail.textContent.includes('"items"');`,
      { label: "readable todo tool step" },
    );

    await run(`
      const input = visibleDock().querySelector('[data-composer-input]');
      setReactValue(input, 'clear todo list');
      input.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return timelineMessages().some((message) =>
         message.text.includes('I cleared the progress list.')) &&
         !visibleDock()?.querySelector('[data-testid="todo-progress"]');`,
      { timeoutMs: 30_000, label: "cleared todo progress leaves the UI" },
    );
  });

  it("streams preambles as separate completed messages", async () => {
    await run(
      `byText('button', 'New chat')?.click() ?? pressKey('n', { metaKey: true }); return true;`,
    );
    await runWait(`return !!visibleDock();`);
    await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
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
    // The file the fake agent wrote shows up in the turn's step log
    // (collapsed by default; expanding reveals the file-edit row).
    await runWait(
      `
      const toggle = $$('[data-testid="chat-turn-steps-toggle"]').at(-1);
      if (!toggle) return false;
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      return $$('[data-testid="chat-step"]').some((el) =>
        el.textContent.includes('NOTES.md'),
      );
      `,
      {
        label: "turn step log shows NOTES.md",
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
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'work slowly please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    // Hide the chat immediately, while the deterministic slow turn still
    // has time to run. Waiting for the spinner before changing tabs races
    // the reply settling on a loaded renderer.
    await run(`pressKey('t', { metaKey: true }); return true;`);
    await runWait(
      `return !visibleDock() &&
        !!$$('textarea[placeholder*="Search or ask"]')
          .find((el) => !el.closest('[inert]'));`,
      { label: "chat hidden behind a fresh palette tab" },
    );
    await runWait(`return ${tabSpinnerOn};`, {
      label: "tab icon spinner during the turn",
    });
  });

  it("finishing while the tab is hidden lands an unread dot; opening clears it", async () => {
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
    const tabsBeforeClose = await run<number>(
      `return $$('[data-point-key]').length;`,
    );
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(
      `return $$('[data-point-key]').length === ${tabsBeforeClose - 1};`,
      { label: "chat tab closed before the next close" },
    );
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(
      `return $$('[data-point-key]').length === ${tabsBeforeClose - 2};`,
      { label: "extra palette tab closed" },
    );
  });

  it("closing a chat mid-turn clears its activity", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "floating chat open" });
    await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'work slowly please');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(`return spinnersOn() > 0;`, {
      label: "spinner during the turn",
    });
    const mountedChatCount = await run<number>(`
      return $$('section[aria-label]')
        .filter((el) => el.querySelector('[data-composer-input]')).length;
    `);
    // Close the chat while the agent is still working: no orphaned
    // activity indicator may stay behind anywhere.
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(
      `return $$('section[aria-label]')
        .filter((el) => el.querySelector('[data-composer-input]')).length
        === ${mountedChatCount - 1};`,
      { timeoutMs: 10_000, label: "chat unmounted after the close animation" },
    );
    // A hidden renderer pauses the exiting bubble's CSS animation, so its
    // snapshot can remain until the window is visible again. It is not live
    // activity; every live chat/tab/aggregate spinner must already be gone.
    await runWait(`return spinnersOn(false) === 0;`, {
      timeoutMs: 2_000,
      label: "no live spinners after the close",
    });
  });
});

describe("question flow", () => {
  it("an interview prompt raises the question panel", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`);
    await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
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
      `return timelineMessages().some((m) => m.text.includes('Got it, noted'))
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
    const docks = `$$('section[aria-label]').filter((el) => el.querySelector('[data-composer-input]')).length`;
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

  it("Cmd+W closes the tab behind the floating chat when the tab has focus", async () => {
    // A browser tab, then a floating chat over it.
    await run(`pressKey('t', { metaKey: true, altKey: true }); return true;`);
    await runWait(`return !!$('input[aria-label="Address and search bar"]');`, {
      timeoutMs: 30_000,
      label: "browser tab",
    });
    try {
      await settleAnimationFrame();
      // Positive branch: with no newer user input, opening the dock still
      // lands in its composer when the delayed frame is finally delivered.
      await holdAnimationFrames();
      await run(`pressKey('n', { metaKey: true }); return true;`);
      await runWait(`return !!floatingDock();`, {
        label: "floating chat open",
      });
      await waitForHeldAnimationFrame();
      await releaseAnimationFrames();
      const composerAutofocused = await run<boolean>(`
        return document.activeElement?.matches?.('[data-composer-input]') &&
          document.activeElement.closest('[data-floating-chat]') !== null;
      `);
      expect(composerAutofocused).toBe(true);

      // Keyboard branch: a real Tab after the focus frame was scheduled
      // makes the newly focused browser control authoritative.
      await run(`pressKey('m', { metaKey: true }); return true;`);
      await runWait(`return !floatingDock();`, { label: "chat minimized" });
      await run(`
        const address = $('input[aria-label="Address and search bar"]');
        const origin = document.createElement('button');
        origin.dataset.e2eKeyboardOrigin = 'true';
        origin.textContent = 'keyboard focus origin';
        const target = document.createElement('button');
        target.dataset.e2eKeyboardFocus = 'true';
        target.textContent = 'keyboard focus target';
        address.insertAdjacentElement('afterend', origin);
        origin.insertAdjacentElement('afterend', target);
        origin.focus();
        return true;
      `);
      await holdAnimationFrames();
      await run(`pressKey('m', { metaKey: true }); return true;`);
      await runWait(`return !!floatingDock();`, { label: "chat restored" });
      await waitForHeldAnimationFrame();
      await app.press("Tab");
      const tabMovedFocus = await run<boolean>(`
        return document.activeElement?.dataset.e2eKeyboardFocus === 'true';
      `);
      expect(tabMovedFocus).toBe(true);
      await releaseAnimationFrames();
      const keyboardFocusPreserved = await run<string>(`
        const active = document.activeElement;
        if (active?.dataset.e2eKeyboardFocus === 'true') return 'keyboard-target';
        if (active?.closest?.('[data-floating-chat]')) return 'floating-chat';
        return active?.outerHTML?.slice(0, 240) ?? String(active);
      `);
      expect(keyboardFocusPreserved).toBe("keyboard-target");

      // Assistive technology may move focus without a preceding DOM keyboard
      // or pointer event. That external focusin is still authoritative.
      await run(`pressKey('m', { metaKey: true }); return true;`);
      await runWait(`return !floatingDock();`, { label: "chat minimized" });
      await holdAnimationFrames();
      await run(`pressKey('m', { metaKey: true }); return true;`);
      await runWait(`return !!floatingDock();`, { label: "chat restored" });
      await waitForHeldAnimationFrame();
      const assistiveFocusMoved = await run<boolean>(`
        const address = $('input[aria-label="Address and search bar"]');
        const target = document.createElement('button');
        target.dataset.e2eAssistiveFocus = 'true';
        target.textContent = 'assistive technology focus target';
        address.insertAdjacentElement('afterend', target);
        target.focus();
        return document.activeElement === target;
      `);
      expect(assistiveFocusMoved).toBe(true);
      await releaseAnimationFrames();
      const assistiveFocusPreserved = await run<boolean>(`
        return document.activeElement?.dataset.e2eAssistiveFocus === 'true';
      `);
      expect(assistiveFocusPreserved).toBe(true);

      // Pointer branch: clicking into the tab's own chrome after a restore
      // likewise wins over the dock's pending autofocus.
      await run(`pressKey('m', { metaKey: true }); return true;`);
      await runWait(`return !floatingDock();`, { label: "chat minimized" });
      await holdAnimationFrames();
      await run(`pressKey('m', { metaKey: true }); return true;`);
      await runWait(`return !!floatingDock();`, { label: "chat restored" });
      await waitForHeldAnimationFrame();
      const addressFocused = await run<boolean>(`
        const address = $('input[aria-label="Address and search bar"]');
        address.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        address.focus();
        return document.activeElement === address;
      `);
      expect(addressFocused).toBe(true);
      await releaseAnimationFrames();
      const browserKeptFocus = await run<boolean>(`
        return document.activeElement ===
          $('input[aria-label="Address and search bar"]');
      `);
      expect(browserKeptFocus).toBe(true);
    } finally {
      await restoreAnimationFrames();
      await run(`
        $('[data-e2e-keyboard-origin]')?.remove();
        $('[data-e2e-keyboard-focus]')?.remove();
        $('[data-e2e-assistive-focus]')?.remove();
        return true;
      `);
    }
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(
      `return !$('input[aria-label="Address and search bar"]') && !!floatingDock();`,
      { label: "browser tab closed, chat still floating" },
    );
    // Back in the chat, Cmd+W closes the chat.
    await run(`
      const ta = floatingDock().querySelector('[data-composer-input]');
      ta.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      ta.focus(); return true;
    `);
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(`return !floatingDock();`, { label: "floating chat closed" });
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
      const ta = floatingDock().querySelector('[data-composer-input]');
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
         .some((el) =>
           (el.getAttribute('aria-label') ?? '').endsWith('to the right'));`,
      { label: "browser chip on the surfaces rail" },
    );
    // A terminal to anchor the upcoming split against.
    await run(`pressKey('\u0060', { ctrlKey: true }); return true;`);
    await runWait(`return !!$('canvas');`, {
      timeoutMs: 30_000,
      label: "terminal open",
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
      `return !!$('[data-split-divider]') &&
              $$('canvas').some((el) => !el.closest('div.hidden'));`,
      { label: "split view: terminal + browser" },
    );
    await run(`pressKey('\\\\', { metaKey: true }); return true;`);
    await runWait(`return !$('[data-split-divider]');`, {
      label: "unsplit to the focused tab",
    });
    await run(`pressKey('\\\\', { metaKey: true }); return true;`);
    await runWait(`return !!$('[data-split-divider]');`, {
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
      `return !$('[data-split-divider]') &&
              $$('canvas').some((el) => !el.closest('div.hidden'));`,
      { label: "split collapsed to the terminal" },
    );
  });
});

describe("agent shows and points", () => {
  it("open_surface opens a tab behind the chat, which steps down to floating", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!floatingDock();`, { label: "chat open" });
    // Expand the chat into a full workspace tab, so the step-down is real.
    await run(`pressKey('m', { metaKey: true, shiftKey: true }); return true;`);
    await runWait(`return !floatingDock();`, { label: "chat is a tab" });
    await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'show: https://example.com/');
      ta.closest('form').requestSubmit();
      return true;
    `);
    // The browser tab opens AND the chat returns to its floating dock.
    await runWait(`return !!$('input[aria-label="Address and search bar"]');`, {
      timeoutMs: 30_000,
      label: "browser tab opened behind the chat",
    });
    await runWait(`return !!floatingDock();`, {
      timeoutMs: 30_000,
      label: "chat stepped down to floating",
    });
  });

  it("point_at glows the pointed tab until the user clicks it", async () => {
    // Point at the browser tab the previous test opened.
    await run(`
      const el = $('[data-point-key^="browser:"]');
      if (!el) return false;
      const key = el.getAttribute('data-point-key');
      const ta = floatingDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'point: ' + key);
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `const el = $('[data-point-key^="browser:"]');
       return !!el && el.classList.contains('agent-pointer') &&
         el.getAttribute('data-agent-pointer-note') === 'Look here';`,
      { timeoutMs: 30_000, label: "glow applied with note" },
    );
    // Interacting with the element dismisses its pointer.
    await run(`
      const el = $('[data-point-key^="browser:"].agent-pointer');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return true;
    `);
    await runWait(`return !$('[data-point-key^="browser:"].agent-pointer');`, {
      label: "glow dismissed by interaction",
    });
  });

  it("open_surface while the user is elsewhere opens in the background and lights the chip", async () => {
    // "show later:" makes the fake wait ~2.5s before calling
    // open_surface — time for the test to park the chat (Cmd+M) so the
    // user is demonstrably on another surface when the call lands.
    await runWait(`return !!floatingDock();`, { label: "chat open" });
    await run(`
      const ta = floatingDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'show later: app:bg-demo');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !floatingDock();`, { label: "chat parked" });
    // The tab is PREPARED in the background (it appears in the strip)…
    await runWait(`return !!$('[data-point-key="app:bg-demo"]');`, {
      timeoutMs: 30_000,
      label: "app tab created in the background",
    });
    // …and the tool result told the agent it was a background open.
    await runWait(
      `return timelineMessages().some((m) =>
         m.text.includes('"opened":"background"'));`,
      { timeoutMs: 30_000, label: "tool result reported the background open" },
    );
    // No focus steal: a browser tab still owns the view (hidden browser
    // panes carry .invisible — the active one must not).
    await run(`
      const bars = $$('input[aria-label="Address and search bar"]');
      if (!bars.some((el) => !el.closest('.invisible'))) {
        throw new Error('open_surface stole focus while the user was elsewhere');
      }
      return true;
    `);
    // Reopening the chat shows the chip carrying the attention dot.
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(
      `return !!floatingDock()?.querySelector(
         '[data-testid="surface-chip"][data-attention][data-kind="app"]');`,
      { label: "app chip carries the attention indicator" },
    );
    // Clicking the chip clears the attention and focuses the tab
    // (dismissal-by-interaction): every browser pane goes hidden.
    await run(`
      floatingDock()
        .querySelector('[data-testid="surface-chip"][data-attention] button')
        .click();
      return true;
    `);
    await runWait(
      `return !$('[data-testid="surface-chip"][data-attention]') &&
              $$('input[aria-label="Address and search bar"]')
                .every((el) => el.closest('.invisible'));`,
      { label: "attention cleared and the app tab focused" },
    );
  });
});

describe("subagents and background watchers", () => {
  it("a delegated subagent gets a chip whose popover lists its activity", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!floatingDock();`, { label: "chat open" });
    await run(`
      const ta = floatingDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'please use a subagent for this');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return !!floatingDock()?.querySelector(
         '[data-testid="surface-chip"][data-kind="subagent"]');`,
      { timeoutMs: 30_000, label: "subagent chip on the rail" },
    );
    // Chip survives the finished turn; clicking opens the activity popover.
    await runWait(
      `return timelineMessages().some((m) =>
         m.text.includes('nothing alarming'));`,
      { timeoutMs: 30_000, label: "turn finished" },
    );
    await run(`
      floatingDock()
        .querySelector('[data-testid="surface-chip"][data-kind="subagent"] button')
        .click();
      return true;
    `);
    await runWait(
      `const pop = floatingDock()?.querySelector(
         '[data-testid="surface-info-popover"]');
       return !!pop && pop.textContent.includes('bun test');`,
      { label: "subagent activity popover" },
    );
  });

  it("a background process gets a persistent watcher chip", async () => {
    await run(`
      const ta = floatingDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'start a watcher for the dev server');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `const chip = floatingDock()?.querySelector(
         '[data-testid="surface-chip"][data-kind="watcher"]');
       return !!chip && chip.textContent.includes('npm run dev');`,
      { timeoutMs: 30_000, label: "watcher chip on the rail" },
    );
    // Another turn later, the watcher is still there — background work
    // persists across turns until something ends it.
    await run(`
      const ta = floatingDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'thanks');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return timelineMessages().some((m) => m.text.includes('You said: thanks'));`,
      { timeoutMs: 30_000, label: "next turn finished" },
    );
    await runWait(
      `return !!floatingDock()?.querySelector(
         '[data-testid="surface-chip"][data-kind="watcher"]');`,
      { label: "watcher chip persists across turns" },
    );
  });
});
