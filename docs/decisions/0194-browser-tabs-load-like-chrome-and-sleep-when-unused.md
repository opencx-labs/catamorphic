# 0194 — Browser tabs load like Chrome's and sleep when unused

- **Status:** Accepted (amended by 0203)
- **Date:** 2026-10-01

> Amended by [0203](0203-work-runs-chrome-extensions-from-the-web-store.md):
> a profile with an extension that filters requests drops the brand
> rewrite's `webRequest` listener (any listener switches off extension
> request filtering) and sets the same headers from a hidden built-in
> extension instead.

## Context

Pages in Work's browser tabs loaded slower than in Chrome, and Google Meet
sometimes rendered its buttons as icon names ("mic", "videocam") until its
icon font arrived. The HTTP and code caches were working. A local benchmark
(160 subresources at 20 ms latency, same Electron build) found three costs
of our own:

- The `Sec-CH-UA` brand rewrite (Work presents as Chrome; design history,
  2026-08-01) listened to every request. An Electron `webRequest` listener
  runs each request it matches through the main process's event loop, which
  the embedded server shares. With the main thread busy 40% of the time,
  cold loads took 42% longer; with 600 ms stalls each second, 2.7 times
  longer, and the icon font arrived 3 times later. Without the listener, a
  busy main thread had no measurable effect. A listener filtered by URL kept
  the cost; one filtered by resource type did not.
- A macOS workaround for a V8 crash (`--no-concurrent-sparkplug
  --no-concurrent-recompilation`, added on Electron 43.2) moved JIT
  compilation onto each renderer's main thread. A runtime `js-flags` switch
  reaches only child processes, so it slowed the app's own window and every
  web page, never the main process: the same TypeScript transpile ran 1.9
  times slower (586 ms against 306 ms). The upstream crash
  (electron/electron#51351) is specific to the Mac App Store sandbox, and a
  stress run on Electron 44.4.3 and macOS 26.5.2 did not reproduce one.
- Every browser tab stayed loaded forever, and a restored workspace loaded
  every tab at launch.

## Decision

**The brand rewrite applies to documents and page requests only** (`types:
mainFrame, subFrame, xhr`). Those are where a site reads the brand
server-side, and they stay consistent with `navigator.userAgentData`.
Scripts, styles, fonts, images and media no longer pass through the main
process. With 600 ms stalls each second, cold loads and the icon font then
matched a session without the listener; fetch and XHR requests still took
about 40% longer, the price of keeping sign-in's requests consistent. A
Chrome DevTools Protocol user-agent override per guest would cover every
request natively, but it needs a debugger session on every page, races the
first navigation, and must supply all of Chromium's client-hint metadata
itself.

**V8 compiles in the background again.** The JIT flags are removed.

**Unused tabs sleep, as in Chrome's Memory Saver.** A browser tab out of
sight for the profile's `browserTabSleep` time (15 minutes to 2 hours, or
never; 1 hour by default) unloads its page. The renderer schedules sleep
(`renderer/lib/tab-sleep.ts`) and removes the tab's `<webview>`. Main keeps
the page's navigation entries, including Chromium's page state (scroll
position and form values), and the wake restores them into a fresh guest
(`main/browser-sleep.ts`, the `work-wake:` source). If main no longer holds
them, the tab's saved history loads instead.

A page stays awake while it plays sound or played it in the last two
minutes, has opened the camera, microphone or a screen share since it
loaded, is being shown elsewhere (a tab share), has its DevTools open, or
holds text the person typed into a field and has not sent. Electron reports
media grants but not when a stream stops, so a page that captured stays
awake until it navigates. Tabs on screen, tabs an agent is working, and tabs
under agent control never sleep. An agent reaching a sleeping tab wakes it
and waits for the page; a takeover by the person survives the sleep.

**A workspace mounts with its hidden tabs asleep.** At launch, or when a
project opens again, only the tabs on screen load; the rest load when shown.
Choosing Never wakes every tab and loads restored tabs at once.

A sleeping tab's icon fades behind a dashed ring in the tab strip and the
sidebar, and its hover card says it is asleep.

## Consequences

- Page loads no longer depend on how busy the embedded server is, except
  for a document or fetch request's header rewrite.
- Memory held by unused tabs is returned; restoring a large workspace is as
  cheap as restoring its visible tabs.
- A sleeping page runs nothing: its notifications, timers and sockets stop
  until it wakes, as in Chrome. People who rely on a page in the
  background choose a longer time or Never.
- Typed text is seen in the page's main frame only. A rich editor inside
  an iframe or a closed shadow root does not keep its tab awake; Chromium's
  page state restores plain form fields, not such editors.
- An agent's element references into a page do not survive its sleep; the
  agent reads the page again after the wake.
- If the V8 crash returns, a web page's renderer recovers through the tab's
  existing remount; the app window's would not. Restore the flags only with
  a crash report from a current Electron release.
- In-page state that Chromium's page state does not capture (an app's own
  memory, media position) is lost on sleep, as with a Chrome discard.
- Subresource requests carry Chromium's own brand list in `Sec-CH-UA`.
  Recheck Google sign-in when changing the rewritten request types.
