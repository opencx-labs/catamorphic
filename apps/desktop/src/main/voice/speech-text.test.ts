import { describe, expect, it } from "vitest";
import {
  isEcho,
  isStopCommand,
  meaningfulUtterance,
  speakableText,
} from "./speech-text.js";

describe("speakableText", () => {
  it("reads Markdown as plain prose", () => {
    expect(
      speakableText(
        "## Done\n\nI started **two** sessions:\n- `fix-tests` for the [failing suite](https://x.test/run/1)\n- one for the docs\n\nDetails: https://example.com/long/path",
      ),
    ).toBe(
      "Done. I started two sessions: fix-tests for the failing suite. one for the docs. Details: a link",
    );
  });

  it("mentions code instead of reading it", () => {
    expect(speakableText("Here it is:\n```ts\nconst a = 1;\n```")).toBe(
      "Here it is: The code is in the chat.",
    );
    expect(speakableText("```\nls\n```")).toBe("The code is in the chat.");
  });

  it("drops tables and rules", () => {
    expect(
      speakableText("Status\n\n| a | b |\n|---|---|\n\n---\nAll good"),
    ).toBe("Status. All good.");
  });
});

describe("what the person said", () => {
  it("ignores hesitation sounds", () => {
    expect(meaningfulUtterance("Um.")).toBe(false);
    expect(meaningfulUtterance("Uh, hmm")).toBe(false);
    expect(meaningfulUtterance("Um, check the build")).toBe(true);
  });

  it("recognizes an echo of the agent's own words", () => {
    const said = "I started a session to fix the failing tests.";
    expect(isEcho("started a session to fix the failing", said)).toBe(true);
    expect(isEcho("what about the docs though", said)).toBe(false);
    // Recognition drops endings of the agent's own words.
    expect(isEcho("to fix the failing test", said)).toBe(true);
    // Short commands are the person's, even in the agent's words.
    expect(isEcho("fix the", said)).toBe(false);
  });

  it("knows a stop command from a request", () => {
    expect(isStopCommand("Stop.")).toBe(true);
    expect(isStopCommand("Never mind")).toBe(true);
    expect(isStopCommand("please stop talking")).toBe(true);
    expect(isStopCommand("Alright, stop please.")).toBe(true);
    expect(isStopCommand("Okay, okay, wait.")).toBe(true);
    expect(isStopCommand("Hold on for now.")).toBe(true);
    expect(isStopCommand("stop the dev server")).toBe(false);
  });
});
