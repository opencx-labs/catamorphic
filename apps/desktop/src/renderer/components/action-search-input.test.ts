// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { activateSearch, findSearchTarget } from "./action-search-input.js";

beforeAll(() => {
  // jsdom lays nothing out: everything counts as on screen.
  Element.prototype.checkVisibility ??= () => true;
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("findSearchTarget", () => {
  it("finds a search button in the content in front", () => {
    document.body.innerHTML = `
      <aside><input aria-label="Search files" /></aside>
      <div class="workspace-content">
        <button aria-label="Search settings" data-search-trigger></button>
      </div>`;
    let opened = false;
    document.querySelector("button")?.addEventListener("click", () => {
      opened = true;
    });
    const target = findSearchTarget();
    expect(target?.getAttribute("aria-label")).toBe("Search settings");
    if (target) activateSearch(target);
    expect(opened).toBe(true);
  });

  it("prefers a search field to a button, and a field marked for Find to both", () => {
    document.body.innerHTML = `
      <div class="workspace-content">
        <button aria-label="Search settings"></button>
        <input type="search" id="field" />
      </div>`;
    expect(findSearchTarget()?.id).toBe("field");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="workspace-content"><input data-search-action="find" id="marked" /></div>',
    );
    expect(findSearchTarget()?.id).toBe("marked");
  });

  it("leaves Find alone where nothing can be searched", () => {
    document.body.innerHTML = `
      <div class="workspace-content"><button aria-label="Send"></button></div>
      <aside><input placeholder="Search" /></aside>`;
    expect(findSearchTarget()).toBeUndefined();
  });

  it("skips a search hidden behind inert", () => {
    document.body.innerHTML = `
      <div class="workspace-content"><div inert><input type="search" /></div></div>`;
    expect(findSearchTarget()).toBeUndefined();
  });
});
