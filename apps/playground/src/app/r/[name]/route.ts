import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

/**
 * Serves the shadcn-style registry payload built by `@catamorphic/registry`.
 * Hosts pull these via `npx shadcn add http://localhost:8501/r/<name>.json`.
 *
 * The registry is intentionally read at request time so dev edits take
 * effect without a restart.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
) {
  const { name } = await context.params;
  const safeName = name.replace(/\.json$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(safeName)) {
    return NextResponse.json(
      { error: "invalid registry item name" },
      { status: 400 },
    );
  }

  const registryDir = path.resolve(
    process.cwd(),
    "..",
    "..",
    "packages",
    "registry",
    "dist",
    "r",
  );
  const filePath = path.join(registryDir, `${safeName}.json`);
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return new NextResponse(contents, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json(
      { error: `registry item not found: ${safeName}` },
      { status: 404 },
    );
  }
}

export const dynamic = "force-dynamic";
