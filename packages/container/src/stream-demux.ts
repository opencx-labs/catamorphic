/** Which output a frame of Docker's multiplexed stream carries. */
export type DockerStream = "stdout" | "stderr";

const HEADER_BYTES = 8;

/**
 * Splits Docker's multiplexed attach stream (an exec without a TTY) into
 * stdout and stderr. Each frame is an 8-byte header (stream, three zero
 * bytes, big-endian length) and its payload; network reads cut frames
 * anywhere, so partial headers and payloads wait for the next chunk.
 */
export class DockerStreamDemuxer {
  private pending: Buffer = Buffer.alloc(0);

  /** Frames completed by `chunk`, in order. Stdin echoes (stream 0) are dropped. */
  push(chunk: Uint8Array): Array<{ stream: DockerStream; data: Buffer }> {
    this.pending =
      this.pending.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.pending, chunk]);
    const frames: Array<{ stream: DockerStream; data: Buffer }> = [];
    let offset = 0;
    while (this.pending.length - offset >= HEADER_BYTES) {
      const kind = this.pending[offset];
      const size = this.pending.readUInt32BE(offset + 4);
      if (this.pending.length - offset - HEADER_BYTES < size) break;
      const start = offset + HEADER_BYTES;
      const data = this.pending.subarray(start, start + size);
      if (kind === 1) frames.push({ stream: "stdout", data });
      else if (kind === 2) frames.push({ stream: "stderr", data });
      else if (kind !== 0)
        throw new Error(`Docker sent an unknown stream ${String(kind)}`);
      offset = start + size;
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
    return frames;
  }

  /** Bytes of an unfinished frame: non-zero when the stream ended mid-frame. */
  get buffered(): number {
    return this.pending.length;
  }
}

/** A frame as Docker writes it, for tests and fakes. */
export function dockerFrame(stream: 0 | 1 | 2, data: Uint8Array): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
