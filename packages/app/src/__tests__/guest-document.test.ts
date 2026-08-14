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
    // The shared base layer: neutral font stack and easing defaults.
    expect(doc).toContain("--font-sans");
    expect(doc).toContain("--ease-standard:cubic-bezier(0.2,0,0,1)");
    expect(doc.indexOf("--color-bg:#f7f7f5")).toBeLessThan(
      doc.indexOf("<script>"),
    );
    // The theme rule comes AFTER the base layer, so a host-supplied feel
    // token overrides the neutral default.
    expect(doc.indexOf("--font-sans:system-ui")).toBeLessThan(
      doc.indexOf("--color-bg:#f7f7f5"),
    );
  });

  it("carries host feel tokens into the document and the live-theme handler", () => {
    const doc = buildAppGuestDocument({
      code: "/* bundle */",
      css: "",
      theme: {
        appearance: "dark",
        colors: {},
        fonts: { sans: "Georgia,serif" },
        radii: { sm: "2px" },
        easing: "ease-out",
        baseFontSize: "15px",
        rowHeight: "36px",
        motion: { fast: "80ms" },
      },
    });
    // The initial <style> seeds every provided feel var…
    expect(doc).toContain("--font-sans:Georgia,serif;");
    expect(doc).toContain("--radius-sm:2px;");
    expect(doc).toContain("--ease-standard:ease-out;");
    expect(doc).toContain("--cat-font-size:15px;");
    expect(doc).toContain("--cat-row-h:36px;");
    expect(doc).toContain("--cat-motion-fast:80ms;");
    // …and the runtime's live-theme handler knows how to re-apply them.
    for (const varName of [
      "'--font-mono'",
      "'--radius-lg'",
      "'--cat-font-size'",
      "'--cat-row-h'",
      "'--cat-motion-slow'",
    ]) {
      expect(doc).toContain(varName);
    }
  });

  it("injects the embedder stylesheet after the kit, before the app CSS", () => {
    const doc = buildAppGuestDocument({
      code: "/* bundle */",
      css: ".mine{color:var(--color-fg)}",
      hostCss: ".cat-btn{text-transform:uppercase}</style><b>",
    });
    // Host CSS can restyle cat-* wholesale: it lands AFTER the kit sheet…
    expect(doc.indexOf(".cat-btn{appearance:none")).toBeLessThan(
      doc.indexOf(".cat-btn{text-transform:uppercase"),
    );
    // …and BEFORE the app's own CSS, which still overrides everything.
    expect(doc.indexOf(".cat-btn{text-transform:uppercase")).toBeLessThan(
      doc.indexOf(".mine{"),
    );
    // Escaped like the app CSS: it cannot break out of its style element.
    expect(doc).toContain("<\\/style><b>");
  });

  it("omits the kit stylesheet when the embedder opts out", () => {
    const doc = buildAppGuestDocument({
      code: "/* bundle */",
      css: ".mine{color:var(--color-fg)}",
      kit: false,
    });
    expect(doc).not.toContain(".cat-btn");
    // The base token layer and the app CSS still ship.
    expect(doc).toContain("--cat-font-size:13px");
    expect(doc).toContain(".mine{");
  });

  it("injects the UI-kit stylesheet after the base layer, before app CSS", () => {
    const doc = buildAppGuestDocument({
      code: "/* bundle */",
      css: ".mine{color:var(--color-fg)}",
      theme: { appearance: "dark", colors: {} },
    });
    // Kit classes are present without the app importing any CSS…
    expect(doc).toContain(".cat-btn");
    expect(doc).toContain(".cat-dialog-panel");
    // …AFTER the base layer (tokens the kit consumes)…
    expect(doc.indexOf("--ease-standard:cubic-bezier")).toBeLessThan(
      doc.indexOf(".cat-btn"),
    );
    // …and BEFORE the app's own CSS, so apps can override the kit.
    expect(doc.indexOf(".cat-btn")).toBeLessThan(doc.indexOf(".mine{"));
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
    // bundle script; the theme, base-layer, UI-kit and app styles): the
    // bundle's own copies are escaped.
    expect(doc.match(/<\/script>/g)).toHaveLength(2);
    expect(doc.match(/<\/style>/g)).toHaveLength(4);
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
