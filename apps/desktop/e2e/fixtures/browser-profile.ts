import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Synthetic browser data only. No developer profile or credentials. */
export function createBrowserProfile({
  directory,
  origin,
}: {
  directory: string;
  origin: string;
}) {
  const profile = path.join(directory, "fixture.default");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "profiles.ini"),
    "[Profile0]\nName=Test browser\nIsRelative=1\nPath=fixture.default\n",
  );
  const places = new DatabaseSync(path.join(profile, "places.sqlite"));
  places.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, parent INTEGER, title TEXT, guid TEXT, fk INTEGER);`);
  const insert = places.prepare(
    "INSERT INTO moz_places VALUES (?, ?, ?, ?, ?)",
  );
  for (let index = 1; index <= 220; index++) {
    insert.run(
      index,
      `${origin}/page-${index}`,
      index === 220 ? "Deep archive needle" : `Research page ${index}`,
      3,
      (Date.now() - index * 86400000) * 1000,
    );
  }
  places
    .prepare(
      "INSERT INTO moz_bookmarks VALUES (1, 1, 0, 'Imported bookmark', 'fixture', 1)",
    )
    .run();
  places.close();
  const cookies = new DatabaseSync(path.join(profile, "cookies.sqlite"));
  cookies.exec(
    "CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)",
  );
  cookies
    .prepare(
      "INSERT INTO moz_cookies VALUES (?, 'fixture_session', 'signed-in-fixture', '/', ?, 0, 1, 1, '')",
    )
    .run(new URL(origin).hostname, Math.floor(Date.now() / 1000) + 86400);
  cookies.close();
}
