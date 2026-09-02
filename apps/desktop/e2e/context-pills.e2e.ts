import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Context pills e2e: the composer is a contenteditable with INLINE pills.
 * Big pastes / URLs / paths / images / dropped tabs become pills at the
 * caret (ordinary text pastes as plain text); pills preview on hover,
 * leave with an exit animation on ✕ or Backspace, and come back with ⌘Z;
 * the message ships prose with one marker per pill and the agent receives
 * the pills as structured context (source + text); the sent message renders
 * its pills inline; an editor selection rides into a new chat as a pill
 * (Cmd+N), and the agent can read the live selection through read_tab.
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
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  const composer = () => frontDock()?.querySelector('[data-composer-input]');
  const pills = () => [...(frontDock()?.querySelectorAll('[data-testid="composer-pill"]') ?? [])].map((el) => ({
    source: el.dataset.pillKind,
    label: el.querySelector('span.truncate')?.textContent,
    exiting: el.className.includes('pill-out'),
  }));
  // Prose + pill labels in document order — what the composer "says".
  const composerText = () => composer()?.textContent ?? '';
  const caretToEnd = () => {
    const el = composer(); el.focus();
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  };
  const typeText = (text) => { caretToEnd(); document.execCommand('insertText', false, text); };
  // React derives onMouseEnter/Leave from over/out pairs, so hover is a
  // bubbling mouseover from outside and unhover a mouseout to the body.
  const hover = (el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  const unhover = (el) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  const paste = (text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    composer().dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const settleFrames = () => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
  ${setReactValueJs}
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
    // Layout guard: the input fills the row (a broken frame wrapper once
    // collapsed it to 20px while every behavioral test still passed).
    const widths = await run<{ input: number; form: number }>(`
      const c = composer();
      return {
        input: c.getBoundingClientRect().width,
        form: c.closest('form').getBoundingClientRect().width,
      };
    `);
    expect(widths.input).toBeGreaterThan(widths.form * 0.6);
  }, 180_000);

  it("short text pastes as plain text at the caret; big text, URLs and paths become inline pills", async () => {
    // Start this stateful test at its declared boundary so it does not inherit
    // a draft or pills from the preceding layout check.
    await run(`
      const c = composer();
      c.replaceChildren();
      c.dispatchEvent(new InputEvent('input', { bubbles: true }));
      c.focus();
      return true;
    `);
    await runWait(`return pills().length === 0 && composerText() === '';`, {
      label: "clean composer boundary",
    });
    // Every paste aimed at the composer is ours (rich clipboards land as
    // plain text), so defaultPrevented is always true; the difference is
    // what lands: text or a pill.
    expect(await run<boolean>(`return paste('just a short note ');`)).toBe(
      true,
    );
    expect(await run<number>(`return pills().length;`)).toBe(0);
    expect(await run<string>(`return composerText();`)).toBe(
      "just a short note ",
    );
    // Let any autofocus frame queued while the dock opened run. The paste
    // is now authoritative interaction, so that stale frame must not move
    // the caret back to offset zero before the next paste.
    await run<boolean>(`return settleFrames();`);
    expect(await run<boolean>(`return paste(${JSON.stringify(BIG)});`)).toBe(
      true,
    );
    await runWait(
      `return pills().length === 1 && composerText() ===
        'just a short note Pasted line 1 — lorem ipsum dolor sit amet ';`,
      { label: "large paste inserted at the current caret" },
    );
    await run(`typeText('and '); return true;`);
    await runWait(
      `return composerText().endsWith('lorem ipsum dolor sit amet and ');`,
      { label: "text after large paste" },
    );
    expect(
      await run<boolean>(`return paste('https://example.com/docs/page?x=1');`),
    ).toBe(true);
    await runWait(
      `return pills().length === 2 &&
        composerText().endsWith('https://example.com/docs/page?x=1 ');`,
      { label: "URL pill inserted" },
    );
    await run(`typeText('and '); return true;`);
    await runWait(
      `return composerText().endsWith('example.com/docs/page?x=1 and ');`,
      { label: "text after URL pill" },
    );
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
    // Pills sit inline, in the order they were placed, each followed by
    // the breathing space that lets typing continue after the token.
    expect(await run<string>(`return composerText();`)).toBe(
      "just a short note Pasted line 1 — lorem ipsum dolor sit amet and https://example.com/docs/page?x=1 and plan.md ",
    );
  });

  it("hovering a pill previews its content; reference pills show the reference", async () => {
    await run(
      `hover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="paste"]')); return true;`,
    );
    const text = await runWait<string>(
      `const well = $('[data-testid="pill-preview"][data-open="true"] [data-testid="pill-preview-text"]');
       return well && well.getBoundingClientRect().height > 20 ? well.textContent : false;`,
      { label: "paste preview" },
    );
    expect(text).toContain("Pasted line 14");
    await run(
      `unhover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="paste"]')); return true;`,
    );
    await runWait(
      `return !$('[data-testid="pill-preview"][data-open="true"]');`,
      {
        label: "preview closed",
      },
    );
    await run(
      `hover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="url"]')); return true;`,
    );
    const ref = await runWait<string>(
      `const pop = $('[data-testid="pill-preview"][data-open="true"]'); return pop ? pop.textContent : false;`,
      { label: "url preview" },
    );
    expect(ref).toContain("https://example.com/docs/page?x=1");
    expect(ref).toContain("Link");
    await run(
      `unhover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="url"]')); return true;`,
    );
    await runWait(
      `return !$('[data-testid="pill-preview"][data-open="true"]');`,
      {
        label: "preview closed again",
      },
    );
  });

  it("Backspace against a pill pops it with an exit animation; ⌘Z brings it back; ✕ removes too", async () => {
    // Caret at the very end: after "plan.md" + its space. First Backspace
    // eats the space natively (a real key, so Chromium edits); the next
    // one meets the pill and the composer takes over.
    await run(`caretToEnd(); return true;`);
    await app.press("Backspace");
    await app.press("Backspace");
    // Mid-tween the pill is still present but exiting…
    const mid =
      await run<Array<{ source: string; exiting: boolean }>>(`return pills();`);
    expect(mid.find((p) => p.source === "path")?.exiting).toBe(true);
    // …then it is gone, and the prose reads without a hole.
    await runWait(
      `return pills().length === 2 && pills().every((p) => !p.exiting);`,
      { label: "path pill removed" },
    );
    expect(await run<string>(`return composerText();`)).toMatch(/and $/);
    // Removal went through the editing stack: undo revives the pill.
    await run(`document.execCommand('undo'); return true;`);
    await runWait(
      `return pills().length === 3 && pills()[2].source === 'path';`,
      { label: "undo revived the pill" },
    );
    // The ✕ button removes too.
    await run(`frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="path"]')
      .querySelector('button[aria-label^="Remove"]').click(); return true;`);
    await runWait(`return pills().length === 2;`, {
      label: "path pill removed via ✕",
    });
    // Backspace with no prose left pops the newest pill wherever the
    // caret sits (the palette's chip-pop).
    await run(`setReactValue(composer(), ''); return true;`);
    await run(`composer().focus(); composerKey('Backspace'); return true;`);
    await runWait(`return pills().length === 1;`, {
      label: "url pill removed via chip-pop",
    });
    await run(`composerKey('Backspace'); return true;`);
    await runWait(`return pills().length === 0;`, {
      label: "paste pill removed via chip-pop",
    });
  });

  it("an image pastes as an inline pill with a thumbnail and preview", async () => {
    await run(`
      caretToEnd();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
      composer().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return !!frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="image"] img');`,
      { label: "image pill" },
    );
    await run(
      `hover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="image"]')); return true;`,
    );
    await runWait(
      `const pop = $('[data-testid="pill-preview"][data-open="true"]'); return !!pop && !!pop.querySelector('img') && pop.textContent.includes('dot.png');`,
      { label: "image preview" },
    );
    await run(
      `unhover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="image"]')); return true;`,
    );
    await runWait(
      `return !$('[data-testid="pill-preview"][data-open="true"]');`,
      {
        label: "image preview closed",
      },
    );
  });

  it("a workspace tab dropped on the chat becomes a tab pill", async () => {
    await run(`
      typeText('summarize ');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'browser:e2e');
      dt.setData('application/x-catamorphic-tab', JSON.stringify({ key: 'browser:e2e', kind: 'browser', title: 'Example Domain', detail: 'https://example.com/' }));
      const rect = composer().getBoundingClientRect();
      const ev = (type) => new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.right - 30, clientY: rect.top + 12 });
      frontDock().dispatchEvent(ev('dragenter'));
      frontDock().dispatchEvent(ev('dragover'));
      composer().dispatchEvent(ev('drop'));
      return true;
    `);
    const tab = await runWait<{ label: string }>(
      `const p = pills().find((x) => x.source === 'tab'); return p ?? false;`,
      { label: "tab pill" },
    );
    expect(tab.label).toBe("Example Domain");
  });

  it("sends prose with inline pills; the agent receives structured context; the timeline renders pills inline", async () => {
    expect(
      await run<boolean>(
        `return !frontDock().querySelector('button[aria-label="Send message"]').disabled;`,
      ),
    ).toBe(true);
    await run(`composerKey('Enter'); return true;`);
    await runWait(`return timelineText().includes('[text-pill tab]');`, {
      timeoutMs: 30_000,
      label: "agent echoed the pills",
    });
    const echoed = await run<string>(`return timelineText();`);
    expect(echoed).toContain("Received 2 attachments: dot.png, Example Domain");
    expect(echoed).toContain(
      "[text-pill tab] Example Domain — https://example.com/",
    );
    // The model-facing prose carries numbered inline references (the fake
    // echoes the message it got).
    expect(echoed).toContain("[attachment 1: dot.png]");
    expect(echoed).toContain("[attachment 2: Example Domain]");
    // The sent message renders its pills inline, in place, and the
    // composer is clear.
    const sent = await run<{ kinds: string[]; text: string }>(`
      const msg = $$('[data-user-message]').at(-1);
      return {
        kinds: [...msg.querySelectorAll('[data-testid="sent-pill"]')].map((el) => el.dataset.pillKind),
        text: msg.textContent,
      };
    `);
    expect(sent.kinds).toEqual(["image", "tab"]);
    expect(sent.text).toContain("dot.png");
    expect(sent.text).toContain("summarize");
    expect(sent.text).toContain("Example Domain");
    expect(await run<number>(`return pills().length;`)).toBe(0);
    expect(
      await run<boolean>(`return composer().hasAttribute('data-empty');`),
    ).toBe(true);
    // ↑ recalls the prose with the pills named in place.
    await run(`composer().focus(); composerKey('ArrowUp'); return true;`);
    const recalled = await runWait<string>(
      `const t = composerText(); return t.includes('[dot.png]') ? t : false;`,
      { label: "recall names pills" },
    );
    expect(recalled).toContain("[Example Domain]");
    expect(recalled).toContain("summarize");
    await run(`composerKey('ArrowDown'); return true;`);
    await runWait(`return composer().hasAttribute('data-empty');`, {
      label: "recall restored the empty draft",
    });
    // Sent pills preview on hover too — same popover as the composer's.
    await run(`
      hover($$('[data-user-message] [data-testid="sent-pill"][data-pill-kind="tab"]').at(-1));
      return true;
    `);
    await runWait(
      `const pop = $('[data-testid="pill-preview"][data-open="true"]');
       return !!pop && pop.textContent.includes('https://example.com/');`,
      { label: "sent tab pill preview" },
    );
    await run(`
      unhover($$('[data-user-message] [data-testid="sent-pill"][data-pill-kind="tab"]').at(-1));
      return true;
    `);
    // Closing puts the preview into its real exit-transition state. Hidden
    // Chromium may pause that transition, so semantic closure cannot depend
    // on transitionend eventually unmounting the portal.
    await runWait(
      `const pop = $$('[data-testid="pill-preview"]')
         .find((el) => el.textContent.includes('https://example.com/'));
       return !!pop && pop.getAttribute('aria-hidden') === 'true' &&
         pop.classList.contains('opacity-0');`,
      { label: "preview fading out" },
    );
  }, 60_000);

  it("growth animates: the frame around the editable tweens to its height", async () => {
    const result = await run<{
      transition: string;
      before: string;
      after: string;
    }>(`
      const frame = composer().parentElement;
      const before = frame.style.height;
      caretToEnd();
      document.execCommand('insertLineBreak');
      document.execCommand('insertText', false, 'second line');
      return { transition: getComputedStyle(frame).transitionProperty, before, after: 'pending' };
    `);
    expect(result.transition).toContain("height");
    // The editable snapped to two lines; the frame follows with a tween.
    await runWait(
      `const frame = composer().parentElement;
       return parseInt(frame.style.height) === composer().offsetHeight;`,
      { label: "frame settled on the new height" },
    );
    await run(`
      caretToEnd();
      document.execCommand('delete');
      for (let i = 0; i < 12; i++) document.execCommand('delete');
      return true;
    `);
    await runWait(
      `return parseInt(composer().parentElement.style.height) === composer().offsetHeight;`,
      { label: "frame settled back" },
    );
  });

  it("select-all + delete leaves the caret at the start (placeholder takes no inline space)", async () => {
    await run(`
      composer().focus();
      const range = document.createRange();
      range.selectNodeContents(composer());
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('delete');
      return true;
    `);
    const caret = await runWait<{ x: number; y: number; empty: boolean }>(`
      const c = composer();
      if (!c.hasAttribute('data-empty')) return false;
      const probe = document.createElement('span');
      getSelection().getRangeAt(0).insertNode(probe);
      const rect = c.getBoundingClientRect();
      const pos = probe.getBoundingClientRect();
      probe.remove();
      return { x: Math.round(pos.left - rect.left), y: Math.round(pos.top - rect.top), empty: true };
    `);
    // Padding is 10px/6px: the caret sits at the input's start, not after
    // the placeholder text.
    expect(caret.x).toBeLessThanOrEqual(12);
    expect(caret.y).toBeLessThanOrEqual(10);
    expect(
      await run<string>(
        `return getComputedStyle(composer(), '::before').position;`,
      ),
    ).toBe("absolute");
  });

  it("unsupported and oversized files fall back to path pills; pathless ones drop quietly", async () => {
    await run(`
      window.__e2ePathForFile = (file) => file.name === 'trace.pcap' ? '/tmp/captures/trace.pcap' : '';
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([212,195,178,161])], 'trace.pcap', { type: 'application/vnd.tcpdump.pcap' }));
      composer().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    `);
    const withPath = await runWait<{ label: string }>(
      `const p = pills().find((x) => x.source === 'path'); return p ?? false;`,
      { label: "pcap path pill" },
    );
    expect(withPath.label).toBe("trace.pcap");
    // A pathless unsupported file (synthetic clipboard payload) is dropped
    // without touching the composer.
    const before = await run<number>(`return pills().length;`);
    await run(`
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], 'mystery.bin', { type: 'application/octet-stream' }));
      composer().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    `);
    await run(`return true;`);
    expect(await run<number>(`return pills().length;`)).toBe(before);
    await run(`
      delete window.__e2ePathForFile;
      frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="path"] button[aria-label^="Remove"]').click();
      return true;
    `);
    await runWait(`return pills().every((p) => p.source !== 'path');`, {
      label: "path pill cleaned up",
    });
  });

  it("a multi-megabyte image survives the round trip (server body limit)", async () => {
    await run(`
      caretToEnd();
      const big = new Uint8Array(3 * 1024 * 1024);
      big.set([137,80,78,71,13,10,26,10]);
      const dt = new DataTransfer();
      dt.items.add(new File([big], 'big-shot.png', { type: 'image/png' }));
      composer().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return pills().some((p) => p.source === 'image');`, {
      label: "big image pill",
      timeoutMs: 30_000,
    });
    await run(`composerKey('Enter'); return true;`);
    await runWait(
      `return timelineText().includes('Received 1 attachment: big-shot.png');`,
      { timeoutMs: 30_000, label: "3MB attachment answered, not rejected" },
    );
    expect(
      await run<boolean>(`return timelineText().includes('too large');`),
    ).toBe(false);
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
      `hover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="selection"]')); return true;`,
    );
    const text = await runWait<string>(
      `const well = $('[data-testid="pill-preview"][data-open="true"] [data-testid="pill-preview-text"]');
       return well && well.getBoundingClientRect().height > 10 ? well.textContent : false;`,
      { label: "selection preview" },
    );
    // Selection is captured as MARKDOWN, marks intact.
    expect(text).toBe("Second paragraph with **bold** words.");
    await run(
      `unhover(frontDock().querySelector('[data-testid="composer-pill"][data-pill-kind="selection"]')); return true;`,
    );
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
