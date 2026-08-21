import dgram from "node:dgram";
import os from "node:os";

/**
 * A minimal mDNS responder (RFC 6762), zero dependencies: answers A
 * queries for one `.local` hostname with this machine's IPv4 addresses,
 * and announces on start. That's exactly enough for a phone browser to
 * open `http://catamorphic.local:<port>` — browsers can't run mDNS
 * themselves, but every phone OS resolves `.local` hostnames.
 *
 * Deliberately not implemented: conflict probing, IPv6 answers, service
 * enumeration (DNS-SD), name compression. If another responder already
 * owns the name, pass a different one (CATAMORPHIC_MDNS_NAME).
 *
 * In Docker this needs the host's network (`--network host`) — multicast
 * does not cross the default bridge.
 */

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;
/** Class IN with the cache-flush bit, for answers we're authoritative on. */
const CLASS_IN_FLUSH = 0x8001;
const TTL_SECONDS = 120;

export interface MdnsResponder {
  hostname: string;
  close(): void;
}

/** Lowercased dot-joined name from DNS labels at `offset`; null on overrun. */
export function decodeName(
  message: Buffer,
  offset: number,
): { name: string; end: number } | null {
  const labels: string[] = [];
  let cursor = offset;
  for (let guard = 0; guard < 32; guard += 1) {
    if (cursor >= message.length) return null;
    const length = message[cursor];
    if (length === undefined) return null;
    if (length === 0) {
      return { name: labels.join(".").toLowerCase(), end: cursor + 1 };
    }
    // Compression pointers never appear in the questions we care about;
    // treat them as end-of-parse rather than following.
    if ((length & 0xc0) !== 0) return null;
    cursor += 1;
    if (cursor + length > message.length) return null;
    labels.push(message.subarray(cursor, cursor + length).toString("utf8"));
    cursor += length;
  }
  return null;
}

export function encodeName(name: string): Buffer {
  const parts = name.split(".").filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, "utf8");
    chunks.push(Buffer.from([label.length]), label);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** The questions in a DNS message that ask for `hostname` (A or ANY). */
export function matchingQuestions(
  message: Buffer,
  hostname: string,
): Array<{ unicastReply: boolean }> {
  if (message.length < 12) return [];
  const flags = message.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return []; // A response, not a query.
  const questionCount = message.readUInt16BE(4);
  const wanted = hostname.toLowerCase();
  const matches: Array<{ unicastReply: boolean }> = [];
  let cursor = 12;
  for (let index = 0; index < questionCount; index += 1) {
    const decoded = decodeName(message, cursor);
    if (!decoded) return matches;
    if (decoded.end + 4 > message.length) return matches;
    const qtype = message.readUInt16BE(decoded.end);
    const qclass = message.readUInt16BE(decoded.end + 2);
    cursor = decoded.end + 4;
    if (decoded.name !== wanted) continue;
    if (qtype !== TYPE_A && qtype !== TYPE_ANY) continue;
    matches.push({ unicastReply: (qclass & 0x8000) !== 0 });
  }
  return matches;
}

/** An authoritative mDNS response with one A record per address. */
export function encodeAnswer(hostname: string, addresses: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id: always 0 in mDNS responses
  header.writeUInt16BE(0x8400, 2); // response + authoritative
  header.writeUInt16BE(addresses.length, 6); // answer count
  const name = encodeName(hostname);
  const records = addresses.map((address) => {
    const record = Buffer.alloc(name.length + 14);
    name.copy(record, 0);
    record.writeUInt16BE(TYPE_A, name.length);
    record.writeUInt16BE(CLASS_IN_FLUSH, name.length + 2);
    record.writeUInt32BE(TTL_SECONDS, name.length + 4);
    record.writeUInt16BE(4, name.length + 8);
    const octets = address.split(".").map(Number);
    record.set(octets, name.length + 10);
    return record;
  });
  return Buffer.concat([header, ...records]);
}

export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

export function startMdnsResponder(
  hostname: string,
  log: (line: string) => void = () => {},
): MdnsResponder | null {
  const addresses = lanAddresses();
  if (addresses.length === 0) return null;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let closed = false;

  socket.on("error", (error) => {
    log(`mDNS responder stopped: ${String(error)}`);
    socket.close();
  });
  socket.on("message", (message, remote) => {
    const questions = matchingQuestions(message, hostname);
    if (questions.length === 0) return;
    const answer = encodeAnswer(hostname, addresses);
    // Legacy/one-shot resolvers (source port != 5353) and QU questions
    // get a unicast copy; everyone else hears the multicast answer.
    const wantsUnicast =
      remote.port !== MDNS_PORT ||
      questions.some((question) => question.unicastReply);
    if (wantsUnicast) socket.send(answer, remote.port, remote.address);
    socket.send(answer, MDNS_PORT, MDNS_ADDRESS);
  });

  socket.bind(MDNS_PORT, () => {
    if (closed) return;
    try {
      socket.setMulticastTTL(255);
      for (const address of addresses) {
        try {
          socket.addMembership(MDNS_ADDRESS, address);
        } catch {
          // An interface without multicast; the others still work.
        }
      }
      // Unsolicited announcements so caches warm before the first query.
      const announce = () =>
        socket.send(encodeAnswer(hostname, addresses), MDNS_PORT, MDNS_ADDRESS);
      announce();
      setTimeout(announce, 1000).unref();
      log(`mDNS: answering for ${hostname} → ${addresses.join(", ")}`);
    } catch (error) {
      log(`mDNS responder unavailable: ${String(error)}`);
      socket.close();
    }
  });

  return {
    hostname,
    close: () => {
      closed = true;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}
