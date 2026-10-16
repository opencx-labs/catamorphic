import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Markdown editor e2e: .md files open in the rich editor (not Monaco) inside
 * the same editor tab kind; frontmatter is preserved byte-exact and edited
 * via the Properties panel; closing the tab never crashes the renderer and
 * Cmd+Shift+T restores it; switching files within the tab keeps documents
 * isolated.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

/** DOM helpers injected into every eval — keep selectors in one place. */
const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  const visible = (selector) =>
    $$(selector).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
  const mdHandle = () => window.__catMarkdownEditor;
  // The vertical center of an element's first line of text (its first
  // non-blank character), or of its box when it has none (a rule, an
  // empty paragraph). Independent of the editor's own computation.
  // Text in a node view's own chrome (a task's checkbox label) is not a line.
  const lineCenter = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('[contenteditable="false"]')) continue;
      const at = node.textContent.search(/\\S/);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const rect = range.getClientRects()[0];
      if (rect && rect.height) return rect.top + rect.height / 2;
    }
    const box = el.getBoundingClientRect();
    return box.top + box.height / 2;
  };
  // The extension detaches the menu while it is hidden, so the suite keeps
  // the elements it found while they were in the document.
  const bubble = () => window.__mdBubble;
  // The control remains mounted (and says "Saving…") until the write
  // succeeds and clears the draft. Its label alone cannot signal completion.
  const hasUnsavedChanges = () => visible('[data-testid="editor-save"]').length > 0;
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

const mouse = (
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  point: { x: number; y: number },
  pressed = false,
) =>
  app.cdp("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    ...(type === "mouseMoved"
      ? pressed
        ? { button: "left", buttons: 1 }
        : {}
      : {
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        }),
  });

/** Where the drag handle settles, against the target's first line. */
interface HandleReading {
  handle: number;
  line: number;
}

/**
 * Wait for the drag handle to stop moving, fully shown, and read its
 * vertical center beside `target`'s first-line center.
 */
const settledHandle = (target: string, label: string) =>
  runWait<HandleReading>(
    `const handle = $('.cat-mdedit-handle');
     const rect = handle.getBoundingClientRect();
     const style = getComputedStyle(handle);
     const key = rect.top + ':' + rect.left;
     const stable = window.__mdHandleLast === key;
     window.__mdHandleLast = key;
     if (!stable || style.visibility === 'hidden' || style.opacity !== '1') return false;
     return { handle: rect.top + rect.height / 2, line: lineCenter(${target}) };`,
    { label: `handle settled on ${label}` },
  );

/**
 * Hover `target` (on its first line, shifted by `offsetY`) from outside
 * the editor, so the handle is placed afresh, and read where it settles.
 */
async function hoverHandle(
  target: string,
  label: string,
  offsetY = 0,
): Promise<HandleReading> {
  const point = await run<{ x: number; y: number }>(`
    window.__mdHandleLast = null;
    const el = ${target};
    el.scrollIntoView({ block: 'center' });
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.left + Math.min(40, box.width / 2)),
      y: Math.round(lineCenter(el) + ${offsetY}) };
  `);
  await mouse("mouseMoved", { x: 4, y: 4 });
  await mouse("mouseMoved", point);
  await mouse("mouseMoved", { x: point.x + 1, y: point.y });
  return settledHandle(target, label);
}

/** Every block type the drag handle can point at; the rule last, so the
 *  editor's trailing node adds an empty paragraph after it. */
const BLOCKS_DOC = [
  "# Heading one",
  "",
  "A paragraph long enough to wrap onto a second line in the editor column, so the handle has to find its first line and not the middle of the block. It keeps going a little longer to be sure of that.",
  "",
  "## Heading two",
  "",
  "### Heading three",
  "",
  "- Bullet item",
  "- Second bullet",
  "  - Nested bullet",
  "",
  "1. Ordered item",
  "2. Second ordered",
  "",
  "- [ ] Task item",
  "- [x] Done task",
  "",
  "> A blockquote that says something.",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "",
  "Before the rule.",
  "",
  "---",
  "",
  "After the rule.",
  "",
  "---",
  "",
].join("\n");

/** Page expressions for each block the handle should point at. */
const HANDLE_TARGETS = {
  paragraph: `$$('.ProseMirror > p').find((p) => p.textContent.startsWith('A paragraph'))`,
  "empty paragraph": `$$('.ProseMirror > p').find((p) => !p.textContent)`,
  h1: `$('.ProseMirror > h1')`,
  h2: `$('.ProseMirror > h2')`,
  h3: `$('.ProseMirror > h3')`,
  "bullet item": `$('.ProseMirror > ul:not([data-type]) > li')`,
  "ordered item": `$('.ProseMirror > ol > li')`,
  "nested item": `$('.ProseMirror > ul:not([data-type]) li li')`,
  "task item": `$('.ProseMirror > ul[data-type="taskList"] > li')`,
  blockquote: `$('.ProseMirror > blockquote')`,
  "code block": `$('.ProseMirror > pre')`,
  table: `$('.ProseMirror .tableWrapper')`,
  rule: `$('.ProseMirror > hr')`,
};

const FRONTMATTER = `name: e2e-doc\ndescription: Frontmatter that must survive byte-exact\ntags:\n  - one\n  - two`;
const DOC_BODY = `# E2E document\n\nA paragraph with **bold** text.\n\n- [ ] first task\n- [x] done task\n`;
const PLAIN_DOC = `# Plain notes\n\nJust a paragraph.\n`;

describe("markdown editor", () => {
  it("boots into a project and seeds markdown files over the file API", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false;
       setReactValue(input, 'md-e2e');
       return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = $('[data-testid="project-submit"]');
       if (!create || create.disabled) return false;
       create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
    // Seed two markdown files through the embedded server's file API.
    const seeded = await app.eval<string>(`(async () => {
      const { url } = await window.catamorphicDesktop.getServerState();
      const projects = await fetch(url + '/api/projects').then((r) => r.json());
      const project = projects.items.find((p) => p.name === 'md-e2e');
      if (!project) return 'no project';
      window.__mdE2e = { apiUrl: url, projectId: project.id };
      const put = (path, content) =>
        fetch(url + '/api/projects/' + project.id + '/files/' + encodeURIComponent(path), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        }).then((r) => r.status);
      const a = await put('with-frontmatter.md', ${JSON.stringify(
        `---\n${FRONTMATTER}\n---\n${DOC_BODY}`,
      )});
      const b = await put('plain.md', ${JSON.stringify(PLAIN_DOC)});
      return a + ',' + b;
    })()`);
    expect(seeded).toBe("200,200");
  }, 180_000);

  it("opens a .md file in the rich editor, not Monaco", async () => {
    await run(
      `$('[data-header-action="command:search-files"]').click(); return true;`,
    );
    await runWait(`return !!$('textarea[placeholder="Search filenames…"]');`, {
      label: "Files palette",
    });
    await run(
      `setReactValue($('textarea[placeholder="Search filenames…"]'), 'plain'); return true;`,
    );
    await runWait(
      `const row = byText('[role="option"]', 'plain.md');
       if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return true;`,
      { timeoutMs: 30_000, label: "plain.md in Files palette" },
    );

    await runWait(
      `return !!$('.cat-mdedit .ProseMirror') && !$('.monaco-editor')
        && $('.cat-mdedit h1')?.textContent === 'Plain notes';`,
      { timeoutMs: 60_000, label: "rich markdown editor mounted" },
    );
  }, 120_000);

  it("opening a file is not an edit (no dirty state)", async () => {
    // Give any late initialization transactions a beat to land.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const save = await run<boolean>(`return hasUnsavedChanges();`);
    expect(save).toBe(false);
  });

  it("typing marks dirty and Cmd+S round-trips to the file API", async () => {
    await run(`
      const h = mdHandle();
      h.editor.commands.focus('end');
      h.editor.commands.insertContent('Typed by e2e.');
      return true;
    `);
    await runWait(`return hasUnsavedChanges();`, {
      label: "dirty after typing",
    });
    await run(`
      $('.cat-mdedit-pane').dispatchEvent(new KeyboardEvent('keydown',
        { key: 's', metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !hasUnsavedChanges();`, {
      timeoutMs: 30_000,
      label: "saved",
    });
    const content = await app.eval<string>(`(async () => {
      const { apiUrl, projectId } = window.__mdE2e;
      const file = await fetch(apiUrl + '/api/projects/' + projectId +
        '/files/' + encodeURIComponent('plain.md')).then((r) => r.json());
      return file.content;
    })()`);
    expect(content).toContain("Typed by e2e.");
    expect(content).toContain("# Plain notes");
  }, 60_000);

  it("opening another file through the palette keeps documents isolated", async () => {
    await run(
      `$('[data-header-action="command:search-files"]').click(); return true;`,
    );
    await runWait(`return !!$('textarea[placeholder="Search filenames…"]');`, {
      label: "Files palette",
    });
    await run(
      `setReactValue($('textarea[placeholder="Search filenames…"]'), 'frontmatter'); return true;`,
    );
    await runWait(
      `const row=byText('[role="option"]', 'with-frontmatter.md'); if(!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return true;`,
      { label: "with-frontmatter.md row" },
    );
    await runWait(
      `return $('.cat-mdedit h1')?.textContent === 'E2E document';`,
      { timeoutMs: 60_000, label: "frontmatter doc open" },
    );
    const clean = await run<{ leak: boolean; save: boolean; hrs: number }>(`
      return {
        leak: $('.cat-mdedit .ProseMirror').textContent.includes('Plain notes'),
        save: hasUnsavedChanges(),
        hrs: $$('.cat-mdedit .ProseMirror > hr').length,
      };
    `);
    expect(clean.leak).toBe(false);
    expect(clean.save).toBe(false);
    expect(clean.hrs).toBe(0);
  }, 120_000);

  it("shows frontmatter in the Properties panel, body clean", async () => {
    await runWait(`return !!$('.cat-mdedit-frontmatter');`, {
      label: "properties affordance",
    });
    await run(`$('.cat-mdedit-frontmatter > button').click(); return true;`);
    const yaml = await runWait<string>(
      `const ta = $('.cat-mdedit-frontmatter textarea');
       return ta ? ta.value : false;`,
      { label: "properties textarea" },
    );
    expect(yaml).toBe(FRONTMATTER);
    // The YAML must not appear in the document body.
    const body = await run<string>(
      `return $('.cat-mdedit .ProseMirror').textContent;`,
    );
    expect(body).not.toContain("e2e-doc");
  });

  it("editing frontmatter marks dirty and survives save byte-exact", async () => {
    await run(`
      const ta = $('.cat-mdedit-frontmatter textarea');
      setReactValue(ta, ta.value + '\\nedited: true');
      return true;
    `);
    await runWait(`return hasUnsavedChanges();`, {
      label: "dirty after frontmatter edit",
    });
    await run(`
      $('.cat-mdedit-pane').dispatchEvent(new KeyboardEvent('keydown',
        { key: 's', metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !hasUnsavedChanges();`, {
      timeoutMs: 30_000,
      label: "frontmatter saved",
    });
    const content = await app.eval<string>(`(async () => {
      const { apiUrl, projectId } = window.__mdE2e;
      const file = await fetch(apiUrl + '/api/projects/' + projectId +
        '/files/' + encodeURIComponent('with-frontmatter.md')).then((r) => r.json());
      return file.content;
    })()`);
    expect(content.startsWith(`---\n${FRONTMATTER}\nedited: true\n---\n`)).toBe(
      true,
    );
    expect(content).toContain("# E2E document");
  }, 60_000);

  it("closing the tab does not crash; Cmd+Shift+T restores it", async () => {
    await run(`pressKey('w', { metaKey: true }); return true;`);
    await runWait(
      `return !$('.cat-mdedit') &&
        document.getElementById('root').childElementCount > 0;`,
      { label: "tab closed, renderer alive" },
    );
    await run(`pressKey('T', { metaKey: true, shiftKey: true }); return true;`);
    await runWait(
      `return $('.cat-mdedit h1')?.textContent === 'E2E document';`,
      { timeoutMs: 60_000, label: "tab restored with same file" },
    );
  }, 120_000);

  it("the drag handle centers on the first line of every block type", async () => {
    const status = await app.eval<number>(`(async () => {
      const { apiUrl, projectId } = window.__mdE2e;
      return fetch(apiUrl + '/api/projects/' + projectId + '/files/' +
        encodeURIComponent('blocks.md'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: ${JSON.stringify(BLOCKS_DOC)} }),
      }).then((r) => r.status);
    })()`);
    expect(status).toBe(200);
    await run(
      `$('[data-header-action="command:search-files"]').click(); return true;`,
    );
    await runWait(`return !!$('textarea[placeholder="Search filenames…"]');`, {
      label: "Files palette",
    });
    await run(
      `setReactValue($('textarea[placeholder="Search filenames…"]'), 'blocks'); return true;`,
    );
    await runWait(
      `const row = byText('[role="option"]', 'blocks.md');
       if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return true;`,
      { timeoutMs: 30_000, label: "blocks.md in Files palette" },
    );
    await runWait(
      `return $('.cat-mdedit h1')?.textContent === 'Heading one'
        && !!${HANDLE_TARGETS["empty paragraph"]};`,
      { timeoutMs: 60_000, label: "blocks document open" },
    );

    const offsets: Record<string, number> = {};
    for (const [label, target] of Object.entries(HANDLE_TARGETS)) {
      const reading = await hoverHandle(target, label);
      offsets[label] = Math.round((reading.handle - reading.line) * 10) / 10;
    }
    // Anywhere on the rule's box points at the rule, and at its line.
    for (const offsetY of [-8, 8]) {
      const reading = await hoverHandle(
        HANDLE_TARGETS.rule,
        `rule, ${offsetY}px off its line`,
        offsetY,
      );
      offsets[`rule ${offsetY}`] =
        Math.round((reading.handle - reading.line) * 10) / 10;
    }
    // Blocks whose handle sits more than 1.5px off their first line.
    const off = Object.entries(offsets).filter(
      ([, offset]) => Math.abs(offset) >= 1.5,
    );
    expect(off, JSON.stringify(offsets)).toEqual([]);

    // The rule is a comfortable target, and its line sits where the old
    // 1px rule's did between paragraphs.
    const rule = await run<{ height: number; above: number; below: number }>(`
      const hr = ${HANDLE_TARGETS.rule};
      const box = hr.getBoundingClientRect();
      const line = box.top + box.height / 2;
      return {
        height: box.height,
        above: line - hr.previousElementSibling.getBoundingClientRect().bottom,
        below: hr.nextElementSibling.getBoundingClientRect().top - line,
      };
    `);
    expect(rule.height).toBeGreaterThanOrEqual(18);
    expect(Math.abs(rule.above - 11)).toBeLessThan(0.6);
    expect(Math.abs(rule.below - 11)).toBeLessThan(0.6);
  }, 180_000);

  it("the handle re-centers when the document changes under it", async () => {
    const table = HANDLE_TARGETS.table;
    // Point at the table's last row: the table stays under the pointer as
    // the edit below moves it, whatever hover updates that brings.
    const lastRow = await run<number>(`
      const rows = ${table}.querySelectorAll('tr');
      const row = rows[rows.length - 1].getBoundingClientRect();
      return row.top + row.height / 2 - lineCenter(${table});
    `);
    await hoverHandle(table, "table, last row", lastRow);
    const top = await run<number>(
      `return $('.cat-mdedit-handle').getBoundingClientRect().top;`,
    );
    // A doc change with the handle shown takes the plugin's update path,
    // which places it again on the enclosing top-level block. The new
    // paragraph goes right above the table, on screen, so the table moves
    // whatever the scroller keeps anchored.
    await run(`
      const ed = mdHandle().editor;
      ed.state.doc.forEach((node, offset) => {
        if (node.type.name === 'table') window.__mdInsertAt = offset;
      });
      ed.commands.insertContentAt(window.__mdInsertAt, {
        type: 'paragraph', content: [{ type: 'text', text: 'Inserted above' }],
      }, { updateSelection: false });
      return true;
    `);
    await runWait(
      `return Math.abs($('.cat-mdedit-handle').getBoundingClientRect().top - ${top}) > 10;`,
      { label: "handle followed the moved table" },
    );
    const moved = await settledHandle(table, "moved table");
    expect(Math.abs(moved.handle - moved.line)).toBeLessThan(1.5);
    await run(`
      const ed = mdHandle().editor;
      const at = window.__mdInsertAt;
      ed.commands.deleteRange({ from: at, to: at + ed.state.doc.nodeAt(at).nodeSize });
      return true;
    `);
    await runWait(
      `return Math.abs($('.cat-mdedit-handle').getBoundingClientRect().top - ${top}) < 1;`,
      { label: "handle followed the table back" },
    );
    const back = await settledHandle(table, "table moved back");
    expect(Math.abs(back.handle - back.line)).toBeLessThan(1.5);
    await runWait(`return !hasUnsavedChanges();`, {
      label: "the document is unchanged again",
    });
    await mouse("mouseMoved", { x: 4, y: 4 });
  }, 60_000);

  it("the handle looks its block up once, and glides on the compositor", async () => {
    // Moves on the block the handle points at cannot change its target, so
    // the lookup (a hit test and a caret lookup, each forcing layout) runs
    // once per block, not once per frame (handle-hover.ts). Each lookup
    // makes one caretPositionFromPoint call.
    await hoverHandle(HANDLE_TARGETS.paragraph, "long paragraph");
    const box = await run<{ x: number; top: number; bottom: number }>(`
      window.__mdLookups = 0;
      window.__mdCaretLookup = document.caretPositionFromPoint;
      document.caretPositionFromPoint = (...args) => {
        window.__mdLookups++;
        return window.__mdCaretLookup.apply(document, args);
      };
      const r = ${HANDLE_TARGETS.paragraph}.getBoundingClientRect();
      return { x: Math.round(r.left + 40), top: Math.ceil(r.top + 2), bottom: Math.floor(r.bottom - 2) };
    `);
    for (let step = 0; step < 24; step++) {
      await mouse("mouseMoved", {
        x: box.x + (step % 8) * 12,
        y: box.top + ((step * 7) % Math.max(1, box.bottom - box.top)),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await run<number>(`return window.__mdLookups;`)).toBe(0);

    // The box jumps to the next block; the grip inside glides there on a
    // transform, which runs on the compositor (no left/top transition).
    // Glides are recorded as they start: a 140ms animation can begin and
    // end between two polls.
    await hoverHandle(HANDLE_TARGETS.h1, "heading one");
    await run(`
      window.__mdLookups = 0;
      window.__mdGlides = [];
      const grip = $('.cat-mdedit-handle-grip');
      const animate = grip.animate.bind(grip);
      grip.animate = (keyframes, options) => {
        window.__mdGlides.push(JSON.stringify(keyframes));
        return animate(keyframes, options);
      };
      return true;
    `);
    const next = await run<{ x: number; y: number }>(`
      const r = ${HANDLE_TARGETS.h2}.getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(lineCenter(${HANDLE_TARGETS.h2})) };
    `);
    await mouse("mouseMoved", next);
    const settledOnH2 = await settledHandle(HANDLE_TARGETS.h2, "heading two");
    expect(Math.abs(settledOnH2.handle - settledOnH2.line)).toBeLessThan(1.5);
    const glides = await run<string[]>(`return window.__mdGlides;`);
    expect(glides.length).toBeGreaterThan(0);
    expect(glides[0]).toContain("translate(");
    expect(
      await run<string>(
        `return getComputedStyle($('.cat-mdedit-handle')).transitionProperty;`,
      ),
    ).not.toMatch(/\b(top|left)\b/);
    expect(await run<number>(`return window.__mdLookups;`)).toBeGreaterThan(0);

    // Hidden and shown again elsewhere, it appears there, not gliding in
    // from where it hid.
    await mouse("mouseMoved", { x: 4, y: 4 });
    await runWait(
      `return getComputedStyle($('.cat-mdedit-handle')).visibility === 'hidden';`,
      { label: "handle hidden off the editor" },
    );
    await run(`window.__mdGlides = []; return true;`);
    const far = await hoverHandle(HANDLE_TARGETS["code block"], "code block");
    expect(Math.abs(far.handle - far.line)).toBeLessThan(1.5);
    expect(await run<string[]>(`return window.__mdGlides;`)).toEqual([]);
    await mouse("mouseMoved", { x: 4, y: 4 });
    // The later tests run on the real lookup and animation.
    await run(`
      document.caretPositionFromPoint = window.__mdCaretLookup;
      delete $('.cat-mdedit-handle-grip').animate;
      return true;
    `);
  }, 60_000);

  it("the selection bubble leaves as it came and turns around mid-exit", async () => {
    // Every state the bar enters, with the animation it starts there.
    const found = await run<boolean>(`
      window.__mdBubble = {
        anchor: $('.cat-mdedit-bubble-anchor'),
        bar: $('.cat-mdedit-bubble'),
      };
      return !!(bubble().anchor && bubble().bar);
    `);
    expect(found).toBe(true);
    await run(`
      window.__bubbleLog = [];
      const { anchor, bar } = bubble();
      new MutationObserver(() => {
        const [animation] = bar.getAnimations();
        window.__bubbleLog.push({
          state: bar.dataset.state,
          from: animation ? Number(animation.effect.getKeyframes()[0].opacity) : null,
          anchored: anchor.isConnected,
        });
      }).observe(bar, { attributes: true, attributeFilter: ['data-state'] });
      return true;
    `);
    const log = (state: string) =>
      runWait<{ from: number | null; anchored: boolean }>(
        `return window.__bubbleLog.find((entry) => entry.state === '${state}') ?? false;`,
        { label: `bubble ${state}` },
      );
    const clearLog = () => run(`window.__bubbleLog.length = 0; return true;`);
    const select = `
      const ed = mdHandle().editor;
      let from = -1;
      ed.state.doc.forEach((node, offset) => {
        if (from === -1 && node.textContent.startsWith('A paragraph')) from = offset + 1;
      });
      ed.chain().focus().setTextSelection({ from: from + 2, to: from + 20 }).run();
      return true;`;
    // At rest: shown in the document and visible, or hidden and taken out
    // of it again, as the extension leaves a hidden menu.
    const settled = (state: "shown" | "hidden") =>
      `const { anchor, bar } = bubble();
       if (bar.dataset.state !== '${state}' || bar.getAnimations().length) return false;
       return ${state === "shown"}
         ? anchor.isConnected && getComputedStyle(bar).visibility === 'visible'
         : !anchor.isConnected;`;
    const collapse = `
      const ed = mdHandle().editor;
      ed.commands.setTextSelection(ed.state.selection.from);
      const { anchor, bar } = bubble();
      const [exit] = bar.getAnimations();
      const frames = exit?.effect.getKeyframes() ?? [];
      return {
        state: bar.dataset.state,
        visibility: getComputedStyle(bar).visibility,
        inert: bar.inert,
        anchored: anchor.isConnected,
        running: exit?.playState,
        duration: exit?.effect.getTiming().duration,
        easing: exit?.effect.getTiming().easing,
        from: Number(frames[0]?.opacity),
        to: Number(frames.at(-1)?.opacity),
        toTransform: frames.at(-1)?.transform,
      };`;

    await run(select);
    await runWait(settled("shown"), { label: "bubble shown" });
    // Collapsing the selection hides the menu in the extension; the bar
    // stays, in place and inert, and plays its entrance backwards.
    const leaving = await run<Record<string, unknown>>(collapse);
    expect(leaving).toMatchObject({
      state: "leaving",
      visibility: "visible",
      inert: true,
      anchored: true,
      running: "running",
      duration: 160,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      from: 1,
      to: 0,
      toTransform: "translateY(4px) scale(0.97)",
    });
    await runWait(settled("hidden"), { label: "bubble gone after its exit" });

    // Shown again mid-exit (slowed, so the extension's 250ms settle lands
    // inside it): it turns around from where it was, never leaving its place.
    await run(select);
    await runWait(settled("shown"), { label: "bubble shown again" });
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 0.1 });
    try {
      const slowExit = await run<Record<string, unknown>>(collapse);
      expect(slowExit.state).toBe("leaving");
      await clearLog();
      await run(select);
      const turned = await log("shown");
      expect(turned.anchored).toBe(true);
      expect(turned.from).toBeGreaterThan(0);
      expect(turned.from).toBeLessThan(1);
    } finally {
      await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
    }
    await runWait(settled("shown"), { label: "bubble back in place" });

    // Drag-selecting with the mouse: the bar waits for the lift, and a
    // press elsewhere sends it out the same way.
    await run(`mdHandle().editor.commands.setTextSelection(1); return true;`);
    await runWait(settled("hidden"), { label: "bubble out before dragging" });
    const line = await run<{
      x: number;
      y: number;
      end: number;
      away: number;
    }>(`
      const p = ${HANDLE_TARGETS.paragraph};
      p.scrollIntoView({ block: 'center' });
      const box = p.getBoundingClientRect();
      return { x: Math.round(box.left + 4), y: Math.round(lineCenter(p)),
        end: Math.round(box.left + 160),
        // Below the paragraph: the bar floats above it, over the heading.
        away: Math.round(lineCenter($('.ProseMirror > h2'))) };
    `);
    await mouse("mouseMoved", { x: line.x, y: line.y });
    await mouse("mousePressed", { x: line.x, y: line.y });
    await mouse("mouseMoved", { x: line.x + 60, y: line.y }, true);
    await mouse("mouseMoved", { x: line.end, y: line.y }, true);
    // Past the extension's 250ms settle: it shows its element, the bar waits.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const held = await run<{
      state: string;
      anchored: boolean;
      empty: boolean;
    }>(`
      const { anchor, bar } = bubble();
      return { state: bar.dataset.state, anchored: anchor.isConnected,
        empty: mdHandle().editor.state.selection.empty };
    `);
    expect(held).toEqual({ state: "hidden", anchored: true, empty: false });
    await mouse("mouseReleased", { x: line.end, y: line.y });
    await runWait(settled("shown"), { label: "bubble arrives on mouse lift" });
    await clearLog();
    await mouse("mouseMoved", { x: line.x + 20, y: line.away });
    await mouse("mousePressed", { x: line.x + 20, y: line.away });
    const pressed = await log("leaving");
    expect(pressed).toMatchObject({ from: 1, anchored: true });
    await mouse("mouseReleased", { x: line.x + 20, y: line.away });
    await runWait(settled("hidden"), {
      label: "bubble left after a press away",
    });
  }, 90_000);
  it("opens a document whose first block is an image, showing it and keeping it through an edit", async () => {
    // Without an image node the parser left the image's alt text at the
    // document's top level: the editor's trailing paragraph after a list
    // then blanked the window, and a save wrote the alt text over it.
    const doc = [
      "![Work logo](assets/logo%20v2.svg)",
      "",
      "Text between, and ![Missing](assets/gone.png) one that is not there.",
      "",
      "- one",
      "- two",
      "",
    ].join("\n");
    const logo =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#4f46e5"/></svg>';
    const put = (name: string, content: string) =>
      app.eval<number>(
        `(async () => {
        const { apiUrl, projectId } = window.__mdE2e;
        return fetch(apiUrl + '/api/projects/' + projectId + '/files/' +
          encodeURIComponent(${JSON.stringify(name)}), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ${JSON.stringify(content)} }),
        }).then((r) => r.status);
      })()`,
      );
    expect(await put("assets/logo v2.svg", logo)).toBe(200);
    expect(await put("images.md", doc)).toBe(200);
    await run(
      `$('[data-header-action="command:search-files"]').click(); return true;`,
    );
    await runWait(`return !!$('textarea[placeholder="Search filenames…"]');`, {
      label: "Files palette",
    });
    await run(
      `setReactValue($('textarea[placeholder="Search filenames…"]'), 'images'); return true;`,
    );
    await runWait(
      `const row = byText('[role="option"]', 'images.md');
       if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return true;`,
      { timeoutMs: 30_000, label: "images.md in Files palette" },
    );
    // The image beside the document shows, read from the project; the
    // missing one is named.
    await runWait(
      `const image = $('.cat-mdedit .cat-mdedit-image img');
       return image?.alt === 'Work logo' && image.naturalWidth === 120 &&
         Math.round(image.getBoundingClientRect().height) === 40;`,
      { timeoutMs: 60_000, label: "image shown" },
    );
    await runWait(
      `const missing = $$('.cat-mdedit .cat-mdedit-image')[1];
       return missing?.dataset.state === 'failed' &&
         missing.textContent === 'Missing';`,
      { label: "missing image named" },
    );
    await hoverHandle(`$('.ProseMirror > p')`, "image paragraph");
    await run(`
      const h = mdHandle();
      h.editor.commands.focus('end');
      h.editor.commands.insertContent('Added.');
      return true;
    `);
    await runWait(`return hasUnsavedChanges();`, {
      label: "dirty after typing",
    });
    await run(`
      $('.cat-mdedit-pane').dispatchEvent(new KeyboardEvent('keydown',
        { key: 's', metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !hasUnsavedChanges();`, {
      timeoutMs: 30_000,
      label: "saved",
    });
    const content = await app.eval<string>(`(async () => {
      const { apiUrl, projectId } = window.__mdE2e;
      const file = await fetch(apiUrl + '/api/projects/' + projectId +
        '/files/' + encodeURIComponent('images.md')).then((r) => r.json());
      return file.content;
    })()`);
    expect(content).toContain("![Work logo](assets/logo%20v2.svg)");
    expect(content).toContain("![Missing](assets/gone.png)");
    expect(content).toContain("Added.");
    expect(app.getRendererErrors()).toEqual([]);
  }, 90_000);
});
