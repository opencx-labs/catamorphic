import type { Route } from "./nav.js";
import { completeRemoteAuthorization } from "./oauth.js";
import { addRemoteConnection } from "./store.js";

export async function completeRemoteConnection(options: {
  callbackUrl: string;
  profileId: string;
  storage?: Storage;
  fetch?: typeof fetch;
}): Promise<Route> {
  const fetchImpl = options.fetch ?? fetch;
  const completed = await completeRemoteAuthorization({
    callbackUrl: options.callbackUrl,
    ...(options.storage ? { storage: options.storage } : {}),
    fetch: fetchImpl,
  });
  if (completed.target.kind === "server") {
    let projects = await accessibleProjects({
      serverUrl: completed.target.serverUrl,
      accessToken: completed.credentials.accessToken,
      fetch: fetchImpl,
    });
    const knownProjectIds = new Set(projects.map((project) => project.id));
    const joinable = await joinableProjects({
      serverUrl: completed.target.serverUrl,
      accessToken: completed.credentials.accessToken,
      fetch: fetchImpl,
    });
    for (const project of joinable) {
      if (knownProjectIds.has(project.id)) continue;
      const response = await fetchImpl(
        `${completed.target.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(project.id)}/admission/join`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${completed.credentials.accessToken}`,
          },
        },
      );
      if (!response.ok) continue;
      knownProjectIds.add(project.id);
    }
    if (knownProjectIds.size !== projects.length) {
      projects = await accessibleProjects({
        serverUrl: completed.target.serverUrl,
        accessToken: completed.credentials.accessToken,
        fetch: fetchImpl,
      });
    }
    if (projects.length === 0) {
      throw new Error(
        "You signed in, but you do not have access to any projects on this server yet.",
      );
    }
    for (const project of projects) {
      addRemoteConnection({
        profileId: options.profileId,
        link: {
          serverUrl: completed.target.serverUrl,
          remoteProjectId: project.id,
          ...(project.name ? { remoteProjectName: project.name } : {}),
        },
        credentials: completed.credentials,
      });
    }
    return { kind: "projects" };
  }
  const { link } = completed.target;
  const access = await confirmProjectAccess({
    serverUrl: link.serverUrl,
    projectId: link.remoteProjectId,
    accessToken: completed.credentials.accessToken,
    fetch: fetchImpl,
  });
  if (!access) {
    const projectBase = `${link.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(link.remoteProjectId)}/admission`;
    const admissionPath = link.invitationId
      ? `/invitations/${encodeURIComponent(link.invitationId)}/redeem`
      : "/join";
    const admitted = await fetchImpl(`${projectBase}${admissionPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${completed.credentials.accessToken}`,
      },
    });
    if (!admitted.ok) {
      throw new Error(
        "You signed in, but you do not have access to this project yet.",
      );
    }
    if (
      !(await confirmProjectAccess({
        serverUrl: link.serverUrl,
        projectId: link.remoteProjectId,
        accessToken: completed.credentials.accessToken,
        fetch: fetchImpl,
      }))
    ) {
      throw new Error(
        "You signed in, but you do not have access to this project yet.",
      );
    }
  }

  const connection = addRemoteConnection({
    profileId: options.profileId,
    link,
    credentials: completed.credentials,
  });
  if (link.sessionId) {
    return {
      kind: "chat",
      connectionId: connection.id,
      projectId: connection.projectId,
      sessionId: link.sessionId,
    };
  }
  return {
    kind: "sessions",
    connectionId: connection.id,
    projectId: connection.projectId,
  };
}

async function joinableProjects(options: {
  serverUrl: string;
  accessToken: string;
  fetch: typeof fetch;
}): Promise<Array<{ id: string; name: string }>> {
  const response = await options.fetch(
    `${options.serverUrl.replace(/\/+$/, "")}/admission/projects`,
    { headers: { authorization: `Bearer ${options.accessToken}` } },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) return [];
  return body.flatMap((project) => {
    if (
      !project ||
      typeof project !== "object" ||
      !("id" in project) ||
      typeof project.id !== "string" ||
      !("name" in project) ||
      typeof project.name !== "string"
    ) {
      return [];
    }
    return [{ id: project.id, name: project.name }];
  });
}

async function accessibleProjects(options: {
  serverUrl: string;
  accessToken: string;
  fetch: typeof fetch;
}): Promise<Array<{ id: string; name?: string }>> {
  const response = await options.fetch(
    `${options.serverUrl.replace(/\/+$/, "")}/me`,
    { headers: { authorization: `Bearer ${options.accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Sign-in finished, but the server rejected the new access token."
        : `The server could not load your projects (${response.status}).`,
    );
  }
  const me = (await response.json()) as {
    projects?: Array<{ projectId?: string }>;
  };
  const ids = (me.projects ?? []).flatMap((project) =>
    typeof project.projectId === "string" && project.projectId.length > 0
      ? [project.projectId]
      : [],
  );
  if (ids.length === 0) return [];

  const names = new Map<string, string>();
  const list = await options.fetch(
    `${options.serverUrl.replace(/\/+$/, "")}/projects`,
    { headers: { authorization: `Bearer ${options.accessToken}` } },
  );
  if (list.ok) {
    const body = (await list.json()) as {
      items?: Array<{ id?: string; name?: string }>;
    };
    for (const item of body.items ?? []) {
      if (typeof item.id === "string" && typeof item.name === "string") {
        names.set(item.id, item.name);
      }
    }
  }
  return ids.map((id) => ({
    id,
    ...(names.get(id) ? { name: names.get(id) } : {}),
  }));
}

async function confirmProjectAccess(options: {
  serverUrl: string;
  projectId: string;
  accessToken: string;
  fetch: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = options.fetch;
  const response = await fetchImpl(
    `${options.serverUrl.replace(/\/+$/, "")}/me`,
    {
      headers: { authorization: `Bearer ${options.accessToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Sign-in finished, but the server rejected the new access token."
        : `The server could not confirm project access (${response.status}).`,
    );
  }
  const me = (await response.json()) as {
    projects?: Array<{ projectId?: string }>;
  };
  return Boolean(
    me.projects?.some((project) => project.projectId === options.projectId),
  );
}
