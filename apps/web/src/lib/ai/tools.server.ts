import { toolDefinition } from "@tanstack/ai";
import type { Db } from "@texfolia/db";
import { user as userTable } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { createAuth } from "../auth";
import { handleCompileGet, handleCompilePost } from "../compile-route.server";
import { gitBranchSchema } from "../git";
import { parseCompileLog } from "../latex/compile-log";
import { lockProject } from "../project-access.server";
import { projectPaths } from "../project-paths";
import { encodeSource } from "../project-source";
import { aiEntitlement } from "./billing.server";

/** Tools that change project state; offered only to collaborators who can edit. */
export const writeToolNames = new Set([
  "git_commit",
  "git_push",
  "git_pull",
  "git_create_branch",
  "git_checkout",
  "edit_file",
  "compile",
]);

export function projectTools({
  db,
  auth,
  env,
  projectId,
  userId,
  canWrite,
  headers,
  signal,
}: {
  db: Db;
  auth: ReturnType<typeof createAuth>;
  env: Env;
  projectId: string;
  userId: string;
  canWrite: boolean;
  headers: Headers;
  signal: AbortSignal;
}) {
  async function files() {
    signal.throwIfAborted();
    await aiEntitlement(db, userId);
    return db.transaction(async (tx) => {
      await lockProject({ tx, projectId, userId, access: "read" });
      const nodes = await tx.query.projectNode.findMany({
        where: { projectId, deletedAt: { isNull: true } },
      });
      const paths = projectPaths(nodes);
      return nodes.flatMap((node) => {
        const path = paths.get(node.id);
        return path ? [{ ...node, path }] : [];
      });
    });
  }
  async function readFile(path: string) {
    signal.throwIfAborted();
    await aiEntitlement(db, userId);
    return db.transaction(async (tx) => {
      await lockProject({ tx, projectId, userId, access: "read" });
      const nodes = await tx.query.projectNode.findMany({
        where: { projectId, deletedAt: { isNull: true } },
      });
      const paths = projectPaths(nodes);
      const node = nodes.find(
        (n) => paths.get(n.id) === path && n.kind === "text",
      );
      if (!node) throw new Error("Text file not found");
      if (node.sizeBytes > 64n * 1024n)
        throw new Error("File exceeds the assistant's 64 KiB read limit");
      const object = node.objectKey
        ? await env.SOURCES.get(node.objectKey)
        : null;
      if (node.objectKey && !object) throw new Error("Saved source is missing");
      const content = object ? await object.text() : "";
      return { node, content };
    });
  }
  async function gitAction(action: import("../git").GitAction) {
    signal.throwIfAborted();
    await aiEntitlement(db, userId);
    const [user] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, userId));
    if (!user) throw new Error("Sign in again.");
    const result = await env.COLLABORATION.getByName(projectId).gitAction({
      projectId,
      user: { id: userId, name: user.name, email: user.email },
      action,
    });
    return { status: result.status, diff: result.diff };
  }
  const tools = [
    toolDefinition({
      name: "git_status",
      description:
        "Read the current git branch, changed files, branches, and recent commits.",
      inputSchema: z.object({}),
    }).server(() => gitAction({ kind: "status" })),
    toolDefinition({
      name: "git_diff",
      description:
        "Read the saved working tree diff before suggesting or making a commit.",
      inputSchema: z.object({}),
    }).server(() => gitAction({ kind: "diff" })),
    toolDefinition({
      name: "git_commit",
      description:
        "Commit all non-ignored working tree changes with a message. Only when the user explicitly asks to commit.",
      inputSchema: z.object({ message: z.string().trim().min(1).max(5000) }),
    }).server(({ message }) => gitAction({ kind: "commit", message })),
    toolDefinition({
      name: "git_push",
      description:
        "Push the current branch to the linked remote. Only when the user explicitly asks to push.",
      inputSchema: z.object({}),
    }).server(() => gitAction({ kind: "push" })),
    toolDefinition({
      name: "git_pull",
      description:
        "Pull the current branch. Requires a clean working tree. Only when the user explicitly asks to pull.",
      inputSchema: z.object({}),
    }).server(() => gitAction({ kind: "pull" })),
    toolDefinition({
      name: "git_create_branch",
      description:
        "Create a branch from the current commit. Only when the user explicitly asks.",
      inputSchema: z.object({ name: gitBranchSchema }),
    }).server(({ name }) => gitAction({ kind: "branch", name })),
    toolDefinition({
      name: "git_checkout",
      description:
        "Switch to a local or remote branch. Requires a clean working tree. Only when the user explicitly asks.",
      inputSchema: z.object({ name: gitBranchSchema }),
    }).server(({ name }) => gitAction({ kind: "checkout", name })),
    toolDefinition({
      name: "list_files",
      description: "List the project's saved source files.",
      inputSchema: z.object({}),
    }).server(async () =>
      (await files()).map((n) => ({
        path: n.path,
        kind: n.kind,
        bytes: Number(n.sizeBytes),
      })),
    ),
    toolDefinition({
      name: "read_file",
      description:
        "Read a saved text file before editing. Returns a version for conflict detection.",
      inputSchema: z.object({ path: z.string().min(1).max(1024) }),
    }).server(async ({ path }) => {
      const { node, content } = await readFile(path);
      return { path, content, version: node.objectKey };
    }),
    toolDefinition({
      name: "edit_file",
      description:
        "Replace one exact text occurrence in a file. Requires the version from read_file. Edits are saved and shared with collaborators immediately.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024),
        version: z.string().nullable(),
        oldText: z
          .string()
          .min(1)
          .max(64 * 1024),
        newText: z.string().max(64 * 1024),
      }),
    }).server(async ({ path, version, oldText, newText }) => {
      const { node, content } = await readFile(path);
      if (node.objectKey !== version)
        throw new Error("File changed. Read it again before editing.");
      const first = content.indexOf(oldText);
      if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0)
        throw new Error(
          "oldText must match exactly once. Read the file and choose a unique passage.",
        );
      const updated =
        content.slice(0, first) +
        newText +
        content.slice(first + oldText.length);
      if (new TextEncoder().encode(updated).byteLength > 64 * 1024)
        throw new Error("Edited file exceeds 64 KiB");
      signal.throwIfAborted();
      const saved = await env.COLLABORATION.getByName(projectId).saveSource({
        userId,
        name: "Texfolia assistant",
        data: {
          projectId,
          nodeId: node.id,
          expectedObjectKey: version,
          content: encodeSource(new TextEncoder().encode(updated)),
        },
      });
      return { path, version: saved.objectKey, saved: true };
    }),
    toolDefinition({
      name: "compile",
      description:
        "Compile saved project sources. Returns a job ID; use read_compile_logs to read its status and diagnostics.",
      inputSchema: z.object({ mainFile: z.string().min(1).max(1024) }),
    }).server(async ({ mainFile }) => {
      await files();
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Content-Type", "application/json");
      // Without editor metadata, the route snapshots every saved source under lock.
      requestHeaders.delete("X-Source-Metadata");
      const response = await handleCompilePost({
        request: new Request(`https://internal/api/compile/${projectId}`, {
          method: "POST",
          headers: requestHeaders,
          signal,
          body: JSON.stringify({
            mainFile,
            baseRevision: 0,
            revision: 1,
            files: {},
            deleted: [],
          }),
        }),
        params: { projectId },
        context: { db, auth },
      });
      const result: unknown = await response.json();
      if (!response.ok)
        throw new Error("Compile submission failed: " + JSON.stringify(result));
      return result;
    }),
    toolDefinition({
      name: "read_compile_logs",
      description:
        "Read a project's compilation status, log, and parsed LaTeX diagnostics.",
      inputSchema: z.object({
        jobId: z.uuid(),
        mainFile: z.string().min(1).max(1024),
      }),
    }).server(async ({ jobId, mainFile }) => {
      const nodes = await files();
      const response = await handleCompileGet({
        request: new Request(
          `https://internal/api/compile/${projectId}?job=${jobId}`,
          { headers, signal },
        ),
        params: { projectId },
        context: { db, auth },
      });
      if (!response.ok) throw new Error("Compile job not found");
      const result = z
        .looseObject({
          status: z.string(),
          log: z.string().optional(),
          error: z.string().optional(),
        })
        .parse(await response.json());
      const log = (result.log ?? "").slice(-48 * 1024);
      return {
        jobId,
        status: result.status,
        error: result.error,
        log,
        diagnostics: parseCompileLog(
          log,
          nodes.map((n) => n.path),
          mainFile,
        ).slice(0, 100),
      };
    }),
  ];
  return canWrite
    ? tools
    : tools.filter((tool) => !writeToolNames.has(tool.name));
}
