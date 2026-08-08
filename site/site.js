// Shared site chrome: <site-nav> and <site-footer note="...">.
// Light DOM on purpose: the global styles.css classes apply untouched and
// crawlers see real links. One source of truth so pages can never drift.

const LOGO = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <path d="M46 15.5 C42 12.6 37.2 11 32 11 C20.4 11 11 20.4 11 32 C11 43.6 20.4 53 32 53 C37.2 53 42 51.4 46 48.5" stroke="#f95225" stroke-width="6.5" stroke-linecap="round"/>
  <line x1="24" y1="14.5" x2="24" y2="49.5" stroke="#f95225" stroke-width="6.5" stroke-linecap="round"/>
</svg>`;

const GITHUB_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

const REPO = "https://github.com/opencx-labs/catamorphic";

const PAGES = [
  { href: "/desktop/", label: "Desktop" },
  { href: "/workflows/", label: "Workflows" },
  { href: "/apps/", label: "Apps" },
  { href: "/copilot/", label: "Copilot" },
];

const current = (href) =>
  location.pathname === href ? ' aria-current="page"' : "";

class SiteNav extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<nav class="nav">
  <div class="container nav-inner">
    <a class="brand" href="/">${LOGO(26)} catamorphic</a>
    <div class="nav-links">
      ${PAGES.map((p) => `<a href="${p.href}"${current(p.href)}>${p.label}</a>`).join("\n      ")}
      <a class="btn btn-primary" href="${REPO}">${GITHUB_ICON} GitHub</a>
    </div>
  </div>
</nav>`;
  }
}

class SiteFooter extends HTMLElement {
  connectedCallback() {
    const note = this.getAttribute("note") ?? "the human side of the loop";
    this.innerHTML = `<footer>
  <div class="container footer-inner">
    <a class="brand" href="/">${LOGO(20)} catamorphic</a>
    <div class="footer-links">
      <a href="/">Home</a>
      ${PAGES.map((p) => `<a href="${p.href}">${p.label}</a>`).join("\n      ")}
      <a href="/agents/">For agents</a>
      <a href="${REPO}">GitHub</a>
    </div>
    <span class="footer-note">⦇ catamorphic ⦈ · ${note}</span>
  </div>
</footer>`;
  }
}

customElements.define("site-nav", SiteNav);
customElements.define("site-footer", SiteFooter);
