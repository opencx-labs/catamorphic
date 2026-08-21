import { describe, expect, it } from "vitest";
import {
  decodeName,
  encodeAnswer,
  encodeName,
  matchingQuestions,
} from "./mdns.js";

function query(name: string, qtype = 1, qclass = 1): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0, 2); // query
  header.writeUInt16BE(1, 4); // one question
  const qname = encodeName(name);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(qclass, 2);
  return Buffer.concat([header, qname, tail]);
}

describe("mdns wire format", () => {
  it("round-trips names", () => {
    const encoded = encodeName("Catamorphic.local");
    expect(decodeName(encoded, 0)?.name).toBe("catamorphic.local");
  });

  it("matches A and ANY questions for the hostname, case-insensitively", () => {
    expect(
      matchingQuestions(query("CATAMORPHIC.local"), "catamorphic.local"),
    ).toHaveLength(1);
    expect(
      matchingQuestions(query("catamorphic.local", 255), "catamorphic.local"),
    ).toHaveLength(1);
    expect(
      matchingQuestions(query("other.local"), "catamorphic.local"),
    ).toHaveLength(0);
    // AAAA questions are not ours to answer.
    expect(
      matchingQuestions(query("catamorphic.local", 28), "catamorphic.local"),
    ).toHaveLength(0);
  });

  it("flags QU questions as wanting a unicast reply", () => {
    const [match] = matchingQuestions(
      query("catamorphic.local", 1, 0x8001),
      "catamorphic.local",
    );
    expect(match?.unicastReply).toBe(true);
  });

  it("ignores responses and truncated packets", () => {
    const response = query("catamorphic.local");
    response.writeUInt16BE(0x8400, 2);
    expect(matchingQuestions(response, "catamorphic.local")).toHaveLength(0);
    expect(
      matchingQuestions(Buffer.from([0, 1, 2]), "catamorphic.local"),
    ).toHaveLength(0);
  });

  it("encodes an authoritative answer with one A record per address", () => {
    const answer = encodeAnswer("catamorphic.local", [
      "192.168.1.7",
      "10.0.0.2",
    ]);
    expect(answer.readUInt16BE(2)).toBe(0x8400);
    expect(answer.readUInt16BE(6)).toBe(2);
    const name = decodeName(answer, 12);
    expect(name?.name).toBe("catamorphic.local");
    const end = name?.end ?? 0;
    expect(answer.readUInt16BE(end)).toBe(1); // TYPE A
    expect(answer.readUInt16BE(end + 8)).toBe(4); // rdlength
    expect([...answer.subarray(end + 10, end + 14)]).toEqual([192, 168, 1, 7]);
  });
});
