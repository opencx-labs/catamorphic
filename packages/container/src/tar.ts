const BLOCK = 512;
/** ustar's name field holds this many bytes; longer paths need a PAX header. */
const NAME_BYTES = 100;

/** One regular file in an archive. */
export interface TarFile {
  /** Relative path inside the archive, `/`-separated. */
  path: string;
  content: string | Uint8Array;
  /** Permission bits; 0644 by default. */
  mode?: number;
}

/**
 * A ustar archive of regular files, for `tar -x` inside a sandbox. Paths
 * longer than ustar's 100 bytes travel in a PAX extended header, which GNU
 * tar and BusyBox both read. Directories are left to the extractor, which
 * creates every parent it needs.
 */
export function tarArchive(files: readonly TarFile[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const blocks: Buffer[] = [];
  for (const file of files) {
    const name = normalizedPath(file.path);
    const content =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : Buffer.from(file.content);
    const nameBytes = Buffer.byteLength(name, "utf8");
    if (nameBytes > NAME_BYTES) {
      const records = paxRecord("path", name);
      blocks.push(
        header({
          name: `PaxHeader/${asciiTail(name)}`,
          size: records.length,
          mode: 0o644,
          mtime,
          type: "x",
        }),
        padded(records),
      );
    }
    blocks.push(
      header({
        name: nameBytes > NAME_BYTES ? asciiTail(name) : name,
        size: content.length,
        mode: file.mode ?? 0o644,
        mtime,
        type: "0",
      }),
      padded(content),
    );
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

function normalizedPath(raw: string): string {
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error(`'${raw}' names no file`);
  if (parts.includes(".."))
    throw new Error(`'${raw}' leaves the upload directory`);
  return parts.join("/");
}

/** The last bytes of a long path that fit a name field, for readers without PAX. */
function asciiTail(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return ascii.length > 90 ? ascii.slice(-90) : ascii;
}

/** One PAX record: `<length> <key>=<value>\n`, the length counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  // Counting the length's own digits can add one more digit (98 -> 101).
  const length =
    bodyBytes + String(bodyBytes + String(bodyBytes).length).length;
  return Buffer.from(`${length}${body}`, "utf8");
}

function header(entry: {
  name: string;
  size: number;
  mode: number;
  mtime: number;
  type: "0" | "x";
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(entry.name, 0, NAME_BYTES, "utf8");
  octal(block, 100, 8, entry.mode & 0o7777);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, entry.size);
  octal(block, 136, 12, entry.mtime);
  block.write(entry.type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  // The checksum is computed with its own field as spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function octal(block: Buffer, offset: number, width: number, value: number) {
  if (value >= 8 ** (width - 1))
    throw new Error("A file is too large for this archive");
  block.write(
    `${value.toString(8).padStart(width - 1, "0")}\0`,
    offset,
    width,
    "ascii",
  );
}

function padded(content: Buffer): Buffer {
  const remainder = content.length % BLOCK;
  return remainder === 0
    ? content
    : Buffer.concat([content, Buffer.alloc(BLOCK - remainder)]);
}
