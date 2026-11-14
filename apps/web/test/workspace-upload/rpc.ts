import type { z } from "zod";

import type { createNodeSchema } from "../../src/lib/project-node.schema";
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
