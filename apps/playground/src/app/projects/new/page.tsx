import Link from "next/link";
import { createProjectFromScratchAction } from "@/lib/project-actions";

export default function NewProjectPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center gap-2 text-sm text-neutral-400 mb-6">
        <Link
          href="/"
          className="cursor-pointer hover:text-neutral-200 transition-colors"
        >
          Projects
        </Link>
        <span className="text-neutral-600">/</span>
        <span className="text-neutral-200">New Project</span>
      </div>

      <h1 className="text-2xl font-bold mb-2">Create Project</h1>
      <p className="text-sm text-neutral-400 mb-6">
        Create a project first, then add one or more workflows inside it.
      </p>

      <form
        action={createProjectFromScratchAction}
        className="border border-neutral-800 rounded-lg p-6 bg-neutral-950/50"
      >
        <label
          htmlFor="projectName"
          className="block text-sm font-medium text-neutral-200 mb-2"
        >
          Project name
        </label>
        <input
          id="projectName"
          type="text"
          name="projectName"
          defaultValue="Untitled Project"
          className="h-10 w-full rounded border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-blue-500 focus:outline-none"
        />

        <div className="mt-4">
          <button
            type="submit"
            className="h-10 cursor-pointer rounded border border-blue-600 bg-blue-600/20 px-4 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-600/30 hover:text-blue-200"
          >
            Create Project
          </button>
        </div>
      </form>
    </main>
  );
}
