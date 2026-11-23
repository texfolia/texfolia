import { isOrgAdmin } from "@texfolia/auth/roles";
import type { Db } from "@texfolia/db";
import {
  account,
  member,
  project,
  projectCollaboration,
  projectGit,
  projectNode,
} from "@texfolia/db/schema";
import { projectPaths } from "@texfolia/projects";
import type { ProjectTransaction } from "@texfolia/projects/server";
import { encodeSource } from "@texfolia/storage";
import {
  putSource,
  retireSources,
  type SourceBucket,
} from "@texfolia/storage/server";
import { and, eq, isNull, inArray } from "drizzle-orm";
import * as git from "isomorphic-git";

import { createAuth } from "./auth";
import { gitRemoteSchema, type GitAction, type GitResult } from "./git";
import {
  gitProvider,
  hasRepositoryAccess,
  type GitProvider,
} from "./git-providers";
import { GitRepository, gitHttp, type GitFiles } from "./git-repository.server";
import { lockProject } from "./project-access.server";

export async function gitAccount({
  db,
  userId,
  provider,
}: {
  db: Db;
  userId: string;
  provider: GitProvider;
}) {
  const [linked] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, provider)));
  if (!linked || !hasRepositoryAccess(provider, linked.scope))
    throw new Error(
      `Connect ${gitProvider(provider).label} repository access first.`,
    );
  const token = await createAuth(db).api.getAccessToken({
    body: { accountId: linked.id, userId },
  });
  return token.accessToken;
}

type GitNode = typeof projectNode.$inferSelect;

async function readNodes(tx: ProjectTransaction, projectId: string) {
  return tx
    .select()
    .from(projectNode)
    .where(
      and(eq(projectNode.projectId, projectId), isNull(projectNode.deletedAt)),
    );
}

// Node identity, placement and content version; any change means a concurrent edit.
function nodeVersions(nodes: GitNode[]) {
  return JSON.stringify(
    nodes
      .map((node) => [
        node.id,
        node.parentId,
        node.name,
        node.kind,
        node.objectKey,
        node.updatedAt.getTime(),
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

const readConcurrency = 8;

async function readFiles(bucket: SourceBucket, nodes: GitNode[]) {
  const paths = projectPaths(nodes);
  const files: GitFiles = {};
  const queue = nodes.flatMap((node) => {
    const path = paths.get(node.id);
    return path ? [{ node, path }] : [];
  });
  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { node, path } = next;
      const object = node.objectKey ? await bucket.get(node.objectKey) : null;
      if (node.objectKey && !object)
        throw new Error("Saved project source is missing.");
      files[path] = object
        ? new Uint8Array(await object.arrayBuffer())
        : new Uint8Array();
    }
  }
  await Promise.all(Array.from({ length: readConcurrency }, worker));
  return files;
}

async function requireRemoteManager(
  tx: ProjectTransaction,
  found: { organizationId: string | null; ownerId: string | null },
  userId: string,
) {
  if (found.organizationId) {
    const [membership] = await tx
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          eq(member.userId, userId),
        ),
      );
    if (!membership || !isOrgAdmin(membership.role))
      throw new Error(
        "Only project owners and organization admins can link or unlink a remote.",
      );
  } else if (found.ownerId !== userId)
    throw new Error("Only the project owner can link or unlink a remote.");
}

async function replaceFiles(
  tx: ProjectTransaction,
  bucket: SourceBucket,
  projectId: string,
  files: GitFiles,
  nodes: GitNode[],
) {
  const root = nodes.find(
    (node) => node.parentId === null && node.kind === "folder",
  );
  if (!root) throw new Error("Project root is missing.");
  const paths = projectPaths(nodes);
  const byPath = new Map(
    nodes.flatMap((node) => {
      const path = paths.get(node.id);
      return path ? [[path, node] as const] : [];
    }),
  );
  // Rebuild folders and reuse file IDs so open Yjs rooms retain their identity.
  const removed = nodes.filter(
    (node) =>
      node.id !== root.id &&
      (node.kind === "folder" ||
        !Object.hasOwn(files, paths.get(node.id) ?? "")),
  );
  await retireSources(
    tx,
    projectId,
    removed.map((node) => node.objectKey),
  );
  if (removed.length)
    await tx
      .update(projectNode)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        inArray(
          projectNode.id,
          removed.map((n) => n.id),
        ),
      );
  const parents = new Map([["", root.id]]);
  // Clear sizes before replacement: quota checks see the final tree's growing total.
  await tx
    .update(projectNode)
    .set({ sizeBytes: 0n })
    .where(
      and(
        eq(projectNode.projectId, projectId),
        isNull(projectNode.deletedAt),
        inArray(projectNode.kind, ["text", "binary"]),
      ),
    );
  for (const [path, bytes] of Object.entries(files)) {
    const parts = path.split("/");
    const name = parts.pop();
    if (!name) throw new Error("Invalid git file name");
    let prefix = "";
    let parentId = root.id;
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = parents.get(prefix);
      if (existing) {
        parentId = existing;
        continue;
      }
      const id = crypto.randomUUID();
      await tx.insert(projectNode).values({
        id,
        projectId,
        parentId,
        name: part,
        kind: "folder",
        sizeBytes: 0n,
      });
      parents.set(prefix, id);
      parentId = id;
    }
    let kind: "text" | "binary" = "text";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) kind = "binary";
    } catch {
      kind = "binary";
    }
    const stored = await putSource({
      tx,
      bucket,
      projectId,
      content: encodeSource(bytes),
      previousSize: 0n,
      kind,
    });
    const existing = byPath.get(path);
    if (existing && existing.objectKey !== stored.objectKey)
      await retireSources(tx, projectId, [existing.objectKey]);
    const values = { parentId, name, kind, ...stored, updatedAt: new Date() };
    if (existing)
      await tx
        .update(projectNode)
        .set(values)
        .where(eq(projectNode.id, existing.id));
    else
      await tx
        .insert(projectNode)
        .values({ id: crypto.randomUUID(), projectId, ...values });
  }
  await tx
    .update(project)
    .set({ updatedAt: new Date() })
    .where(eq(project.id, projectId));
}

// Status bar branch from the cached row; the full status restores the repository.
// Legacy Texfolia-hosted repositories (no remote) show no branch.
export async function gitBranch({
  db,
  projectId,
  userId,
}: {
  db: Db;
  projectId: string;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    await lockProject({ tx, projectId, userId, access: "read" });
    const [linked] = await tx
      .select({ branch: projectGit.branch, url: projectGit.url })
      .from(projectGit)
      .where(eq(projectGit.projectId, projectId));
    return linked?.url ? linked.branch : null;
  });
}

// Repositories created by the removed "initialize" action have no remote. They can
// still be read, linked to an empty remote (keeping history) or unlinked.
const hostedRepositoryMessage =
  "Texfolia no longer hosts Git repositories. Link an empty repository to push this history, or unlink it.";

export async function runGit({
  db,
  bucket,
  projectId,
  user,
  action,
}: {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  user: { id: string; name: string; email: string };
  action: GitAction;
}): Promise<GitResult> {
  const readOnly = action.kind === "status" || action.kind === "diff";
  const access = readOnly ? "read" : "write";
  const empty = {
    remote: null,
    branch: null,
    branches: [],
    changes: [],
    commits: [],
  };
  let host = "the host";
  try {
    // Short snapshot transaction: no Git host requests while the project row is locked.
    const snapshot = await db.transaction(async (tx) => {
      const found = await lockProject({
        tx,
        projectId,
        userId: user.id,
        access,
      });
      if (action.kind === "link" || action.kind === "unlink")
        await requireRemoteManager(tx, found, user.id);
      if (action.kind === "unlink") {
        await tx.delete(projectGit).where(eq(projectGit.projectId, projectId));
        return null;
      }
      const [linked] = await tx
        .select()
        .from(projectGit)
        .where(eq(projectGit.projectId, projectId));
      if (!linked && readOnly) return null;
      const object = linked ? await bucket.get(linked.objectKey) : null;
      if (linked && !object)
        throw new Error("Saved git repository is missing.");
      const nodes = await readNodes(tx, projectId);
      return {
        linked,
        saved: object ? await object.text() : null,
        nodes,
        files: await readFiles(bucket, nodes),
      };
    });
    if (!snapshot) return { status: empty };
    const { linked, saved, nodes, files } = snapshot;
    const connecting = action.kind === "link" || action.kind === "import";
    if (connecting && linked?.url)
      throw new Error(
        "Unlink the current repository before connecting another.",
      );
    if (!connecting && !linked?.url && !readOnly)
      throw new Error(
        linked
          ? hostedRepositoryMessage
          : "Link a repository first, or import one as a new project.",
      );
    const remote = connecting
      ? action.remote
      : linked?.url
        ? gitRemoteSchema.parse(linked.url)
        : null;
    if (remote) host = gitProvider(remote.provider).label;
    const repo = saved ? GitRepository.restore(saved) : new GitRepository();
    let http: git.HttpClient | undefined;
    if (
      remote &&
      (connecting ||
        action.kind === "push" ||
        action.kind === "pull" ||
        (action.kind === "checkout" &&
          !(await repo.hasLocalBranch(action.name))) ||
        action.kind === "fetch")
    )
      http = gitHttp(
        remote.url,
        await gitAccount({ db, userId: user.id, provider: remote.provider }),
        gitProvider(remote.provider).tokenUsername,
      );
    if (connecting && http && remote) {
      if (action.kind === "import") await repo.clone(remote.url, http);
      else await repo.requireEmptyRemote(remote.url, http);
    }
    if (action.kind !== "import") repo.overlay(files);
    const author = { name: user.name || "Texfolia user", email: user.email };
    switch (action.kind) {
      case "fetch":
        if (http && remote) await repo.remoteBranches(http, remote.url);
        break;
      case "commit":
        await repo.commit(action.message, author);
        break;
      case "push":
        if (http) await repo.push(http);
        break;
      case "pull":
        if (http) await repo.pull(http, author);
        break;
      case "branch":
        await repo.branch(action.name);
        break;
      case "checkout":
        await repo.checkout(action.name, http);
        break;
    }
    const replacing =
      action.kind === "import" ||
      action.kind === "pull" ||
      action.kind === "checkout";
    if (!readOnly)
      // Short commit transaction: apply only if nothing changed since the snapshot.
      await db.transaction(async (tx) => {
        const found = await lockProject({
          tx,
          projectId,
          userId: user.id,
          access,
        });
        if (action.kind === "link")
          await requireRemoteManager(tx, found, user.id);
        const [current] = await tx
          .select()
          .from(projectGit)
          .where(eq(projectGit.projectId, projectId));
        const latest = replacing ? await readNodes(tx, projectId) : [];
        if (
          current?.objectKey !== linked?.objectKey ||
          (replacing && nodeVersions(latest) !== nodeVersions(nodes))
        )
          throw new Error(
            "The project changed while Git was syncing. Nothing was applied; try again.",
          );
        if (replacing)
          await replaceFiles(tx, bucket, projectId, repo.sources(), latest);
        // Written under the lock so garbage collection can't remove it first.
        const objectKey = `git/${projectId}/${crypto.randomUUID()}.json`;
        await bucket.put(objectKey, repo.serialize());
        const values = {
          provider: remote?.provider ?? null,
          url: remote?.url ?? null,
          objectKey,
          branch: await repo.currentBranch(),
        };
        await tx
          .insert(projectGit)
          .values({ projectId, ...values })
          .onConflictDoUpdate({ target: projectGit.projectId, set: values });
        await tx
          .insert(projectCollaboration)
          .values({ projectId })
          .onConflictDoNothing();
      });
    const status = await repo.status();
    if (readOnly && linked && linked.branch !== status.branch)
      // Backfill rows saved before the branch was cached.
      await db
        .update(projectGit)
        .set({ branch: status.branch })
        .where(
          and(
            eq(projectGit.projectId, projectId),
            eq(projectGit.objectKey, linked.objectKey),
          ),
        );
    return {
      status: { remote, ...status },
      ...(action.kind === "diff" ? { diff: await repo.diff() } : {}),
    };
  } catch (error) {
    if (error instanceof git.Errors.MergeConflictError)
      throw new Error(
        `Pull has conflicts in: ${error.data.filepaths.join(", ")}. Your working tree is unchanged. Resolve the merge on ${host}, then pull again.`,
      );
    if (error instanceof git.Errors.PushRejectedError)
      throw new Error(
        "Push rejected because the remote branch changed. Pull before pushing again.",
      );
    throw error;
  }
}

export async function collectGitObjects({
  db,
  bucket,
}: {
  db: Db;
  bucket: SourceBucket;
}) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "git/", cursor, limit: 100 });
    const ids = new Set(
      page.objects.flatMap((object) => {
        const id = /^git\/([0-9a-f-]{36})\//.exec(object.key)?.[1];
        return id ? [id] : [];
      }),
    );
    for (const projectId of ids)
      await db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(project)
          .where(eq(project.id, projectId))
          .for("update");
        const [linked] =
          found && !found.deletedAt
            ? await tx
                .select()
                .from(projectGit)
                .where(eq(projectGit.projectId, projectId))
            : [];
        const garbage = page.objects.filter(
          (object) =>
            object.key.startsWith(`git/${projectId}/`) &&
            object.key !== linked?.objectKey,
        );
        if (garbage.length)
          await bucket.delete(garbage.map((object) => object.key));
      });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
