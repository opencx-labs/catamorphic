import type { RunReport } from "./types.js";

export async function reportRunResult(
  apiUrl: string,
  runId: string,
  report: RunReport,
): Promise<void> {
  const url = `${apiUrl}/api/runs/${runId}/report`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to report run result: ${response.status} ${body}`);
  }
}
