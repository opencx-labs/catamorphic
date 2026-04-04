"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export default function WorkflowRunsPage() {
  const params = useParams<{ id: string }>();

  return (
    <main className="max-w-screen-2xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 text-sm text-neutral-400 mb-2">
            <Link href="/" className="hover:text-neutral-200">
              Workflows
            </Link>
            <span>/</span>
            <Link
              href={`/workflows/${params.id}`}
              className="hover:text-neutral-200"
            >
              {params.id}
            </Link>
            <span>/</span>
            <span className="text-neutral-200">Runs</span>
          </div>
          <h1 className="text-2xl font-bold">Execution History</h1>
        </div>
      </div>

      <div className="border border-dashed border-neutral-800 rounded-lg p-12 flex flex-col items-center justify-center text-neutral-500">
        <p className="text-sm">No runs yet</p>
        <p className="text-xs mt-1">
          Run the workflow to see execution history here
        </p>
      </div>
    </main>
  );
}
