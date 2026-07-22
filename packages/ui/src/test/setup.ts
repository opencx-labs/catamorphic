import "@testing-library/jest-dom/vitest";

Element.prototype.scrollIntoView = () => {};

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
