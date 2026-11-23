import { toolDefinition } from "@tanstack/ai";
import type { Db } from "@texfolia/db";
import { user as userTable } from "@texfolia/db/schema";
import {
  projectNodePaths,
  projectPaths,
  searchProject,
} from "@texfolia/projects";
import { encodeSource } from "@texfolia/storage";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { createAuth } from "../auth";
import { handleCompileGet, handleCompilePost } from "../compile-route.server";
import { parseCompileLog } from "../compile/compile-log";
import { gitBranchSchema } from "../git";
import { lockProject } from "../project-access.server";
import { createProjectNode, renameProjectNode } from "../project-node.server";
import { deleteProjectNode } from "../project-source.server";
import { aiEntitlement } from "./billing.server";
import { isAgentsFile, parseSkill, skillFolderName } from "./skills";

/** Tools that change project state; offered only to collaborators who can edit. */
export const writeToolNames = new Set([
  "git_commit",
  "git_push",
  "git_pull",
  "git_create_branch",
  "git_checkout",
  "edit_file",
  "create_file",
  "rename_file",
  "delete_file",
  "compile",
]);

const maxEditBytes = 64 * 1024;
const maxSearchFileBytes = 1024n * 1024n;
const pathSchema = z.string().min(1).max(1024);
const maxSkills = 100;

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
  /** Every live node, folders included, with paths keyed by node ID. */
  async function tree() {
    signal.throwIfAborted();
    await aiEntitlement(db, userId);
    return db.transaction(async (tx) => {
      await lockProject({ tx, projectId, userId, access: "read" });
      const nodes = await tx.query.projectNode.findMany({
        where: { projectId, deletedAt: { isNull: true } },
      });
      return { nodes, paths: projectNodePaths(nodes) };
    });
  }
  function findPath(
    { nodes, paths }: Awaited<ReturnType<typeof tree>>,
    path: string,
  ) {
    const node = nodes.find((n) => n.parentId && paths.get(n.id) === path);
    if (!node) throw new Error("File or folder not found");
    return node;
  }
  /** Resolves a path's parent folder, creating missing folders on the way. */
  async function parentFolder(
    { nodes }: Awaited<ReturnType<typeof tree>>,
    path: string,
  ) {
    const segments = path.split("/");
    const name = segments.pop() ?? "";
    let parent = nodes.find((n) => n.parentId === null && n.kind === "folder");
    if (!parent) throw new Error("Project root not found");
    for (const segment of segments) {
      const parentId: string = parent.id;
      const existing = nodes.find(
        (n) =>
          n.parentId === parentId &&
          n.name.toLowerCase() === segment.toLowerCase(),
      );
      if (existing && existing.kind !== "folder")
        throw new Error(`${segment} is a file, not a folder`);
      if (existing) {
        parent = existing;
        continue;
      }
      signal.throwIfAborted();
      const created = await createProjectNode({
        db,
        ownerId: userId,
        data: {
          id: crypto.randomUUID(),
          projectId,
          parentId,
          name: segment,
          kind: "folder",
        },
      });
      parent = { ...parent, id: created.id, parentId, name: segment };
      nodes.push(parent);
    }
    return { parentId: parent.id, name };
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
      if (node.sizeBytes > BigInt(maxEditBytes))
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
      inputSchema: z.object({ path: pathSchema }),
    }).server(async ({ path }) => {
      const { node, content } = await readFile(path);
      return { path, content, version: node.objectKey };
    }),
    toolDefinition({
      name: "list_skills",
      description:
        "List the project's agent skills (.agents/skills/<name>/SKILL.md) by name and description, and the paths of any AGENTS.md files. Returns no file bodies; read a skill or AGENTS.md with read_file when it is relevant to the user's request.",
      inputSchema: z.object({}),
    }).server(async () => {
      const nodes = await files();
      const entries = nodes
        .filter((n) => n.kind === "text" && skillFolderName(n.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      const skills = await Promise.all(
        entries.slice(0, maxSkills).map(async (node) => {
          if (node.sizeBytes > BigInt(maxEditBytes))
            return {
              ...parseSkill(node.path, ""),
              problems: ["SKILL.md exceeds the assistant's 64 KiB read limit."],
            };
          const object = node.objectKey
            ? await env.SOURCES.get(node.objectKey)
            : null;
          return parseSkill(node.path, object ? await object.text() : "");
        }),
      );
      return {
        // Shallowest first: a nested AGENTS.md applies only to its folder.
        agentsFiles: nodes
          .filter((n) => n.kind === "text" && isAgentsFile(n.path))
          .map((n) => n.path)
          .sort(
            (a, b) =>
              a.split("/").length - b.split("/").length || a.localeCompare(b),
          ),
        skills,
        truncated: entries.length > maxSkills,
      };
    }),
    toolDefinition({
      name: "search_project",
      description:
        "Find literal text across the project's saved text files. Returns matching lines with their paths and line numbers; use it to locate passages instead of reading every file.",
      inputSchema: z.object({
        query: z.string().min(1).max(1000),
        matchCase: z.boolean().optional(),
      }),
    }).server(async ({ query, matchCase }) => {
      const nodes = await files();
      const skipped: string[] = [];
      const sources = await Promise.all(
        nodes.flatMap((node) => {
          if (node.kind !== "text") return [];
          if (node.sizeBytes > maxSearchFileBytes) {
            skipped.push(node.path);
            return [];
          }
          return [
            (async (): Promise<[string, string]> => {
              const object = node.objectKey
                ? await env.SOURCES.get(node.objectKey)
                : null;
              return [node.path, object ? await object.text() : ""];
            })(),
          ];
        }),
      );
      const result = searchProject(sources, query, { matchCase, limit: 200 });
      return {
        matches: result.files.flatMap((file) =>
          file.matches.map(({ path, line, column, preview }) => ({
            path,
            line,
            column,
            preview,
          })),
        ),
        total: result.total,
        truncated: result.truncated,
        skipped,
      };
    }),
    toolDefinition({
      name: "edit_file",
      description:
        "Apply one or more replacements to a file in a single save. Each oldText must match exactly once in the file as last read, and replacements must not overlap. Requires the version from read_file. Edits are saved and shared with collaborators immediately.",
      inputSchema: z.object({
        path: pathSchema,
        version: z.string().nullable(),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).max(maxEditBytes),
              newText: z.string().max(maxEditBytes),
            }),
          )
          .min(1)
          .max(50),
      }),
    }).server(async ({ path, version, edits }) => {
      const { node, content } = await readFile(path);
      if (node.objectKey !== version)
        throw new Error("File changed. Read it again before editing.");
      const ranges = edits
        .map(({ oldText, newText }, index) => {
          const from = content.indexOf(oldText);
          if (from < 0 || content.indexOf(oldText, from + oldText.length) >= 0)
            throw new Error(
              `Edit ${index + 1}: oldText must match exactly once. Read the file and choose a unique passage.`,
            );
          return { from, to: from + oldText.length, newText, index };
        })
        .sort((a, b) => a.from - b.from);
      let updated = "";
      let cursor = 0;
      for (const range of ranges) {
        if (range.from < cursor)
          throw new Error(
            `Edit ${range.index + 1} overlaps another edit. Combine them into one.`,
          );
        updated += content.slice(cursor, range.from) + range.newText;
        cursor = range.to;
      }
      updated += content.slice(cursor);
      if (new TextEncoder().encode(updated).byteLength > maxEditBytes)
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
      name: "create_file",
      description:
        "Create a text file, and any missing folders on its path. Fails if the path already exists. The file is saved and shared with collaborators immediately.",
      inputSchema: z.object({
        path: pathSchema,
        content: z.string().max(maxEditBytes).default(""),
      }),
    }).server(async ({ path, content }) => {
      const project = await tree();
      if (
        [...project.paths.values()].some(
          (other) => other.toLowerCase() === path.toLowerCase(),
        )
      )
        throw new Error("A file or folder already exists at this path.");
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > maxEditBytes)
        throw new Error("File exceeds 64 KiB");
      const { parentId, name } = await parentFolder(project, path);
      signal.throwIfAborted();
      const created = await createProjectNode({
        db,
        ownerId: userId,
        bucket: env.SOURCES,
        data: {
          id: crypto.randomUUID(),
          projectId,
          parentId,
          name,
          kind: "text",
          content: encodeSource(bytes),
        },
      });
      return { path, version: created.sourceVersion.objectKey, created: true };
    }),
    toolDefinition({
      name: "rename_file",
      description:
        "Rename or move a file or folder to a new path, creating missing destination folders. Update LaTeX references to it separately.",
      inputSchema: z.object({ path: pathSchema, newPath: pathSchema }),
    }).server(async ({ path, newPath }) => {
      const project = await tree();
      const node = findPath(project, path);
      const { parentId, name } = await parentFolder(project, newPath);
      signal.throwIfAborted();
      await renameProjectNode({
        db,
        userId,
        data: { projectId, nodeId: node.id, parentId, name },
      });
      return { path, newPath, renamed: true };
    }),
    toolDefinition({
      name: "delete_file",
      description:
        "Delete a file, or a folder and everything in it. Only when the user explicitly asks to delete it.",
      inputSchema: z.object({ path: pathSchema }),
    }).server(async ({ path }) => {
      const node = findPath(await tree(), path);
      signal.throwIfAborted();
      await deleteProjectNode({
        db,
        userId,
        projectId,
        nodeId: node.id,
        collaboration: env.COLLABORATION,
      });
      return { path, deleted: true };
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
