import { describe, expect, it } from "vitest";
import { buildAppGuestDocument } from "../guest-document.js";

describe("buildAppGuestDocument", () => {
  it("seeds the document with the host theme and base layer", () => {
    const doc = buildAppGuestDocument({
      code: "/* bundle */",
      css: "",
      theme: {
        appearance: "light",
        colors: { bg: "#f7f7f5", accent: "#d63c0c" },
      },
    });
    // Theme vars land before the app's own CSS, so the app can override.
    expect(doc).toContain("--color-bg:#f7f7f5");
    expect(doc).toContain("--color-accent:#d63c0c");
    expect(doc).toContain("color-scheme:light");
    // The shared base layer: shell font stack and the one easing.
    expect(doc).toContain("--font-sans");
    expect(doc).toContain("--ease-standard:cubic-bezier(0.2,0,0,1)");
    expect(doc.indexOf("--color-bg:#f7f7f5")).toBeLessThan(
      doc.indexOf("<script>"),
    );
  });

  it("defaults to a no-network CSP and widens only declared origins", () => {
    expect(buildAppGuestDocument({ code: "", css: "" })).toContain(
      "connect-src 'none'",
    );
    expect(
      buildAppGuestDocument({
        code: "",
        css: "",
        allowedNetworkOrigins: ["https://api.example.com"],
      }),
    ).toContain("connect-src https://api.example.com");
  });

  it("neutralizes a </script> sequence in the bundle", () => {
    // A bundle carrying the literal closing tag (a string constant is enough)
    // would otherwise end the inline script and spill into the document.
    const doc = buildAppGuestDocument({
      code: 'const s = "</script><img src=x onerror=alert(1)>";',
      css: "a{content:'</style><b>'}",
      theme: { appearance: "dark", colors: {} },
    });
    // Only the real closing tags survive (the host runtime script and the
    // bundle script; the theme style, base-layer style and the app style):
    // the bundle's own copies are escaped.
    expect(doc.match(/<\/script>/g)).toHaveLength(2);
    expect(doc.match(/<\/style>/g)).toHaveLength(3);
    expect(doc).toContain("<\\/script>");
    // The injected markup stays inside the script text, never parsed as HTML.
    expect(doc).toContain("<\\/script><img src=x onerror=alert(1)>");
  });

  it("leaves JS that merely looks like an HTML comment intact", () => {
    // `a<!--b` is valid JS (a < !(--b)) and minifiers emit it. Rewriting it
    // to \x3C outside a string literal would be a SyntaxError at load.
    const code = "let a=5,b=1;const c=a<!--b;";
    const doc = buildAppGuestDocument({ code, css: "" });
    expect(doc).toContain(code);
    expect(doc).not.toContain("\\x3C");
  });

  it("hydrates localStorage from the seed and writes back, HTML-inert", () => {
    const doc = buildAppGuestDocument({
      code: "APP()",
      css: "",
      storageSeed: { note: "</script><img src=x>", plain: "ok" },
    });
    // The hostile value is unicode-escaped before the HTML tokenizer sees
    // it; JS string semantics read it back identically.
    expect(doc).toContain("\\u003c/script\\u003e");
    expect(doc).not.toContain("</script><img");
    expect(doc).toContain('"plain":"ok"');
    // Mutations post the persistence message (debounced write-through).
    expect(doc).toContain("kind:'storage'");
    expect(doc).toContain("setTimeout(flush,250)");
  });

  it("shims local/sessionStorage ahead of the bundle", () => {
    // Opaque-origin guests throw on merely READING window.localStorage;
    // one uncaught access (a save effect) blanks the whole app. The
    // runtime must shadow both storages with in-memory stand-ins BEFORE
    // the bundle script runs.
    const doc = buildAppGuestDocument({ code: "APP()", css: "" });
    for (const name of ["localStorage", "sessionStorage"]) {
      expect(doc).toContain(`'${name}'`);
    }
    expect(doc).toContain("Object.defineProperty(window,name");
    expect(doc.indexOf("Object.defineProperty(window,name")).toBeLessThan(
      doc.indexOf("APP()"),
    );
  });
});
