"use client";

import { useCreateProject } from "@catamorphic/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export function NewProjectClient() {
  const router = useRouter();
  const createProject = useCreateProject();
  const [projectName, setProjectName] = useState("Untitled Project");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = projectName.trim();
    const finalName = trimmed.length > 0 ? trimmed : "Untitled Project";
    const project = await createProject.mutateAsync({ name: finalName });
    router.push(`/projects/${project.id}`);
  };

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
        onSubmit={handleSubmit}
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
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          className="h-10 w-full rounded border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-blue-500 focus:outline-none"
        />

        <div className="mt-4">
          <button
            type="submit"
            disabled={createProject.isPending}
            className="h-10 cursor-pointer rounded border border-blue-600 bg-blue-600/20 px-4 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-600/30 hover:text-blue-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {createProject.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </form>
    </main>
  );
}
