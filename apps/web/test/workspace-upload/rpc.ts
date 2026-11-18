import type { z } from "zod";

import type {
  createNodeSchema,
  renameNodeSchema,
} from "../../src/lib/project-node.schema";
import type { createProjectNode as createNode } from "../../src/lib/project-node.server";

// Stand in for TanStack's generated RPC transport, retaining the production store.
export async function createProjectNode({
  data,
}: {
  data: z.input<typeof createNodeSchema>;
}): Promise<Awaited<ReturnType<typeof createNode>>> {
  const response = await fetch("/fixture/nodes", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function deleteProjectNode() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  throw new Error("Delete unavailable");
}

export async function saveProjectSource() {
  throw new Error("Unexpected legacy draft migration");
}

export async function renameProjectNode({
  data,
}: {
  data: z.input<typeof renameNodeSchema>;
}) {
  const response = await fetch("/fixture/rename", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(await response.text());
}

// The upload harness isolates unrelated account/sharing transports; their real
// Worker paths are exercised by the git, assistant, and workspace UI suites.
export async function gitAction() {
  return {
    status: {
      remote: null,
      branch: null,
      branches: [],
      commits: [],
      changes: [],
    },
  };
}
export async function getGitBranch() {
  return null;
}
export async function getGitAccounts() {
  return { github: false, gitlab: false };
}
export async function importGitProject() {
  throw new Error("Git import is outside the upload fixture");
}
export async function getProjectAccess() {
  return { canManage: false, people: [] };
}
export async function grantProjectAccess() {
  throw new Error("Sharing is outside the upload fixture");
}
export async function revokeProjectAccess() {
  throw new Error("Sharing is outside the upload fixture");
}

export async function updateProjectFormatting({
  data,
}: {
  data: {
    projectId: string;
    formatting: { indent: number; wrap: boolean; width: number };
  };
}) {
  const response = await fetch("/fixture/formatting", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
