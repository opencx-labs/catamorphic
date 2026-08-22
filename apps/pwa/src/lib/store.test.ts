import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realCrypto = globalThis.crypto;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.stubGlobal("crypto", realCrypto);
  vi.restoreAllMocks();
});

describe("PWA state on a local HTTP origin", () => {
  it("creates its initial profile without the secure-context randomUUID API", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });

    const { getState } = await import("./store.js");

    expect(getState().profiles[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
