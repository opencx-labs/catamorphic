export interface ImportedPassword {
  origin: string;
  username: string;
  password: string;
}

function rows(source: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(Boolean)) result.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some(Boolean)) result.push(row);
  return result;
}

/** Parse the CSV formats exported by Chrome and Firefox. */
export function parsePasswordCsv(source: string): ImportedPassword[] {
  const [header, ...records] = rows(source.replace(/^\uFEFF/, ""));
  if (!header) return [];
  const columns = header.map((name) => name.trim().toLowerCase());
  const urlIndex = columns.findIndex((name) =>
    ["url", "origin", "website"].includes(name),
  );
  const usernameIndex = columns.indexOf("username");
  const passwordIndex = columns.indexOf("password");
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
    throw new Error("This is not a Chrome or Firefox password export");
  }
  const imported: ImportedPassword[] = [];
  for (const record of records) {
    const rawUrl = record[urlIndex]?.trim();
    const password = record[passwordIndex] ?? "";
    if (!rawUrl || !password) continue;
    try {
      const url = new URL(
        /^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`,
      );
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      imported.push({
        origin: url.origin,
        username: record[usernameIndex] ?? "",
        password,
      });
    } catch {
      // One malformed row should not prevent importing the rest.
    }
  }
  return imported;
}
