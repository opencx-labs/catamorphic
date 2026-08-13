import { describe, expect, it } from "vitest";
import {
  capOutput,
  type Osc133Marker,
  sanitizeTerminalOutput,
  scanOsc133,
} from "./terminal-text.js";

describe("scanOsc133", () => {
  const collect = (chunks: string[]) => {
    const markers: Osc133Marker[] = [];
    let carry = "";
    for (const chunk of chunks) {
      carry = scanOsc133(carry + chunk, (marker) => markers.push(marker));
    }
    return markers;
  };

  it("parses command-start and command-done markers with exit codes", () => {
    const markers = collect([
      "\x1b]133;C\x07ls output\r\n\x1b]133;D;0\x07prompt $ ",
    ]);
    expect(markers).toEqual([{ kind: "C" }, { kind: "D", exitCode: 0 }]);
  });

  it("parses ST-terminated markers and non-zero exits", () => {
    const markers = collect(["\x1b]133;D;127\x1b\\"]);
    expect(markers).toEqual([{ kind: "D", exitCode: 127 }]);
  });

  it("reassembles markers split across chunks", () => {
    const markers = collect(["output\x1b]13", "3;D;1\x07more"]);
    expect(markers).toEqual([{ kind: "D", exitCode: 1 }]);
  });

  it("does not carry unrelated escape sequences", () => {
    const markers: Osc133Marker[] = [];
    const carry = scanOsc133("text\x1b[31mred", (m) => markers.push(m));
    expect(markers).toEqual([]);
    expect(carry).toBe("");
  });
});

describe("sanitizeTerminalOutput", () => {
  it("strips CSI and OSC sequences", () => {
    expect(
      sanitizeTerminalOutput(
        "\x1b]0;window title\x07\x1b[1;32mok\x1b[0m done\x1b]133;D;0\x07",
      ),
    ).toBe("ok done");
  });

  it("collapses erase-line progress redraws to the final frame", () => {
    expect(
      sanitizeTerminalOutput(
        "downloading  10%\r\x1b[Kdownloading 100%\r\x1b[Kdone.\n",
      ),
    ).toBe("done.\n");
  });

  it("keeps the overwritten tail like a real terminal when nothing erased it", () => {
    expect(sanitizeTerminalOutput("abcdef\rxy")).toBe("xycdef");
  });

  it("applies backspace overwrites", () => {
    expect(sanitizeTerminalOutput("cats\b \b")).toBe("cat");
  });

  it("normalizes CRLF and trims trailing space padding", () => {
    expect(sanitizeTerminalOutput("line one   \r\nline two\r\n")).toBe(
      "line one\nline two\n",
    );
  });

  it("collapses runs of blank lines", () => {
    expect(sanitizeTerminalOutput("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });
});

describe("capOutput", () => {
  it("returns short text untouched", () => {
    expect(capOutput("hello", 10)).toBe("hello");
  });

  it("keeps the tail and reports what was dropped", () => {
    const capped = capOutput("x".repeat(100), 40);
    expect(capped).toContain("60 earlier characters omitted");
    expect(capped.endsWith("x".repeat(40))).toBe(true);
  });
});
