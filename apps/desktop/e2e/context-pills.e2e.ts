import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Context pills e2e: big pastes / URLs / paths become collapsed, deletable,
 * expandable pills in the composer (ordinary text stays a native paste);
 * Backspace in an empty composer pops the newest pill; pill-only messages
 * send; the agent receives text pills as structured context (source + text);
 * an editor selection rides into a new chat as a pill (Cmd+N), and the
 * agent can read the live selection through read_tab.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const visible = (selector) =>
    $$(selector).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  // The dock stays mounted (inert) while minimized — "front" means a live,
  // non-inert section that holds the composer.
  const frontDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('textarea[aria-label="Message the assistant"]'));
  const composer = () => frontDock()?.querySelector('textarea[aria-label="Message the assistant"]');
  const pills = () => [...(frontDock()?.querySelectorAll('[data-testid="composer-pill"]') ?? [])].map((el) => ({
    source: el.dataset.source,
    label: el.querySelector('span.font-medium')?.textContent,
    exiting: el.className.includes('pill-out'),
  }));
  const paste = (text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    composer().dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...mods }));
  const composerKey = (key, mods = {}) =>
    composer().dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...mods }));
  const timelineText = () => frontDock()?.querySelector('[role="log"]')?.textContent ?? '';
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

const BIG = Array.from(
  { length: 14 },
  (_, i) => `Pasted line ${i + 1} — lorem ipsum dolor sit amet`,
).join("\n");

describe("context pills", () => {
  it("boots into a project and opens a floating chat", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'pills-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = byText('button', 'Create');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!composer();`, { label: "floating chat" });
  }, 180_000);

  it("ordinary text pastes natively; big text, URLs and paths become pills", async () => {
    await run(`composer().focus(); return true;`);
    expect(await run<boolean>(`return paste('just a short note');`)).toBe(
      false,
    );
    expect(await run<boolean>(`return paste(${JSON.stringify(BIG)});`)).toBe(
      true,
    );
    expect(
      await run<boolean>(`return paste('https://example.com/docs/page?x=1');`),
    ).toBe(true);
    expect(await run<boolean>(`return paste('/tmp/notes/plan.md');`)).toBe(
      true,
    );
    const list = await runWait<Array<{ source: string; label: string }>>(
      `const list = pills(); return list.length === 3 ? list : false;`,
      { label: "three pills" },
    );
    expect(list.map((p) => p.source)).toEqual(["paste", "url", "path"]);
    expect(list[0]?.label).toBe("Pasted line 1 — lorem ipsum dolor sit amet");
    expect(list[1]?.label).toBe("https://example.com/docs/page?x=1");
    expect(list[2]?.label).toBe("plan.md");
  });

  it("a paste pill expands to show its text; reference pills do not", async () => {
    await run(
      `frontDock().querySelector('[data-testid="composer-pill"][data-source="paste"]').querySelector('button').click(); return true;`,
    );
    const text = await runWait<string>(
      `const well = frontDock().querySelector('[data-testid="composer-pill-text"]');
       return well && well.getBoundingClientRect().height > 20 ? well.textContent : false;`,
      { label: "expanded well" },
    );
    expect(text).toContain("Pasted line 14");
    const urlExpandable = await run<boolean>(
      `return frontDock().querySelector('[data-testid="composer-pill"][data-source="url"]')
         .querySelector('button').hasAttribute('aria-expanded');`,
    );
    expect(urlExpandable).toBe(false);
  });

  it("Backspace in an empty composer pops the newest pill with an exit animation", async () => {
    await run(`composer().focus(); composerKey('Backspace'); return true;`);
    // Mid-tween the pill is still present but exiting…
    const mid =
      await run<Array<{ source: string; exiting: boolean }>>(`return pills();`);
    expect(mid.find((p) => p.source === "path")?.exiting).toBe(true);
    // …then it is gone.
    await runWait(
      `return pills().length === 2 && pills().every((p) => !p.exiting);`,
      {
        label: "path pill removed",
      },
    );
    // The ✕ button removes too.
    await run(`frontDock().querySelector('[data-testid="composer-pill"][data-source="url"]')
      .querySelector('button[aria-label^="Remove"]').click(); return true;`);
    await runWait(`return pills().length === 1;`, {
      label: "url pill removed",
    });
  });

  it("sends a pill-only message; the agent receives structured text context", async () => {
    expect(
      await run<boolean>(
        `return !frontDock().querySelector('button[aria-label="Send message"]').disabled;`,
      ),
    ).toBe(true);
    await run(`composerKey('Enter'); return true;`);
    await runWait(`return timelineText().includes('[text-pill paste]');`, {
      timeoutMs: 30_000,
      label: "agent echoed the paste pill",
    });
    const echoed = await run<string>(`return timelineText();`);
    expect(echoed).toContain("Received 1 attachment: Pasted line 1");
    expect(echoed).toContain("[text-pill paste] Pasted line 1 — lorem ipsum");
    // The sent message renders its pill in the timeline, and the composer is clear.
    expect(
      await run<number>(
        `return visible('[data-testid="sent-text-pill"]').length;`,
      ),
    ).toBe(1);
    expect(await run<number>(`return pills().length;`)).toBe(0);
  }, 60_000);

  it("an editor selection rides into a new chat as a pill (Cmd+N)", async () => {
    // Seed a markdown file and open it in the editor.
    const seeded = await app.eval<string>(`(async () => {
      const { url } = await window.catamorphicDesktop.getServerState();
      const projects = await fetch(url + '/api/projects').then((r) => r.json());
      const project = projects.items.find((p) => p.name === 'pills-e2e');
      window.__pillsE2e = { apiUrl: url, projectId: project.id };
      return fetch(url + '/api/projects/' + project.id + '/files/' + encodeURIComponent('sel.md'), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Selection test\\n\\nFirst paragraph here.\\n\\nSecond paragraph with **bold** words.\\n' }),
      }).then((r) => r.status);
    })()`);
    expect(seeded).toBe(200);
    // Minimize the floating chat so the editor gets the front; open the editor.
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await run(`pressKey('p', { metaKey: true }); return true;`);
    await runWait(`return !!$('textarea[placeholder*="Search or ask"]');`, {
      label: "palette",
    });
    await run(
      `setReactValue($('textarea[placeholder*="Search or ask"]'), 'new editor'); return true;`,
    );
    await runWait(
      `if (!byText('button', 'New editor')) return false;
       $('textarea[placeholder*="Search or ask"]').dispatchEvent(
         new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
       return true;`,
      { label: "run New editor" },
    );
    await runWait(`return !!$('input[placeholder*="Open a file"]');`, {
      label: "quick-open",
    });
    await run(
      `setReactValue($('input[placeholder*="Open a file"]'), 'sel.md'); return true;`,
    );
    await runWait(
      `const row = byText('li button', 'sel.md'); if (!row) return false; row.click(); return true;`,
      { label: "sel.md row" },
    );
    await runWait(
      `return !!window.__catMarkdownEditor && !!$('.cat-mdedit h1');`,
      {
        timeoutMs: 60_000,
        label: "markdown editor",
      },
    );
    // Select the second paragraph programmatically, then Cmd+N.
    const selected = await run<string>(`
      const h = window.__catMarkdownEditor; const doc = h.editor.state.doc;
      let from = null, to = null, seen = 0;
      doc.forEach((node, off) => {
        if (node.type.name === 'paragraph') { seen++; if (seen === 2 && from === null) { from = off + 1; to = off + node.nodeSize - 1; } }
      });
      h.editor.commands.focus(); h.editor.commands.setTextSelection({ from, to });
      return doc.textBetween(from, to);
    `);
    expect(selected).toBe("Second paragraph with bold words.");
    await run(`pressKey('n', { metaKey: true }); return true;`);
    const pill = await runWait<{ source: string; label: string }>(
      `const list = pills(); const p = list.find((x) => x.source === 'selection'); return p ?? false;`,
      { label: "selection pill" },
    );
    expect(pill.label).toBe("sel.md · 5");
    await run(
      `frontDock().querySelector('[data-testid="composer-pill"][data-source="selection"]').querySelector('button').click(); return true;`,
    );
    const text = await runWait<string>(
      `const well = frontDock().querySelector('[data-testid="composer-pill-text"]');
       return well && well.getBoundingClientRect().height > 10 ? well.textContent : false;`,
      { label: "selection well" },
    );
    // Selection is captured as MARKDOWN, marks intact.
    expect(text).toBe("Second paragraph with **bold** words.");
  }, 180_000);

  it("Cmd+M minimize/restore does not duplicate the selection pill", async () => {
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !frontDock();`, { label: "minimized" });
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !!frontDock();`, { label: "restored" });
    const count = await run<number>(
      `return pills().filter((p) => p.source === 'selection').length;`,
    );
    expect(count).toBe(1);
  });

  it("copying out of the editor stamps the clipboard; pasting it makes a selection pill", async () => {
    // Park the chat, select the FIRST paragraph (a different text than
    // the earlier pill, so dedupe can't mask the paste), and copy.
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !frontDock();`, { label: "chat parked" });
    const stamped = await run<{
      filePath: string;
      text: string;
      startLine?: number;
    }>(`
      const h = window.__catMarkdownEditor; const doc = h.editor.state.doc;
      let from = null, to = null;
      doc.forEach((node, off) => {
        if (node.type.name === 'paragraph' && from === null) { from = off + 1; to = off + node.nodeSize - 1; }
      });
      h.editor.commands.focus(); h.editor.commands.setTextSelection({ from, to });
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      h.editor.view.dom.dispatchEvent(ev);
      window.__pillsE2eClip = dt;
      const raw = dt.getData('text/x-catamorphic-selection');
      // Collapse the selection so restoring the chat pulls nothing on its own.
      h.editor.commands.setTextSelection(from);
      return raw ? JSON.parse(raw) : null;
    `);
    expect(stamped?.filePath).toBe("sel.md");
    expect(stamped?.text).toBe("First paragraph here.");
    expect(stamped?.startLine).toBe(3);
    await run(`pressKey('m', { metaKey: true }); return true;`);
    await runWait(`return !!composer();`, { label: "chat restored" });
    const before = await run<number>(
      `return pills().filter((p) => p.source === 'selection').length;`,
    );
    const prevented = await run<boolean>(`
      composer().focus();
      const ev = new ClipboardEvent('paste', { clipboardData: window.__pillsE2eClip, bubbles: true, cancelable: true });
      composer().dispatchEvent(ev);
      return ev.defaultPrevented;
    `);
    expect(prevented).toBe(true);
    const labels = await runWait<string[]>(
      `const list = pills().filter((p) => p.source === 'selection');
       return list.length === ${before} + 1 ? list.map((p) => p.label) : false;`,
      { label: "pasted selection pill" },
    );
    expect(labels).toContain("sel.md · 3");
    // Pasting the same copy again is a no-op: one pill per selection.
    await run(`
      composer().dispatchEvent(new ClipboardEvent('paste', { clipboardData: window.__pillsE2eClip, bubbles: true, cancelable: true }));
      return true;
    `);
    const after = await run<number>(
      `return pills().filter((p) => p.source === 'selection').length;`,
    );
    expect(after).toBe(before + 1);
  });

  it("the agent receives the selection pill with file and line range", async () => {
    await run(
      `setReactValue(composer(), 'What does this say?'); composerKey('Enter'); return true;`,
    );
    await runWait(
      `return timelineText().includes('[text-pill selection sel.md:5-5]');`,
      {
        timeoutMs: 30_000,
        label: "agent echoed selection pill",
      },
    );
    const echoed = await run<string>(`return timelineText();`);
    // The reply is rendered as markdown in the timeline, so the pill's
    // **bold** shows as bold text; assert the visible sentence.
    expect(echoed).toContain(
      "[text-pill selection sel.md:5-5] Second paragraph with bold words.",
    );
  }, 60_000);

  it("the agent can read the live editor selection through read_tab", async () => {
    // Re-select in the editor (the chat took focus), keep the editor the
    // active tab, then ask the fake to read it.
    await run(`
      const h = window.__catMarkdownEditor; const doc = h.editor.state.doc;
      let from = null, to = null;
      doc.forEach((node, off) => { if (node.type.name === 'heading' && from === null) { from = off + 1; to = off + node.nodeSize - 1; } });
      h.editor.commands.focus(); h.editor.commands.setTextSelection({ from, to });
      return true;
    `);
    // The floating chat is still front; sending from it keeps the editor active.
    await run(
      `setReactValue(composer(), 'please read the editor'); composerKey('Enter'); return true;`,
    );
    await runWait(`return timelineText().includes('[editor sel.md:1-1]');`, {
      timeoutMs: 30_000,
      label: "agent read the editor selection",
    });
    const echoed = await run<string>(`return timelineText();`);
    // Markdown-rendered reply: the "# " renders as a heading, the text stays.
    expect(echoed).toContain("[editor sel.md:1-1]");
    expect(echoed).toContain("Selection test");
  }, 60_000);
});
