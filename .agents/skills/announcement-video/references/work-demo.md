# Work desktop demo recipe

Read current desktop interaction contracts before capture. This sequence is the accepted direction for the Work website film, not a mandatory script for every feature announcement.

## One useful story

The viewer is exploring Work and wants to turn an idea into something usable.

1. Establish the browser inside Work, with enough sidebar visible to understand the workspace. Open the Work page through the palette. Show web mode deliberately and pause on its transition. Check its actual navigation contract: a search mode may issue a search rather than navigate directly to a URL. Never splice the result to imply behavior the product does not have.
2. Scroll a little to read the page. The scroll gives context for the question rather than filling time.
3. Use the palette to create a floating chat. Type a concise question about Work, send it, and show the useful answer. Include the actual page or project context the agent needs; do not imply automatic page awareness that was not verified.
4. Expand that same conversation with the current keyboard shortcut. At the time of this film, Cmd+Shift+M opens a floating chat as a tab. Verify it against the running app. Expansion creates room for the next task.
5. Send a follow-up asking for a small relevant app, such as a launch checklist based on the discussion. Show actual creation activity and the real result. The user allows speeding up this build interval; show a restrained “Build sped up” label and preserve elapsed time in the capture manifest.
6. Open and use the created app. For a checklist, complete an item and show progress change. Pop the conversation out or minimize it only if doing so makes room to use the app or compare it with the source page. End on the accomplished task.

Prefer short, naturally connected prompts over a feature inventory. Keep the answer concise enough to read. Do not force this complete story into a 24-second cut.

## Capture and pacing

- Use a dedicated development worktree/profile and safe prepared project content. Keep other running sessions undisturbed. Existing CLI authentication may be used through the app's normal local-auth setting; do not copy credentials into the demo project.
- Use computer use for the visible actions. Setup APIs can prepare the safe project or window before capture. Record the real app, including embedded browser surfaces, using an appropriate capture tool.
- Human typing is visible behavior: start around 70 to 130 ms per character, with short word pauses and longer pauses after mode activation. Adjust after watching normal-speed playback. Do not paste complete prompts or accelerate typing in the edit.
- Record continuous animation frames and source timestamps. A sequence of still screenshots cannot demonstrate palette or chat transitions. Retain the beginning and end of each transition; do not cut across its easing.
- Speed up generation waits only. Keep navigation, scrolling, typing, sending, keyboard expansion, and app interaction at 1x. Preserve an editable cut map with source intervals, speed factors, and any omissions.
- Keep browser tab hover cards, debugging chrome, permission setup, and unrelated profiles out of the planned take. Preflight authentication and a small real preview build before recording. A successful chat reply alone does not verify app creation. If the product agent uses computer use to verify its app, let it finish before driving the same window yourself. Do not fabricate a successful outcome if the run fails.

## Review lessons from this film

| Rejected result | Required correction |
| --- | --- |
| Chat text was only an unsent draft | Show send, response, and a follow-up with a result. |
| Chats expanded and shrank aimlessly | Tie each layout change to the user's next action. |
| Instant typing hid palette animation | Type at human pace and hold on mode transitions. |
| A controls tour had no payoff | Use the generated app to complete a concrete action. |
| The film omitted browser context | Browse and scroll before asking about the page. |
| Setup copy cluttered the website | Keep the removed caption and “About this film” section removed. |

For the current website, the homepage title is `Work`; secondary titles use `Work · Page`. Preserve these and the accepted visual design when replacing media. Deliver the playable film, editable capture/render source, a concise verification record, and the local preview. Website publishing is a separate action requiring existing authorization.
