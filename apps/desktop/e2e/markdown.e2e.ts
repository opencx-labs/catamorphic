import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

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
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...mods }));
  const mdHandle = () => window.__catMarkdownEditor;
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

const FRONTMATTER = `name: e2e-doc\ndescription: Frontmatter that must survive byte-exact\ntags:\n  - one\n  - two`;
const DOC_BODY = `# E2E document\n\nA paragraph with **bold** text.\n\n- [ ] first task\n- [x] done task\n`;
const PLAIN_DOC = `# Plain notes\n\nJust a paragraph.\n`;

describe("markdown editor", () => {
  it("boots into a project and seeds markdown files over the file API", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false;
       setReactValue(input, 'md-e2e');
       return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = byText('button', 'Create');
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
    await run(`pressKey('p', { metaKey: true }); return true;`);
    await runWait(`return !!$('textarea[placeholder*="Search or ask"]');`, {
      label: "palette overlay",
    });
    await run(`
      setReactValue($('textarea[placeholder*="Search or ask"]'), 'new editor');
      return true;
    `);
    await runWait(
      `if (!byText('button', 'New editor')) return false;
       $('textarea[placeholder*="Search or ask"]').dispatchEvent(
         new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
       return true;`,
      { label: "run New editor action" },
    );
    await runWait(`return !!$('input[placeholder*="Open a file"]');`, {
      label: "quick-open",
    });
    await run(
      `setReactValue($('input[placeholder*="Open a file"]'), 'plain'); return true;`,
    );
    await runWait(
      `const row = byText('li button', 'plain.md');
       if (!row) return false; row.click(); return true;`,
      { label: "plain.md row" },
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
    const save = await run<boolean>(
      `return visible('button').some((b) => b.textContent === 'Save');`,
    );
    expect(save).toBe(false);
  });

  it("typing marks dirty and Cmd+S round-trips to the file API", async () => {
    await run(`
      const h = mdHandle();
      h.editor.commands.focus('end');
      h.editor.commands.insertContent('Typed by e2e.');
      return true;
    `);
    await runWait(
      `return visible('button').some((b) => b.textContent === 'Save');`,
      { label: "dirty after typing" },
    );
    await run(`
      $('.cat-mdedit-pane').dispatchEvent(new KeyboardEvent('keydown',
        { key: 's', metaKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return !visible('button').some((b) => b.textContent === 'Save');`,
      { timeoutMs: 30_000, label: "saved" },
    );
    const content = await app.eval<string>(`(async () => {
      const { apiUrl, projectId } = window.__mdE2e;
      const file = await fetch(apiUrl + '/api/projects/' + projectId +
        '/files/' + encodeURIComponent('plain.md')).then((r) => r.json());
      return file.content;
    })()`);
    expect(content).toContain("Typed by e2e.");
    expect(content).toContain("# Plain notes");
  }, 60_000);

  it("switching files within the tab keeps documents isolated", async () => {
    // The pane-header path button (with the Search glyph), NOT the
    // workspace tab, which also carries the filename in a truncate span.
    await run(`
      visible('button').find((b) =>
        b.querySelector('svg.lucide-search') &&
        b.querySelector('span.truncate')?.textContent?.includes('plain.md')).click();
      return true;
    `);
    await runWait(`return !!$('input[placeholder*="Open a file"]');`, {
      label: "quick-open again",
    });
    await run(
      `setReactValue($('input[placeholder*="Open a file"]'), 'frontmatter'); return true;`,
    );
    await runWait(
      `const row = byText('li button', 'with-frontmatter.md');
       if (!row) return false; row.click(); return true;`,
      { label: "with-frontmatter.md row" },
    );
    await runWait(
      `return $('.cat-mdedit h1')?.textContent === 'E2E document';`,
      { timeoutMs: 60_000, label: "frontmatter doc open" },
    );
    const clean = await run<{ leak: boolean; save: boolean; hrs: number }>(`
      return {
        leak: $('.cat-mdedit .ProseMirror').textContent.includes('Plain notes'),
        save: visible('button').some((b) => b.textContent === 'Save'),
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
    await runWait(
      `return visible('button').some((b) => b.textContent === 'Save');`,
      { label: "dirty after frontmatter edit" },
    );
    await run(`
      $('.cat-mdedit-pane').dispatchEvent(new KeyboardEvent('keydown',
        { key: 's', metaKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return !visible('button').some((b) => b.textContent === 'Save');`,
      { timeoutMs: 30_000, label: "frontmatter saved" },
    );
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
});
