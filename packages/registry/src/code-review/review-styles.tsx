const css = `
html:has(.cat-review),body:has(.cat-review),#root:has(>.cat-review){height:100%}
.cat-review{display:flex;flex-direction:column;min-height:480px;height:100%;min-width:0;color:var(--color-fg);background:var(--color-bg);font:var(--cat-font-size,13px)/1.5 var(--font-sans,system-ui)}
.cat-review-heading{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--color-border)}
.cat-review-heading h1{font-size:16px;font-weight:600;margin:0}.cat-review-heading p{margin:2px 0 0;color:var(--color-fg-muted);font-size:12px}
.cat-review-nav{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:4px 12px;border-bottom:1px solid var(--color-border)}
.cat-review-nav button{appearance:none;background:transparent;border:0;color:var(--color-fg-muted);border-radius:var(--radius-md,6px);padding:4px 12px;font:inherit;cursor:pointer}
.cat-review-nav button[aria-current=page]{background:var(--color-bg-overlay);color:var(--color-fg)}
.cat-review-nav button:hover{color:var(--color-fg)}
.cat-review-nav button:focus-visible,.cat-review-control:focus-visible,.cat-review-search:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
.cat-review-body{min-height:0;min-width:0;flex:1;overflow:auto;padding:20px 24px}
.cat-review-body[data-view=diff]{display:flex;flex-direction:column;padding:0;overflow:hidden}
.cat-review-prose{max-width:72ch;margin-inline:auto}.cat-review-prose h2{font-size:16px;font-weight:600;margin:24px 0 8px}
.cat-review-finding{border:1px solid var(--color-border);border-radius:var(--radius-md,6px);padding:12px;margin-block:12px}
.cat-review-finding summary{cursor:pointer;font-weight:600}.cat-review-finding p{margin:8px 0}
.cat-review-evidence{font:11px var(--font-mono,monospace);color:var(--color-fg-muted);overflow-wrap:anywhere}
.cat-review-stale{padding:8px 16px;color:var(--color-warning);border-bottom:1px solid var(--color-border)}
.cat-review-diff{display:flex;min-height:0;flex:1;flex-direction:column;min-width:0}
.cat-review-toolbar{display:flex;flex-shrink:0;flex-wrap:wrap;align-items:center;gap:8px;background:var(--color-bg-raised);padding:8px 12px;font-size:12px}
.cat-review-control,.cat-review-search{border:1px solid var(--color-border);background:var(--color-bg-inset);color:var(--color-fg);border-radius:var(--radius-md,6px);padding:4px 8px;font:inherit}
.cat-review-search{margin-left:auto;min-width:0}.cat-review-toggle{display:flex;align-items:center;gap:6px}
.cat-review-location{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--color-bg-overlay);padding:4px 12px;margin:0;font:12px var(--font-mono,monospace)}
.cat-review-code{min-height:0;flex:1;overflow:auto}
@media(max-width:600px){.cat-review-body{padding:12px}.cat-review-heading{padding:8px 12px}.cat-review-nav{padding-inline:8px}}
`;

/** Shared components carry their token-based styles into any app bundler. */
export function ReviewStyles() {
  return <style>{css}</style>;
}
