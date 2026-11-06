import { describe, expect, it } from "vitest";
import { sentTime } from "./chat-timeline.js";

/**
 * Every date here is built from local calendar parts and read back on the
 * local calendar, so the labels are the same in any time zone.
 */
const sent = (...parts: [number, number, number, number, number]) =>
  new Date(...parts).toISOString();
const NOW = new Date(2026, 9, 14, 16, 30);

/** Intl puts a narrow no-break space before AM and PM; a person reads a space. */
const label = (iso: string, now: Date | number = NOW, locale = "en-US") =>
  sentTime(iso, { now, locale })?.label.replace(/\s/g, " ");

describe("sentTime", () => {
  it("says only the time for a message sent today", () => {
    expect(label(sent(2026, 9, 14, 14, 14))).toBe("2:14 PM");
    expect(label(sent(2026, 9, 14, 0, 5))).toBe("12:05 AM");
    // A clock a little ahead of this one: still today.
    expect(label(sent(2026, 9, 14, 16, 31))).toBe("4:31 PM");
  });

  it("says Yesterday and the time for the day before", () => {
    expect(label(sent(2026, 9, 13, 14, 14))).toBe("Yesterday 2:14 PM");
    // Just past midnight, the last minute of the day before.
    expect(label(sent(2026, 9, 14, 23, 59), new Date(2026, 9, 15, 0, 1))).toBe(
      "Yesterday 11:59 PM",
    );
  });

  it("says the date and time earlier this year", () => {
    expect(label(sent(2026, 9, 12, 14, 14))).toBe("Oct 12, 2:14 PM");
    expect(label(sent(2026, 0, 3, 9, 5))).toBe("Jan 3, 9:05 AM");
  });

  it("says only the date in another year", () => {
    expect(label(sent(2025, 9, 12, 14, 14))).toBe("Oct 12, 2025");
  });

  it("reads days on the calendar across a new year", () => {
    const newYear = new Date(2027, 0, 1, 9, 0);
    expect(label(sent(2026, 11, 31, 22, 0), newYear)).toBe(
      "Yesterday 10:00 PM",
    );
    expect(label(sent(2026, 11, 30, 22, 0), newYear)).toBe("Dec 30, 2026");
  });

  it("gives the whole date and time for the hint", () => {
    expect(
      sentTime(sent(2026, 9, 14, 14, 14), {
        now: NOW,
        locale: "en-US",
      })?.full.replace(/\s/g, " "),
    ).toBe("Wednesday, October 14, 2026 at 2:14 PM");
  });

  it("never reads with a dash", () => {
    for (const iso of [
      sent(2026, 9, 14, 14, 14),
      sent(2026, 9, 13, 14, 14),
      sent(2026, 9, 12, 14, 14),
      sent(2025, 9, 12, 14, 14),
    ]) {
      const time = sentTime(iso, { now: NOW, locale: "en-US" });
      expect(`${time?.label} ${time?.full}`).not.toMatch(/[\u2013\u2014-]/);
    }
  });

  it("speaks the person's language", () => {
    expect(label(sent(2026, 9, 14, 14, 14), NOW, "de-DE")).toBe("14:14");
    expect(label(sent(2026, 9, 13, 14, 14), NOW, "de-DE")).toBe(
      "Gestern 14:14",
    );
    expect(label(sent(2026, 9, 12, 14, 14), NOW, "de-DE")).toMatch(
      /^12\. Okt\.,? 14:14$/,
    );
  });

  it("takes now as a timestamp too", () => {
    expect(label(sent(2026, 9, 13, 14, 14), NOW.getTime())).toBe(
      "Yesterday 2:14 PM",
    );
  });

  it("has nothing to say for a time that is not one", () => {
    expect(sentTime("not a time", { now: NOW })).toBeUndefined();
    expect(sentTime("", { now: NOW })).toBeUndefined();
  });
});
