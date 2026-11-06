/**
 * Minimal tar archive builder for in-memory workspace hydration uploads.
 */
function writeBytes(
  target: Uint8Array,
  offset: number,
  bytes: Uint8Array,
): void {
  target.set(bytes, offset);
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writeBytes(target, offset, bytes);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = value.toString(8).padStart(length - 1, "0");
  const bytes = new TextEncoder().encode(`${octal}\0`);
  writeBytes(target, offset, bytes.slice(0, length));
}

function createTarHeader(path: string, size: number): Uint8Array {
  const normalizedPath = path.replace(/^\/+/, "");
  const nameBytes = new TextEncoder().encode(normalizedPath);
  if (nameBytes.length === 0 || nameBytes.length > 100) {
    throw new Error(`Unsupported tar path length for ${normalizedPath}`);
  }

  const header = new Uint8Array(512);
  header.fill(0);
  writeBytes(header, 0, nameBytes);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  // Checksum field must be spaces while computing checksum.
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = "0".charCodeAt(0);
  writeAscii(header, 257, "ustar");
  writeAscii(header, 263, "00");

  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

export function createTarArchive(
  entries: Array<{ path: string; content: string }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (const entry of entries) {
    const contentBytes = encoder.encode(entry.content);
    const header = createTarHeader(entry.path, contentBytes.length);
    const filePadding = (512 - (contentBytes.length % 512)) % 512;

    chunks.push(header);
    chunks.push(contentBytes);
    if (filePadding > 0) {
      chunks.push(new Uint8Array(filePadding));
    }

    totalLength += header.length + contentBytes.length + filePadding;
  }

  // Tar archives end with two empty 512-byte blocks.
  const trailer = new Uint8Array(1024);
  chunks.push(trailer);
  totalLength += trailer.length;

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
