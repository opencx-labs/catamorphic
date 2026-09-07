/** Optional host presentation for a completed browser authorization callback. */
export function connectionAuthorizationPage(args: {
  success: boolean;
}): string {
  const title = args.success
    ? "Account connected"
    : "Sign-in could not be completed";
  const description = args.success
    ? "Return to Catamorphic to continue. Workflows still require your confirmation before they run automatically."
    : "Return to Catamorphic and start sign-in again. Your workflow settings have not changed.";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body style="font:16px/1.6 system-ui;margin:0;background:#101113;color:#f5f5f5;display:grid;min-height:100dvh;place-items:center"><main style="max-width:28rem;padding:2rem"><h1 style="font-size:1.5rem">${title}</h1><p>${description}</p><p>You may close this window.</p></main></body></html>`;
}
