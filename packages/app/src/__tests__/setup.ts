import "@testing-library/jest-dom/vitest";

// jsdom lacks these layout-adjacent APIs the kit touches.
Element.prototype.scrollIntoView = () => {};

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
