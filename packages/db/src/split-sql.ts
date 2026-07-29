/**
 * Split a migration file into individual statements. Needed because
 * single-connection dialects (PGlite) execute queries over the extended
 * protocol, which rejects multi-command strings. Handles single-quoted
 * strings, double-quoted identifiers, line/block comments, and dollar
 * quoting; migrations are repo-controlled, so this does not attempt to
 * cover every exotic Postgres literal form.
 */
export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sqlText.length) {
    const char = sqlText[i] as string;
    const next = sqlText[i + 1];

    if (char === "-" && next === "-") {
      const end = sqlText.indexOf("\n", i);
      const stop = end === -1 ? sqlText.length : end;
      current += sqlText.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      const stop = end === -1 ? sqlText.length : end + 2;
      current += sqlText.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let j = i + 1;
      while (j < sqlText.length) {
        if (sqlText[j] === quote) {
          // Doubled quote is an escape inside both literal kinds.
          if (sqlText[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += sqlText.slice(i, j);
      i = j;
      continue;
    }

    if (char === "$") {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sqlText.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sqlText.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sqlText.length : end + tag.length;
        current += sqlText.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (char === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }
  statements.push(current);

  return statements.map((s) => s.trim()).filter((s) => stripComments(s) !== "");
}

function stripComments(statement: string): string {
  return statement
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}
