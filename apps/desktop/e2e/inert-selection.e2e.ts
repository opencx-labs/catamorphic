import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Selection workload', rootPath: ${JSON.stringify(`${app.userDataDir}/selection-workload`)}
  })`);
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
});
afterEach(async () => {
  await app.eval(
    "getSelection().removeAllRanges(); document.getElementById('selection-workload')?.remove()",
  );
});
afterAll(async () => app?.stop());

it.each([false, true])(
  "releases hidden selections across a nested inert region and restores their direction (backward: %s)",
  async (backward) => {
    await app.eval(`(() => {
      const workspace = document.createElement('section'); workspace.id = 'selection-workload';
      workspace.style.cssText = 'position:fixed;inset:100px 100px auto;width:600px;height:300px;overflow:auto;content-visibility:hidden;user-select:text';
      const folded = document.createElement('div'); folded.id = 'selection-folded';
      folded.inert = true;
      const rows = document.createDocumentFragment();
      for (let i = 0; i < 6000; i++) {
        const row = document.createElement('p');
        row.textContent = 'Retained work with enough text to exercise caret candidate traversal.';
        rows.append(row);
      }
      folded.append(rows);
      const reply = document.createElement('p'); reply.id = 'selection-reply'; reply.textContent = 'Another reply';
      workspace.append(...(${backward} ? [reply, folded] : [folded, reply]));
      workspace.inert = true;
      document.body.append(workspace);
    })()`);
    // A separate task, after both inert attributes have settled: their
    // MutationObserver records must not clear this for selectionchange.
    await app.eval(`getSelection().setBaseAndExtent(
      document.getElementById('selection-folded').firstChild.firstChild, 3,
      document.getElementById('selection-reply').firstChild, 5
    )`);
    await app.waitFor("getSelection().rangeCount === 0", {
      label: "the common inert ancestor releases both endpoints",
    });
    await app.eval("document.getElementById('selection-folded').inert = false");
    expect(await app.eval("getSelection().rangeCount")).toBe(0);
    await app.eval(`(() => {
      const workspace = document.getElementById('selection-workload');
      workspace.inert = false; workspace.style.contentVisibility = 'visible';
    })()`);
    await app.waitFor("getSelection().rangeCount === 1", {
      label: "the visible highlight returns",
    });
    expect(
      await app.eval(`(() => {
        const selection = getSelection();
        return {
          anchor: selection.anchorNode === document.getElementById('selection-folded').firstChild.firstChild,
          focus: selection.focusNode === document.getElementById('selection-reply').firstChild,
          anchorOffset: selection.anchorOffset,
          focusOffset: selection.focusOffset,
          direction: selection.direction,
        };
      })()`),
    ).toEqual({
      anchor: true,
      focus: true,
      anchorOffset: 3,
      focusOffset: 5,
      direction: backward ? "backward" : "forward",
    });
    expect(app.getRendererErrors()).toEqual([]);
  },
);

async function selectPlainCaret(editor = false, highlight = false, offset = 2) {
  await app.eval(`(() => {
    const workspace = document.createElement('section'); workspace.id = 'selection-workload';
    workspace.style.cssText = 'position:fixed;left:100px;top:100px;width:600px;height:300px;user-select:text';
    const reply = document.createElement('p'); reply.id = 'selection-transient'; reply.textContent = 'A transient reply';
    if (${editor}) { reply.contentEditable = 'true'; reply.tabIndex = 0; }
    const retained = document.createElement('section'); retained.inert = true;
    retained.style.cssText = 'content-visibility:hidden;visibility:hidden';
    const rows = document.createDocumentFragment();
    for (let i = 0; i < 6000; i++) {
      const row = document.createElement('p'); row.textContent = 'Retained text behind the disappearing reply.'; rows.append(row);
    }
    retained.append(rows);
    const elsewhere = document.createElement('p'); elsewhere.id = 'selection-elsewhere'; elsewhere.textContent = 'Another visible reply';
    workspace.append(reply, retained, elsewhere); document.body.append(workspace);
    window.__plainSelectionObserved = false;
    document.addEventListener('selectionchange', () => { window.__plainSelectionObserved = true; }, { once: true });
    getSelection().setBaseAndExtent(reply.firstChild, ${offset}, reply.firstChild, ${highlight ? 5 : offset});
  })()`);
  // The guard must see the original caret before its content disappears.
  // This waits for Chromium's actual event, not a synthetic dispatch.
  await app.waitFor("window.__plainSelectionObserved === true");
}

it.each(["removed", "emptied", "extended then removed"])(
  "discards a plain caret before retained inert content when its text is %s",
  async (mode) => {
    await selectPlainCaret();
    await app.eval(`(() => {
      const reply = document.getElementById('selection-transient');
      ${
        mode === "removed"
          ? "reply.remove();"
          : mode === "emptied"
            ? "reply.firstChild.data = '';"
            : "reply.firstChild.after(document.createTextNode('extra')); reply.remove();"
      }
    })()`);
    await app.waitFor("getSelection().rangeCount === 0", {
      label: "the disappeared plain caret is discarded",
    });
    expect(app.getRendererErrors()).toEqual([]);
  },
);

it("keeps an editor caret usable when its text disappears", async () => {
  await selectPlainCaret(true);
  await app.eval(
    "document.getElementById('selection-transient').replaceChildren()",
  );
  expect(
    await app.eval(`(() => {
      const editor = document.getElementById('selection-transient');
      return { focused: document.activeElement === editor, caret: getSelection().anchorNode === editor, ranges: getSelection().rangeCount };
    })()`),
  ).toEqual({ focused: true, caret: true, ranges: 1 });
  await app.insertText("Typing continues");
  expect(
    await app.eval(
      "document.getElementById('selection-transient').textContent",
    ),
  ).toBe("Typing continues");
});

it("keeps the browser's adjusted range when highlighted text disappears", async () => {
  await selectPlainCaret(false, true);
  await app.eval("document.getElementById('selection-transient').remove()");
  expect(await app.eval("getSelection().rangeCount")).toBe(1);
});

it.each(["moved", "elsewhere"])(
  "keeps the selection when content %s replaces the removal case",
  async (mode) => {
    await selectPlainCaret();
    await app.eval(`(() => {
      const reply = document.getElementById('selection-transient');
      const elsewhere = document.getElementById('selection-elsewhere');
      ${
        mode === "moved"
          ? "elsewhere.after(reply);"
          : "reply.remove(); getSelection().collapse(elsewhere.firstChild, 3);"
      }
    })()`);
    expect(await app.eval("getSelection().rangeCount")).toBe(1);
    if (mode === "elsewhere") {
      expect(
        await app.eval(
          "getSelection().anchorNode === document.getElementById('selection-elsewhere').firstChild && getSelection().anchorOffset === 3",
        ),
      ).toBe(true);
    }
  },
);

// Chromium keeps a normalized caret in surviving text; jsdom instead
// moves it to the parent boundary, so normalization needs the native check.
it.each([
  { mode: "split", offset: 0 },
  { mode: "split", offset: 2 },
  { mode: "merged", offset: 0 },
  { mode: "merged", offset: 2 },
])(
  "keeps a caret at $offset in surviving text when its nodes are $mode",
  async ({ mode, offset }) => {
    await selectPlainCaret(false, false, offset);
    if (mode === "split") {
      await app.eval(
        "document.getElementById('selection-transient').firstChild.splitText(0)",
      );
    } else {
      await app.eval(`(() => {
        const reply = document.getElementById('selection-transient');
        reply.prepend(document.createTextNode('Earlier '));
        reply.normalize();
      })()`);
    }
    expect(
      await app.eval(`(() => {
        const selected = getSelection();
        return { ranges: selected.rangeCount, text: selected.anchorNode?.nodeValue, offset: selected.anchorOffset };
      })()`),
    ).toEqual({
      ranges: 1,
      text:
        mode === "split"
          ? offset === 0
            ? ""
            : "A transient reply"
          : "Earlier A transient reply",
      offset: mode === "split" ? offset : offset + 8,
    });
  },
);
