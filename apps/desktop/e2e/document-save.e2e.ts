import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createProjectWorkspace,
  launchApp,
  removeE2eDirectory,
} from "./harness.js";

it("flushes Markdown on tab close and immediately on app Quit", async () => {
  const app = await launchApp();
  let stopped = false;
  const root = path.join(app.userDataDir, "document-save");
  const file = path.join(root, "notes.md");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, "# Saved document\n");
  try {
    const project = await createProjectWorkspace({
      app,
      name: "Document saves",
      rootPath: root,
      importExisting: true,
    });
    const open = async (mode: "tab" | "floating" = "tab") => {
      await app.eval(
        `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({
          projectId: project.id,
          surface: {
            url: "file:notes.md",
            title: "Notes",
            mode,
            nonce: crypto.randomUUID(),
          },
        })})`,
      );
      await app.waitFor(
        `!!document.querySelector('[data-workspace-visible="true"] .cat-mdedit .ProseMirror')`,
        { label: "Markdown open" },
      );
    };
    await open();
    // Edit and close in one renderer turn, before a debounce can expire.
    await app.eval(
      `(() => { const h = window.__catMarkdownEditor; h.editor.commands.focus('end'); h.editor.commands.insertContent(' Saved by close.'); window.dispatchEvent(new KeyboardEvent('keydown', {key:'w', metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true})); return true; })()`,
    );
    await app.waitFor(
      `!document.querySelector('[data-workspace-visible="true"] .cat-mdedit .ProseMirror')`,
      { label: "tab closed after saving" },
    );
    expect(fs.readFileSync(file, "utf8")).toContain("Saved by close.");
    await open("floating");
    const inertWhileClosing =
      await app.eval<boolean>(`new Promise((resolve, reject) => {
      const h = window.__catMarkdownEditor;
      h.editor.commands.focus('end'); h.editor.commands.insertContent(' Saved by floating close.');
      const started = performance.now();
      const sample = () => {
        const pane = document.querySelector('[data-floating-state="closing"]');
        if (pane) { resolve(pane.inert); return; }
        if (performance.now() - started > 3000) { reject(new Error('Floating exit did not start')); return; }
        requestAnimationFrame(sample);
      };
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'w',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));
      requestAnimationFrame(sample);
    })`);
    expect(inertWhileClosing).toBe(true);
    await app.insertText("late exit typing");
    // Chromium clears focus after processing inertness; macOS can do that
    // after the first animation-frame callback. Late input must still be blocked.
    await app.waitFor(
      `!document.querySelector('[data-floating-state="closing"]')?.contains(document.activeElement)`,
      { label: "closing document releases keyboard focus" },
    );
    await app.waitFor(
      `!document.querySelector('[data-workspace-visible="true"] [data-floating-surface]')`,
      { label: "floating document closed" },
    );
    expect(fs.readFileSync(file, "utf8")).toContain("Saved by floating close.");
    expect(fs.readFileSync(file, "utf8")).not.toContain("late exit typing");
    await open();
    await app.eval(
      `(() => { const h = window.__catMarkdownEditor; h.editor.commands.focus('end'); h.editor.commands.insertContent(' Saved by Quit.'); return true; })()`,
    );
    await app.stop({ preserveUserData: true, captureFinalFrame: false });
    stopped = true;
    expect(fs.readFileSync(file, "utf8")).toContain("Saved by Quit.");
    expect(app.getRendererErrors()).toEqual([]);
  } finally {
    if (!stopped) await app.stop({ preserveUserData: true });
    await removeE2eDirectory(app.userDataDir);
  }
});
